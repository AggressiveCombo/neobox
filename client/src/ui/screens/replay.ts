// Replay viewer: open a .nbreplay file (picker or drop; gzip or plain JSON),
// then play it back with the engine's replay frames. Keys: Space play/pause,
// , and . step one tick, arrows jump 5 s, Esc closes.

import type { ScreenFactory, ScreenHandle } from "../../ctx";
import type { Engine, ReplayInfo } from "../../engine";
import { FrameLoop } from "../../local-loop";
import type { Screen } from "../../state";
import { h } from "../dom";

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

/** m:ss.t */
function clock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export const replayScreen: ScreenFactory = (ctx) => {
  const root = h("div", { class: "screen offline" });
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
  let speedBtns: HTMLButtonElement[] = [];
  // Picker-view status line (rebuilt by showPicker).
  let pickerMsg: HTMLElement | null = null;

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

  /** Stop the loop and release the loaded replay (idempotent). */
  function unload(): void {
    loop.stop();
    if (info) engine?.replayClose();
    info = null;
    playing = false;
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
    if (playBtn) playBtn.textContent = playing ? "Pause" : "Play";
    speedBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(SPEEDS[i] === speed)));
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

  async function openFile(file: File): Promise<void> {
    if (pickerMsg) pickerMsg.textContent = `Opening ${file.name}…`;
    pickerMsg?.classList.remove("offline-error");
    let eng: Engine;
    let text: string;
    try {
      eng = await ctx.engine();
      text = await readReplayText(file);
    } catch (err) {
      if (!destroyed) showPicker(`Could not read ${file.name}: ${errText(err)}`);
      return;
    }
    if (destroyed) return;
    let loaded: ReplayInfo;
    try {
      loaded = eng.replayLoad(text);
    } catch (err) {
      showPicker(`${file.name} is not a valid replay: ${errText(err)}`);
      return;
    }
    if (loaded.end <= loaded.first) {
      eng.replayClose();
      showPicker(`${file.name} has no frames.`);
      return;
    }
    engine = eng;
    info = loaded;
    names = new Map(loaded.names);
    fileName = file.name;
    tick = loaded.first;
    playing = false;
    speed = 1;
    follow = loaded.players[0]?.[0] ?? -1;
    showPlaying();
    loop.start();
  }

  /** The file picker and drop zone (no replay loaded). */
  function showPicker(message = ""): void {
    unload();
    root.className = "screen offline";

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
        class: "offline-drop",
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
      h("strong", null, "Choose a .nbreplay file"),
      h("span", null, "or drop it here"),
    );
    pickerMsg = h("p", { class: message ? "offline-error" : "status" }, message);

    root.replaceChildren(
      h(
        "section",
        { class: "panel" },
        h("h1", { class: "wordmark" }, "Replay"),
        h("p", { class: "credit" }, "Watch a replay saved from an online match. Nothing is sent to the server."),
        drop,
        pickerMsg,
        h("div", { class: "actions" }, h("button", { type: "button", onclick: leave }, "Back")),
      ),
    );
  }

  /** The playback view: close and follow selector on top, transport and seek bar below. */
  function showPlaying(): void {
    if (!info) return;
    const loaded = info;
    root.className = "offline playing";

    playBtn = h("button", { type: "button", class: "primary", onclick: togglePlay }, "Play");
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
    timeEl = h("span", { class: "offline-time" }, timeText());

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

    const stepBtn = (label: string, onclick: () => void): HTMLButtonElement =>
      h("button", { type: "button", onclick }, label);
    speedBtns = SPEEDS.map((s) =>
      h("button", { type: "button", "aria-pressed": "false", onclick: () => setSpeed(s) }, `${s}x`),
    );

    root.replaceChildren(
      h(
        "div",
        { class: "offline-top offline-overlay" },
        h("button", { type: "button", onclick: leave }, "Close"),
        h("span", { class: "offline-title" }, fileName),
        followSel,
      ),
      h(
        "div",
        { class: "offline-dock offline-overlay" },
        h("div", { class: "offline-seek" }, playBtn, seekEl, timeEl),
        h(
          "div",
          { class: "offline-row" },
          h(
            "div",
            { class: "offline-group", role: "group", "aria-label": "Jump and step" },
            stepBtn("-5s", () => jump(-JUMP_SECONDS)),
            stepBtn("‹ tick", () => step(-1)),
            stepBtn("tick ›", () => step(1)),
            stepBtn("+5s", () => jump(JUMP_SECONDS)),
          ),
          h("div", { class: "offline-group", role: "group", "aria-label": "Speed" }, ...speedBtns),
        ),
      ),
    );
    syncControls();
  }

  showPicker();

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
      root.remove();
    },
  } satisfies ScreenHandle;
};
