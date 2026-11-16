// Replay viewer: open a .nbreplay file (picker or drop; gzip or plain JSON),
// then play it back with the engine's replay frames. Keys: Space play/pause,
// , and . step one tick, arrows jump 5 s, Esc closes.

import type { ScreenFactory, ScreenHandle } from "../../ctx";
import type { Engine, ReplayInfo } from "../../engine";
import { FrameLoop } from "../../local-loop";
import type { Screen } from "../../state";
import { h } from "../dom";
import { engineStatus } from "../engine-status";
import { icon, type IconName } from "../icons";
import { page, pageHead, seg } from "../kit";
import "./replay.css";

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const JUMP_SECONDS = 5;
/** Largest wall-clock step applied per frame, so a background tab does not skip the replay. */
const MAX_FRAME_MS = 250;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Decompressed replay JSON text from a gzip-compressed or plain file. */
export async function readReplayText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

/** Replay text a clip hands to the next replay screen mount (see `queueReplay`). */
let pendingReplay: { name: string; text: string } | null = null;

/** Hand replay text to the replay screen, which opens it as soon as it mounts. */
export function queueReplay(name: string, text: string): void {
  pendingReplay = { name, text };
}

/** m:ss.t */
function clock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export const replayScreen: ScreenFactory = (ctx) => {
  const root = h("div", { class: "offline" });
  let origin: Screen = "menu";
  let originKnown = false;
  let destroyed = false;

  let engine: Engine | null = null;
  let info: ReplayInfo | null = null;
  let names: ReadonlyMap<number, string> = new Map();
  let fileName = "";
  let tick = 0;
  let playing = false;
  let speed = 1;
  let follow = -1;
  let dragging = false;

  // Playing-view controls (rebuilt by showPlaying).
  let playBtn: HTMLButtonElement | null = null;
  let seekEl: HTMLInputElement | null = null;
  let timeEl: HTMLElement | null = null;
  let speedSeg: { set(v: string): void } | null = null;
  // Picker-view status line (rebuilt by showPicker).
  let pickerMsg: HTMLElement | null = null;
  /** A replay whose open waited on a failed engine; it opens once the engine recovers. */
  let resumeOnReady: { name: string; text: string } | null = null;

  const loop = new FrameLoop(
    (dt) => frame(dt),
    (err) => showPicker(`The replay stopped: ${errText(err)}`),
  );

  /** Where Close and Back return to; room and browse only when still valid. */
  function resolveOrigin(): Screen {
    const s = ctx.store.state;
    if (origin === "room" && s.room) return "room";
    if (origin === "browse" && s.serverName) return "browse";
    if (origin === "about") return "about";
    return "menu";
  }

  function leave(): void {
    ctx.store.set({ screen: resolveOrigin() });
  }

  let releaseTop: (() => void) | null = null;

  /** Stop the loop and release the loaded replay (idempotent). */
  function unload(): void {
    loop.stop();
    if (info) engine?.replayClose();
    info = null;
    playing = false;
    releaseTop?.();
    releaseTop = null;
  }

  function timeText(): string {
    if (!info) return "";
    const hz = info.hz;
    return `${clock((tick - info.first) / hz)} / ${clock((info.end - info.first) / hz)}  ·  tick ${Math.floor(tick)}`;
  }

  function seek(t: number): void {
    if (!info) return;
    tick = Math.min(info.end, Math.max(info.first, t));
  }

  function step(dir: 1 | -1): void {
    if (!info) return;
    playing = false;
    seek(dir > 0 ? Math.floor(tick) + 1 : Math.ceil(tick) - 1);
    syncControls();
  }

  function jump(seconds: number): void {
    if (!info) return;
    seek(tick + seconds * info.hz);
  }

  function togglePlay(): void {
    if (!info) return;
    if (!playing && tick >= info.end) seek(info.first);
    playing = !playing;
    syncControls();
  }

  function setSpeed(s: number): void {
    speed = s;
    syncControls();
  }

  function syncControls(): void {
    if (playBtn) playBtn.replaceChildren(icon(playing ? "pause" : "play", 20), playing ? "Pause" : "Play");
    speedSeg?.set(String(speed));
  }

  /** One rendered frame: advance the clock while playing, then draw. */
  function frame(dt: number): void {
    if (!engine || !info) return;
    if (playing) {
      tick += (Math.min(dt, MAX_FRAME_MS) / 1000) * info.hz * speed;
      if (tick >= info.end) {
        tick = info.end;
        playing = false;
        syncControls();
      }
    }
    engine.replayFrame(tick, follow);
    ctx.present(names, info.hz);
    if (seekEl && !dragging) seekEl.value = String(Math.round(tick));
    if (timeEl) timeEl.textContent = timeText();
  }

  const onKey = (e: KeyboardEvent): void => {
    const typing = e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLInputElement && e.target.type === "text");
    if (typing) return;
    if (!info) return;
    let handled = true;
    switch (e.code) {
      case "Space":
        togglePlay();
        break;
      case "Comma":
        step(-1);
        break;
      case "Period":
        step(1);
        break;
      case "ArrowLeft":
        jump(-JUMP_SECONDS);
        break;
      case "ArrowRight":
        jump(JUMP_SECONDS);
        break;
      case "Escape":
        leave();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };
  window.addEventListener("keydown", onKey);

  /** Open replay text (a file or a clip) and start playing it at its first frame. */
  async function openText(name: string, text: string): Promise<void> {
    let eng: Engine;
    try {
      eng = await ctx.engine();
    } catch {
      // The engine status line on the picker shows the failure with Retry; this replay resumes on recovery.
      if (!destroyed) {
        resumeOnReady = { name, text };
        showPicker();
      }
      return;
    }
    if (destroyed) return;
    let loaded: ReplayInfo;
    try {
      loaded = eng.replayLoad(text);
    } catch (err) {
      showPicker(`${name} is not a valid replay: ${errText(err)}`);
      return;
    }
    if (loaded.end <= loaded.first) {
      eng.replayClose();
      showPicker(`${name} has no frames.`);
      return;
    }
    engine = eng;
    info = loaded;
    names = new Map(loaded.names);
    fileName = name;
    tick = loaded.first;
    playing = false;
    speed = 1;
    follow = loaded.players[0]?.[0] ?? -1;
    showPlaying();
    loop.start();
  }

  async function openFile(file: File): Promise<void> {
    if (pickerMsg) pickerMsg.textContent = `Opening ${file.name}…`;
    pickerMsg?.classList.remove("offline-error");
    let text: string;
    try {
      text = await readReplayText(file);
    } catch (err) {
      if (!destroyed) showPicker(`Could not read ${file.name}: ${errText(err)}`);
      return;
    }
    await openText(file.name, text);
  }

  /** The file picker and drop zone (no replay loaded). */
  function showPicker(message = ""): void {
    unload();
    root.className = "offline";

    const input: HTMLInputElement = h("input", {
      type: "file",
      accept: ".nbreplay,.json,application/gzip,application/json",
      onchange: () => {
        const file = input.files?.[0];
        input.value = "";
        if (file) void openFile(file);
      },
    });
    const drop: HTMLElement = h(
      "label",
      {
        class: "replay-drop",
        ondragover: (e: Event) => {
          e.preventDefault();
          drop.classList.add("drag-over");
        },
        ondragleave: () => drop.classList.remove("drag-over"),
        ondrop: (e: Event) => {
          e.preventDefault();
          drop.classList.remove("drag-over");
          const file = (e as DragEvent).dataTransfer?.files[0];
          if (file) void openFile(file);
        },
      },
      input,
      h("span", { class: "replay-drop-mark", "aria-hidden": "true" }, icon("upload", 28)),
      h("strong", null, "Choose a .nbreplay file or drop it here"),
      h("span", { class: "replay-drop-hint" }, "Replays saved from online matches, gzip or plain JSON."),
    );
    pickerMsg = h("p", { class: message ? "offline-error" : "offline-status", role: "status" }, message);

    root.replaceChildren(
      page(
        "offline-page",
        pageHead({ title: "Replay", back: leave }),
        h("p", { class: "lead" }, "Watch a replay saved from an online match. Nothing is sent to the server."),
        drop,
        engineMsg.el,
        pickerMsg,
      ),
    );
  }

  /** The playback view: close and follow selector on top, transport and seek bar below. */
  function showPlaying(): void {
    if (!info) return;
    const loaded = info;
    root.className = "offline playing replay-view";

    playBtn = h("button", { type: "button", class: "primary replay-play", onclick: togglePlay }, icon("play", 20), "Play");
    seekEl = h("input", {
      type: "range",
      min: String(loaded.first),
      max: String(loaded.end),
      step: "1",
      value: String(loaded.first),
      "aria-label": "Seek",
      oninput: () => {
        dragging = true;
        if (seekEl) seek(Number(seekEl.value));
      },
      onchange: () => {
        dragging = false;
      },
    });
    timeEl = h("span", { class: "replay-time num" }, timeText());

    const followSel = h(
      "select",
      {
        "aria-label": "Follow player",
        onchange: () => {
          follow = Number(followSel.value);
        },
      },
      h("option", { value: "-1" }, "Free view"),
      ...loaded.players.map(([id]) => h("option", { value: String(id) }, names.get(id) ?? `Player ${id}`)),
    );
    followSel.value = String(follow);

    const stepBtn = (label: string, name: IconName, onclick: () => void): HTMLButtonElement =>
      h("button", { type: "button", class: "replay-step-btn", "aria-label": label, title: label, onclick }, icon(name, 20));
    const speedGroup = seg(
      "Speed",
      SPEEDS.map((s) => ({ value: String(s), label: `${s}x` })),
      String(speed),
      (v) => setSpeed(Number(v)),
    );
    speedSeg = speedGroup;

    const bar = h(
      "header",
      { class: "offline-top offline-overlay" },
      h("button", { type: "button", onclick: leave }, icon("x", 18), "Close"),
      h("h1", { class: "offline-title" }, fileName),
      followSel,
    );
    root.replaceChildren(
      bar,
      h(
        "main",
        { class: "offline-dock offline-overlay replay-dock" },
        h("div", { class: "replay-transport" }, playBtn, seekEl, timeEl),
        h(
          "div",
          { class: "replay-controls" },
          h(
            "div",
            { class: "replay-step", role: "group", "aria-label": "Jump and step" },
            stepBtn("Back 5 s", "rotate-ccw", () => jump(-JUMP_SECONDS)),
            stepBtn("Step back", "step-back", () => step(-1)),
            stepBtn("Step forward", "step-forward", () => step(1)),
            stepBtn("Forward 5 s", "rotate-cw", () => jump(JUMP_SECONDS)),
          ),
          speedGroup.el,
        ),
      ),
    );
    syncControls();
    releaseTop?.();
    releaseTop = ctx.reserveTop(bar);
  }

  // Engine state on the picker; a replay waiting on a failed engine opens once it recovers.
  const engineMsg = engineStatus(() => {
    const r = resumeOnReady;
    resumeOnReady = null;
    if (r && !destroyed) void openText(r.name, r.text);
  });

  const pending = pendingReplay;
  pendingReplay = null;
  showPicker();
  if (pending) void openText(pending.name, pending.text);

  return {
    el: root,
    update(_, prev) {
      if (!originKnown) {
        origin = prev.screen;
        originKnown = true;
      }
    },
    destroy() {
      destroyed = true;
      window.removeEventListener("keydown", onKey);
      unload();
      engineMsg.destroy();
      root.remove();
    },
  } satisfies ScreenHandle;
};
