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
import { createScoreboard, type Scoreboard } from "../scoreboard";
import "./replay.css";

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const JUMP_SECONDS = 5;
/** Largest wall-clock step applied per frame, so a background tab does not skip the replay. */
const MAX_FRAME_MS = 250;
/** Wall-clock budget per idle slice of keyframe building (the pass is about a second of CPU for a 10-minute replay). */
const BUILD_SLICE_MS = 8;

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
  let buildTimer: number | undefined;
  /** The tick the last frame was built for; the readout shows it, so a seek waiting on keyframes keeps the old time. */
  let shownTick = 0;

  // Playing-view controls (rebuilt by showPlaying).
  let playBtn: HTMLButtonElement | null = null;
  let seekEl: HTMLInputElement | null = null;
  let timeNowEl: HTMLElement | null = null;
  let timeTickEl: HTMLElement | null = null;
  let board: Scoreboard | null = null;
  let speedSeg: { set(v: string): void } | null = null;
  // Step and jump buttons by direction; they are disabled where a move would leave the replay (syncSteps).
  let rewindBtns: HTMLButtonElement[] = [];
  let forwardBtns: HTMLButtonElement[] = [];
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

  function stopBuild(): void {
    window.clearTimeout(buildTimer);
    buildTimer = undefined;
  }

  /** Build the loaded replay's seek keyframes in idle slices, starting after the first painted frames so opening does not wait on it. */
  function buildKeyframes(eng: Engine, loaded: ReplayInfo): void {
    let msPerTick = 0;
    let reported = false;
    const slice = (): void => {
      buildTimer = undefined;
      if (info !== loaded) return;
      const ticks = msPerTick > 0 ? Math.max(1, Math.floor(BUILD_SLICE_MS / msPerTick)) : 1;
      const t0 = performance.now();
      const { done, failed } = eng.replayBuildKeyframes(ticks);
      msPerTick = (performance.now() - t0) / ticks;
      if (failed && !reported) {
        reported = true;
        ctx.toast("This replay's seek data didn't match, so seeking is slower");
      }
      if (!done) buildTimer = window.setTimeout(slice, 0);
    };
    requestAnimationFrame(() => requestAnimationFrame(() => (buildTimer = window.setTimeout(slice, 0))));
  }

  /** Stop the loop and release the loaded replay (idempotent). */
  function unload(): void {
    loop.stop();
    stopBuild();
    if (info) engine?.replayClose();
    info = null;
    board = null;
    playing = false;
    releaseTop?.();
    releaseTop = null;
  }

  /** The readout: the position against the total (fixed when the replay opens, see showPlaying), and the tick. */
  function renderTime(): void {
    if (!info || !timeNowEl || !timeTickEl) return;
    timeNowEl.textContent = clock((shownTick - info.first) / info.hz);
    timeTickEl.textContent = `  ·  tick ${shownTick}`;
  }

  function seek(t: number): void {
    if (!info) return;
    tick = Math.min(info.end, Math.max(info.first, t));
    board?.clear();
    syncSteps();
  }

  /** Seek to the pointer's place along the track. The track's first and last pixels map to the replay's start and end (a press at the far end reaches the end, not a tick short of it). */
  function seekAt(e: PointerEvent): void {
    if (!seekEl || !info) return;
    const r = seekEl.getBoundingClientRect();
    if (r.width <= 1) return;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width - 1)));
    seek(Math.round(info.first + f * (info.end - info.first)));
    seekEl.value = String(Math.round(tick));
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

  /** Phones fold the scoreboard and the step and speed controls behind the bar's Scores and the dock's More. The arena's band is refitted to what is open. */
  function togglePanel(panel: "scores" | "more", btn: HTMLElement): void {
    const open = !root.classList.contains(`${panel}-open`);
    root.classList.toggle(`${panel}-open`, open);
    btn.setAttribute("aria-expanded", String(open));
    window.dispatchEvent(new Event("resize"));
  }

  function syncControls(): void {
    if (playBtn) playBtn.replaceChildren(icon(playing ? "pause" : "play", 20), h("span", { class: "replay-play-label" }, playing ? "Pause" : "Play"));
    speedSeg?.set(String(speed));
    syncSteps();
  }

  /** A step or jump past either end does nothing, so its button is disabled there. A playing replay can always move. */
  function syncSteps(): void {
    const atStart = !info || (!playing && tick <= info.first);
    const atEnd = !info || (!playing && tick >= info.end);
    for (const b of rewindBtns) b.disabled = atStart;
    for (const b of forwardBtns) b.disabled = atEnd;
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
    const shown = engine.replayFrame(tick, follow);
    // null: a seek waits for keyframes the worker has not sent yet; the last frame stays on screen.
    if (shown !== null) {
      shownTick = shown;
      const scene = ctx.present(names, info.hz);
      if (scene && board) {
        board.render(scene, names, -1, info.hz);
        board.record(scene, names);
      }
    }
    if (seekEl && !dragging) seekEl.value = String(Math.round(tick));
    renderTime();
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
      // The engine status line on the picker shows the failure with Try again; this replay resumes on recovery.
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
    shownTick = loaded.first;
    playing = false;
    speed = 1;
    follow = loaded.players[0]?.[0] ?? -1;
    showPlaying();
    loop.start();
    buildKeyframes(eng, loaded);
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

  /** The playback view. The bar holds Close, the title, the Scores toggle and the follow selector; the dock is one transport row (play, seek, time, More), and More opens the step and speed controls. Phones fold the scoreboard and those controls; desktop shows both. */
  function showPlaying(): void {
    if (!info) return;
    const loaded = info;
    root.className = "offline playing replay-view";

    playBtn = h("button", { type: "button", class: "primary replay-play", onclick: togglePlay }, icon("play", 20), h("span", { class: "replay-play-label" }, "Play"));
    seekEl = h("input", {
      type: "range",
      min: String(loaded.first),
      max: String(loaded.end),
      step: "1",
      value: String(loaded.first),
      "aria-label": "Seek",
      onpointerdown: (ev: Event) => {
        const e = ev as PointerEvent;
        if (!seekEl || e.button !== 0) return;
        e.preventDefault();
        seekEl.focus();
        seekEl.setPointerCapture(e.pointerId);
        dragging = true;
        seekAt(e);
      },
      onpointermove: (ev: Event) => {
        const e = ev as PointerEvent;
        if (seekEl?.hasPointerCapture(e.pointerId)) seekAt(e);
      },
      onpointerup: () => {
        dragging = false;
      },
      onpointercancel: () => {
        dragging = false;
      },
      oninput: () => {
        dragging = true;
        if (seekEl) seek(Number(seekEl.value));
      },
      onchange: () => {
        dragging = false;
      },
    });
    timeNowEl = h("span", { class: "replay-now" });
    timeTickEl = h("span", { class: "replay-tick" });
    const timeEl = h(
      "span",
      { class: "replay-time num" },
      timeNowEl,
      h("span", { class: "replay-sep" }, " / "),
      h("span", { class: "replay-total" }, clock((loaded.end - loaded.first) / loaded.hz)),
      timeTickEl,
    );
    renderTime();

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

    const stepBtn = (label: string, name: IconName, onclick: () => void, edge?: "start" | "end"): HTMLButtonElement => {
      const b = h("button", { type: "button", class: "replay-step-btn", "aria-label": label, title: label, onclick }, icon(name, 20));
      if (edge === "start") rewindBtns.push(b);
      if (edge === "end") forwardBtns.push(b);
      return b;
    };
    const speedGroup = seg(
      "Speed",
      SPEEDS.map((s) => ({ value: String(s), label: `${s}x` })),
      String(speed),
      (v) => setSpeed(Number(v)),
    );
    speedSeg = speedGroup;

    const scoresBtn = h(
      "button",
      {
        type: "button",
        class: "replay-panel-toggle",
        "aria-controls": "replay-board",
        "aria-expanded": "false",
        onclick: (e: Event) => togglePanel("scores", e.currentTarget as HTMLElement),
      },
      icon("list", 18),
      "Scores",
    );
    const moreBtn = h(
      "button",
      {
        type: "button",
        class: "replay-panel-toggle replay-more",
        "aria-controls": "replay-controls",
        "aria-expanded": "false",
        "aria-label": "More controls",
        title: "More controls",
        onclick: (e: Event) => togglePanel("more", e.currentTarget as HTMLElement),
      },
      icon("ellipsis", 20),
    );

    const bar = h(
      "header",
      { class: "offline-top offline-overlay" },
      h("button", { type: "button", onclick: leave }, icon("x", 18), "Close"),
      h("h1", { class: "offline-title" }, fileName),
      scoresBtn,
      followSel,
    );
    board = createScoreboard();
    rewindBtns = [];
    forwardBtns = [];
    root.replaceChildren(
      h(
        "div",
        { class: "replay-head" },
        bar,
        h("aside", { id: "replay-board", class: "replay-board playfield-clear", "aria-label": "Scoreboard and kill log" }, board.el, board.events),
      ),
      h(
        "main",
        { class: "offline-dock offline-overlay replay-dock playfield-clear" },
        h("div", { class: "replay-transport" }, playBtn, seekEl, timeEl, moreBtn),
        h(
          "div",
          { id: "replay-controls", class: "replay-controls" },
          h(
            "div",
            { class: "replay-step", role: "group", "aria-label": "Jump and step" },
            stepBtn("Back 5 s", "rotate-ccw", () => jump(-JUMP_SECONDS), "start"),
            stepBtn("Step back", "step-back", () => step(-1), "start"),
            stepBtn("Step forward", "step-forward", () => step(1), "end"),
            stepBtn("Forward 5 s", "rotate-cw", () => jump(JUMP_SECONDS), "end"),
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
