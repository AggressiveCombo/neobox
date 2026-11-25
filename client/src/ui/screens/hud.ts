// In-match HUD: touch pad, scoreboard, stats overlay, chat and leave button.
// DOM only; it sits over the render canvases and enables pointer events only on
// interactive elements (see hud.css).

import { applyAccount, errorText, signOutAccount } from "../../account";
import type { AppCtx, HudFactory } from "../../ctx";
import { cycleSpectate, spectatedId } from "../../camera";
import { recordClip } from "../../clips";
import type { Scene } from "../../frame";
import { BIT } from "../../input";
import { filterProfanity } from "../../profanity";
import { TOUCH_SLOTS, prefs, type TouchAction, type TouchSlot } from "../../prefs";
import { MAX_CHAT_LEN, TEAM_BLUE, TEAM_RED, TEAM_SPECTATOR, isTeamMode, type PlayerInfo, type XpAward } from "../../protocol";
import { cssHex, mixRgb, playerRgb, setPlayerColors } from "../../render/geometry";
import { objectiveLabel, objectiveProgress } from "../../render/overlay";
import { CHAT_LIMIT, type AppState, type ChatLine, type Stats } from "../../state";
import { chatPlaceholder } from "../chat-hint";
import { h } from "../dom";
import { icon, type IconName } from "../icons";
import { parseYouTubeId } from "../jukebox";
import { confirmDialog, contrastRatio, openModal } from "../kit";
import { showPhoneSplash } from "../phone-splash";
import { createScoreboard } from "../scoreboard";
import { stickBits, stickOctant } from "../../touch-stick";

const SCORE_INTERVAL_MS = 100;
const CHAT_SHOWN = 8;
/** A player counts as typing this long after their last typing signal. */
const TYPING_MS = 3000;
/** Minimum gap between our own typing signals. */
const TYPING_SEND_MS = 1000;
const TYPING_TICK_MS = 1000;
/** How long the quick-play XP popup stays up. */
const XP_SHOW_MS = 3000;
/** Ping above this turns the connection chip red. */
const BAD_PING_MS = 150;

/** The chat's ground (`--hud-solid`, hud.css). */
const HUD_SOLID = 0x0a0a0a;
/** A player's name colour as text: the palette colour lifted toward white until it reads at 4.5:1 on the chat ground. */
function nameText(rgb: number): number {
  let t = 0;
  while (t < 1 && contrastRatio(mixRgb(rgb, 0xffffff, t), HUD_SOLID) < 4.5) t += 0.02;
  return mixRgb(rgb, 0xffffff, Math.min(t, 1));
}

/** Own chat lines (most recent last), recalled with Up/Down. Kept for the session only. */
const SENT_HISTORY_MAX = 50;
const sentChat: string[] = [];

/** What each touch action looks like and feeds the engine. Settings draws the same icons. */
export const TOUCH_BUTTONS: Record<TouchAction, { bit: number; label: string; icon: IconName }> = {
  up: { bit: BIT.UP, label: "Jump", icon: "move-up" },
  push: { bit: BIT.PUSH, label: "Push", icon: "arrow-right" },
  rocket: { bit: BIT.ROCKET, label: "Rocket", icon: "rocket" },
  bat: { bit: BIT.BAT, label: "Bat", icon: "swords" },
  grab: { bit: BIT.GRAB, label: "Grab", icon: "hand" },
};

/** A touch button in `slot` performing `action`: its name, icon and engine bit follow the action. */
function touchButton(ctx: AppCtx, slot: TouchSlot, action: TouchAction): HTMLButtonElement {
  const spec = TOUCH_BUTTONS[action];
  const btn = h(
    "button",
    { type: "button", class: `hud-touch hud-touch-${slot}`, "data-action": action, "aria-label": spec.label, tabindex: -1 },
    icon(spec.icon, 22),
    h("span", { class: "hud-touch-label" }, spec.label),
  );
  const press = (on: boolean): void => {
    ctx.input.setTouch("buttons", spec.bit, on);
    btn.classList.toggle("hud-on", on);
  };
  btn.addEventListener("pointerdown", (e: PointerEvent) => {
    if (btn.disabled) return;
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    press(true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    btn.addEventListener(type, () => press(false));
  }
  btn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  return btn;
}

/**
 * Movement stick: one thumb anywhere on the pad steers in 8 directions and
 * can slide between them without lifting (the pad itself never moves).
 */
function touchStick(ctx: AppCtx): HTMLElement {
  const knob = h("div", { class: "hud-stick-knob" });
  const pad = h("div", { class: "hud-stick", role: "group", "aria-label": "Movement" }, knob);
  let active: number | null = null;
  let cx = 0;
  let cy = 0;
  let radius = 1;
  let octant = -1;
  const set = (dx: number, dy: number): void => {
    octant = stickOctant(octant, dx, dy, radius);
    const bits = stickBits(octant);
    for (const bit of [BIT.LEFT, BIT.RIGHT, BIT.UP, BIT.DOWN]) ctx.input.setTouch("stick", bit, (bits & bit) !== 0);
    const dist = Math.hypot(dx, dy);
    const k = dist > radius ? radius / dist : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    pad.classList.toggle("hud-on", octant >= 0);
  };
  pad.addEventListener("pointerdown", (e: PointerEvent) => {
    if (active !== null) return;
    e.preventDefault();
    active = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    const r = pad.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    radius = r.width / 2;
    set(e.clientX - cx, e.clientY - cy);
  });
  pad.addEventListener("pointermove", (e: PointerEvent) => {
    if (e.pointerId === active) set(e.clientX - cx, e.clientY - cy);
  });
  const release = (e: PointerEvent): void => {
    if (e.pointerId !== active) return;
    active = null;
    set(0, 0);
  };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    pad.addEventListener(type, release);
  }
  pad.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  pad.addEventListener("contextmenu", (e) => e.preventDefault());
  return pad;
}

/** Phones and tablets: a coarse pointer or any touch point. */
export function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
}

/** Quick play with nobody else playing yet: the HUD's matching notice shows. Room state, not frames, so a slow device still sees it. */
function aloneInQuickMatch(state: AppState): boolean {
  const room = state.room;
  return state.inMatch && room?.quick != null && room.players.filter((p) => p.team !== TEAM_SPECTATOR).length === 1;
}

/** Full screen, then the landscape lock where the browser allows it (Android Chrome). */
export async function goLandscape(): Promise<void> {
  if (document.fullscreenElement === null) {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      return;
    }
  }
  try {
    // `lock` is missing from the TypeScript DOM lib; Android Chrome has it.
    await (screen.orientation as ScreenOrientation & { lock(o: "landscape"): Promise<void> }).lock("landscape");
  } catch {
    // unsupported, or not fullscreen: the phone keeps its orientation
  }
}

// Leaving fullscreen releases the orientation lock.
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === null) screen.orientation?.unlock?.();
});

/**
 * Portrait gate for game screens on touch devices: asks for landscape, offers
 * full screen, and can be dismissed for this screen. It comes back after the
 * phone has been landscape again.
 */
export function rotateGate(): { el: HTMLElement; destroy(): void } {
  const portrait = matchMedia("(orientation: portrait)");
  const coarse = matchMedia("(pointer: coarse)");
  let dismissed = false;
  const sync = (): void => {
    if (!portrait.matches) dismissed = false;
    el.hidden = !(isTouchDevice() && portrait.matches && !dismissed);
  };
  const full = h(
    "button",
    { type: "button", class: "primary", hidden: !document.fullscreenEnabled, onclick: () => void goLandscape() },
    icon("maximize", 18),
    h("span", null, "Full screen"),
  );
  const anyway = h(
    "button",
    {
      type: "button",
      onclick: () => {
        dismissed = true;
        sync();
      },
    },
    icon("play", 18),
    "Play in portrait anyway",
  );
  const el: HTMLElement = h(
    "div",
    { class: "hud-rotate", role: "dialog", "aria-label": "Turn your phone sideways", hidden: true },
    h("div", { class: "hud-rotate-icon", "aria-hidden": "true" }),
    h("h2", null, icon("smartphone", 20), "Turn your phone sideways"),
    h("p", null, "Matches play in landscape. Turn the phone, or go full screen to keep it locked there."),
    h("div", { class: "hud-rotate-actions" }, full, anyway),
  );
  portrait.addEventListener("change", sync);
  coarse.addEventListener("change", sync);
  sync();
  return {
    el,
    destroy() {
      portrait.removeEventListener("change", sync);
      coarse.removeEventListener("change", sync);
      el.remove();
    },
  };
}

/**
 * Movement stick and action buttons, sized and handed by the touch prefs (live).
 * Feeds ctx.input. The offline test-play screens reuse it outside a match.
 */
export function touchControls(ctx: AppCtx): { el: HTMLElement; setLive(on: boolean): void; destroy(): void } {
  const touchCapable = isTouchDevice();
  const actions = h("div", { class: "hud-actions" });
  const el = h("div", { class: "hud-touch-layer", hidden: !touchCapable }, touchStick(ctx), actions);
  let layoutJson = "";
  // The buttons act only while live: the start countdown and spectating leave them off (setLive).
  let live = true;
  const applyLive = (): void => {
    for (const btn of actions.querySelectorAll<HTMLButtonElement>(".hud-touch")) {
      btn.disabled = !live;
      // Let go while held, so the engine does not keep the bit set.
      if (!live && btn.classList.contains("hud-on")) {
        ctx.input.setTouch("buttons", TOUCH_BUTTONS[btn.dataset.action as TouchAction].bit, false);
        btn.classList.remove("hud-on");
      }
    }
  };
  const applyPrefs = (): void => {
    el.style.setProperty("--hud-touch-scale", String(prefs.value.touchScale));
    el.classList.toggle("hud-left-handed", prefs.value.touchLeftHanded);
    const layout = prefs.value.touchLayout;
    const json = JSON.stringify(layout);
    if (json === layoutJson) return;
    layoutJson = json;
    // A held button leaves with its old layout: release the bits it set first.
    ctx.input.clearTouch();
    actions.replaceChildren(...TOUCH_SLOTS.map((slot) => touchButton(ctx, slot, layout[slot])));
    applyLive();
  };
  applyPrefs();
  const unsubscribe = prefs.subscribe(applyPrefs);
  return {
    el,
    setLive(on: boolean) {
      if (on === live) return;
      live = on;
      applyLive();
    },
    destroy() {
      unsubscribe();
      ctx.input.clearTouch();
      el.remove();
    },
  };
}

interface StatRow {
  el: HTMLElement;
  value: HTMLElement;
}

function statRow(label: string): StatRow {
  const value = h("span", { class: "hud-stat-value" });
  const el = h("div", { class: "hud-stat-row" }, h("span", { class: "hud-stat-label" }, label), value);
  return { el, value };
}

export const hudScreen: HudFactory = (ctx) => {
  let latestScene: Scene | null = null;
  let lastScoresAt = -Infinity;
  let chatOpen = false;
  let recall = -1;
  let roomPlayers = new Map<number, PlayerInfo>();
  let roomNames: ReadonlyMap<number, string> = new Map();
  let lastTypingSent = -Infinity;
  let spectating = false;
  let spectateLabel = "";
  let xpTimer: number | undefined;
  let typingLine = "";

  // Phone welcome, once per device: it is about turning the phone for play, so it waits for a match.
  showPhoneSplash();

  // Touch controls. The Chat button sits in the top-right bar (shown on touch devices).
  const touch = touchControls(ctx);
  const chatBtn = h(
    "button",
    { type: "button", class: "hud-chat-btn", "aria-expanded": "false", hidden: !isTouchDevice(), onclick: () => (chatOpen ? closeChat() : openChat()) },
    icon("message-square", 18),
    h("span", { class: "hud-chip-label" }, "Chat"),
  );

  // Spectator: a click on the arena follows the next player. Hidden unless spectating.
  const spectateLayer = h("div", { class: "hud-spectate", hidden: true, onclick: () => spectateStep(1) });
  // The original's spectate bar: previous / followed player / next (also Left and Right).
  const spectateName = h("span", { class: "hud-spectate-name", "aria-live": "polite" });
  const spectateLabelEl = h(
    "div",
    { class: "hud-spectate-label", hidden: true },
    h("button", { type: "button", class: "hud-spectate-prev", "aria-label": "Previous player", onclick: () => spectateStep(-1) }, icon("chevron-right", 22)),
    spectateName,
    h("button", { type: "button", "aria-label": "Next player", onclick: () => spectateStep(1) }, icon("chevron-right", 22)),
  );

  // Stats overlay with a compact FPS & RTT sparkline graph (same width, minimal height).
  const statsRows = {
    transport: statRow("Transport"),
    fps: statRow("FPS"),
    rtt: statRow("RTT"),
    predDepth: statRow("Prediction"),
    rollbacks: statRow("Rollbacks"),
    rollbackP95: statRow("Rollback p95"),
    desync: statRow("Snapshot"),
  };
  statsRows.fps.el.classList.add("is-fps");
  statsRows.rtt.el.classList.add("is-rtt");
  const GRAPH_SAMPLES = 48;
  const fpsHist: number[] = [];
  const rttHist: number[] = [];
  const statsGraph = h("canvas", { class: "hud-stats-graph", width: 190, height: 34, "aria-hidden": "true" });
  const statsGraphCtx = statsGraph.getContext("2d");
  const statsEl = h("div", { class: "hud-stats" }, ...Object.values(statsRows).map((r) => r.el), statsGraph);
  // Connection chip: transport and ping; only its colour changes when the ping is bad.
  const linkKind = h("span", { class: "hud-link-kind" });
  const linkPing = h("span", { class: "hud-link-ping" });
  const linkEl = h("span", { class: "hud-link", title: "Connection" }, icon("wifi", 16), linkKind, linkPing);

  // Scoreboard and kill/hit log (shared with the replay viewer).
  const board = createScoreboard();
  const scoresEl = board.el;

  // Chat.
  const chatLog = h("div", { class: "hud-chat-log", "aria-live": "polite" });
  const typingEl = h("div", { class: "hud-typing", hidden: true });
  const chatInput = h("input", {
    class: "hud-chat-input",
    type: "text",
    maxlength: MAX_CHAT_LEN,
    autocomplete: "off",
    placeholder: chatPlaceholder(),
    "aria-label": "Chat message",
  });
  const chatForm = h("div", { class: "hud-chat-form", hidden: true }, chatInput);
  const topLeftEl = h("div", { class: "hud-topleft" }, statsEl, board.events, chatLog, typingEl, chatForm);

  // Quick-play XP popup, centre screen.
  const xpGain = h("div", { class: "hud-xp-gain" });
  const xpLimit = h("div", { class: "hud-xp-limit" });
  const xpEl = h("div", { class: "hud-xp", hidden: true, role: "status" }, xpGain, xpLimit);
  // Start countdown announcement (polite): each second, then "Go"; visually hidden like the kill log.
  const countdownLive = h("div", { class: "hud-events", role: "status", "aria-live": "polite" });
  /** Whole seconds last announced; -1 outside a countdown. */
  let countdownSecs = -1;

  const leaveBtn = h(
    "button",
    { type: "button", class: "hud-leave", onclick: () => ctx.send({ t: "leave_room" }) },
    icon("log-out", 18),
    h("span", { class: "hud-chip-label" }, "Leave"),
  );
  const connEl = h("div", { class: "hud-conn", role: "status", hidden: true }, "connection lost");
  // Quick play with nobody else in the game yet (the original's matchmaking notification).
  const matchingEl = h(
    "div",
    { class: "hud-matching", role: "status", hidden: true },
    "Waiting for other players to join this arena...",
  );

  // Match menu, the original's in-game menu: the lobby (the match keeps
  // running behind it), fullscreen, volume, menu music, controls, sign out.
  // Leave and End match keep their own buttons.
  const fullscreenLabel = h("span");
  const fullscreenItem = h(
    "button",
    { type: "button", hidden: !document.fullscreenEnabled, onclick: toggleFullscreen },
    icon("maximize", 18),
    fullscreenLabel,
  );
  const muteLabel = h("span");
  const muteItem = h(
    "button",
    { type: "button", onclick: () => prefs.set({ musicMuted: !prefs.value.musicMuted }) },
    icon("volume-2", 18),
    muteLabel,
  );
  const volumeInput = h("input", {
    type: "range",
    min: 0,
    max: 100,
    step: 1,
    oninput: (e: Event) => prefs.set({ volume: Number((e.target as HTMLInputElement).value) / 100 }),
  });
  const isRoomHost = (): boolean => {
    const r = ctx.store.state.room;
    return r !== null && r.quick === null && r.players.some((p) => p.id === ctx.store.state.myId && p.host);
  };

  function openJukeboxModal(): void {
    setMenu(false);
    const input = h("input", {
      type: "url",
      placeholder: "Paste a YouTube link or video ID",
      autocomplete: "off",
      spellcheck: "false",
    });
    const feedback = h("p", { class: "field-hint", role: "status", "aria-live": "polite" });
    const nowPlaying = h("div", { class: "hud-jukebox-now" });
    const suggestionsBox = h("div", { class: "hud-jukebox-suggests" });
    const volSlider = h("input", {
      type: "range",
      min: 0,
      max: 100,
      step: 1,
      value: String(Math.round(prefs.value.jukeboxVolume * 100)),
      oninput: () => prefs.set({ jukeboxVolume: Number(volSlider.value) / 100 }),
    });

    const submitUrl = (): void => {
      const raw = input.value.trim();
      const video = parseYouTubeId(raw);
      if (video === null) {
        feedback.textContent = "Paste a valid YouTube link or 11-character video ID.";
        return;
      }
      if (isRoomHost()) {
        ctx.send({ t: "jukebox", action: "play", video });
        feedback.textContent = "Playing on the room jukebox.";
      } else {
        ctx.send({ t: "chat", text: `https://youtu.be/${video}` });
        feedback.textContent = "Suggested in room chat for the host.";
      }
      input.value = "";
    };

    const form = h(
      "form",
      {
        class: "hud-jukebox-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          submitUrl();
        },
      },
      input,
      h("button", { type: "submit", class: "primary" }, icon("play", 16), isRoomHost() ? "Play" : "Suggest"),
    );

    const refreshModal = (): void => {
      const st = ctx.store.state;
      const host = isRoomHost();
      const jb = st.room?.jukebox ?? null;
      if (jb) {
        const controls: Node[] = [];
        if (host) {
          controls.push(
            h(
              "button",
              {
                type: "button",
                class: "quiet",
                onclick: () => ctx.send({ t: "jukebox", action: jb.playing ? "pause" : "resume" }),
              },
              icon(jb.playing ? "pause" : "play", 16),
              jb.playing ? "Pause" : "Resume",
            ),
            h(
              "button",
              { type: "button", class: "quiet", onclick: () => ctx.send({ t: "jukebox", action: "stop" }) },
              icon("square", 16),
              "Stop",
            ),
          );
        }
        nowPlaying.replaceChildren(
          h("div", { class: "hud-jukebox-track" }, icon("music", 16), h("strong", null, jb.title), h("span", { class: "chip" }, jb.playing ? "Playing" : "Paused")),
          ...(controls.length > 0 ? [h("div", { class: "hud-jukebox-controls" }, ...controls)] : []),
        );
      } else {
        nowPlaying.replaceChildren(h("p", { class: "muted" }, "Nothing playing on the jukebox."));
      }

      const seen = new Set<string>();
      const recent = st.chat
        .filter((l) => l.suggest !== undefined)
        .reverse()
        .filter((l) => {
          const id = l.suggest!.video;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, 6);
      if (recent.length > 0) {
        suggestionsBox.replaceChildren(
          h("p", { class: "field-label" }, "Recent suggestions"),
          ...recent.map((l) =>
            h(
              "div",
              { class: "hud-jukebox-sug-row" },
              h("span", { class: "hud-jukebox-sug-title" }, `${l.suggest!.title} · ${l.name}`),
              host
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "quiet",
                      onclick: () => ctx.send({ t: "jukebox", action: "play", video: l.suggest!.video }),
                    },
                    icon("play", 14),
                    "Play",
                  )
                : null,
            ),
          ),
        );
      } else {
        suggestionsBox.replaceChildren();
      }
    };

    refreshModal();
    const unsub = ctx.store.subscribe(refreshModal);
    const modal = openModal({
      title: "Jukebox",
      body: [
        nowPlaying,
        form,
        feedback,
        h("label", { class: "hud-jukebox-vol" }, icon("volume-2", 16), h("span", null, "Jukebox volume"), volSlider),
        suggestionsBox,
      ],
      actions: [h("button", { type: "button", onclick: () => modal.close() }, icon("x", 18), "Close")],
      onclose: () => unsub(),
    });
    input.focus();
  }

  const jukeboxItem = h(
    "button",
    { type: "button", onclick: openJukeboxModal },
    icon("music", 18),
    h("span", null, "Jukebox"),
  );
  const signOutItem = h("button", { type: "button", onclick: () => void signOut() }, icon("log-out", 18), h("span", null, "Sign out"));
  const menuPanel = h(
    "div",
    { class: "hud-menu", id: "hud-menu", hidden: true },
    h("button", { type: "button", onclick: () => ctx.store.set({ screen: "room" }) }, icon("users", 18), h("span", null, "Show lobby")),
    jukeboxItem,
    fullscreenItem,
    h("label", { class: "hud-menu-volume" }, icon("volume-2", 18), h("span", null, "Volume"), volumeInput),
    muteItem,
    h("button", { type: "button", onclick: () => ctx.store.set({ screen: "settings" }) }, icon("keyboard", 18), h("span", null, "Change controls")),
    h("button", { type: "button", onclick: () => { setMenu(false); ctx.openFeedback("bug"); } }, icon("bug", 18), h("span", null, "Report bug")),
    h("button", { type: "button", onclick: () => { setMenu(false); ctx.openFeedback("suggestion"); } }, icon("lightbulb", 18), h("span", null, "Suggest")),
    signOutItem,
  );
  const menuBtn = h(
    "button",
    { type: "button", class: "hud-menu-btn", "aria-expanded": "false", "aria-controls": "hud-menu", onclick: () => setMenu(menuPanel.hidden === true) },
    icon("menu", 18),
    h("span", { class: "hud-chip-label" }, "Menu"),
  );

  function setMenu(open: boolean): void {
    menuPanel.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      syncMenu();
      menuPanel.querySelector<HTMLButtonElement>("button:not([hidden])")?.focus();
    }
  }

  function onMenuKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    setMenu(false);
    menuBtn.focus();
  }

  function syncMenu(): void {
    fullscreenLabel.textContent = document.fullscreenElement !== null ? "Exit fullscreen" : "Fullscreen";
    muteLabel.textContent = prefs.value.musicMuted ? "Unmute music" : "Mute music";
    muteItem.replaceChildren(icon(prefs.value.musicMuted ? "volume-x" : "volume-2", 18), muteLabel);
    volumeInput.value = String(Math.round(prefs.value.volume * 100));
    jukeboxItem.hidden = ctx.store.state.room === null || ctx.store.state.room.quick !== null;
    signOutItem.hidden = ctx.store.state.account === null;
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement !== null) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      void goLandscape();
    }
  }

  async function signOut(): Promise<void> {
    try {
      await signOutAccount(ctx);
      applyAccount(ctx, null);
      setMenu(false);
    } catch (err) {
      ctx.toast(errorText(err), "error");
    }
  }
  menuPanel.addEventListener("keydown", onMenuKey);
  const unsubPrefs = prefs.subscribe(() => syncMenu());
  document.addEventListener("fullscreenchange", syncMenu);

  const endBtn = h("button", { type: "button", class: "hud-end", hidden: true, onclick: endMatch }, icon("flag", 16), h("span", { class: "hud-chip-label" }, "End match"));
  const barLeft = h("div", { class: "hud-bar hud-bar-left" }, menuBtn, linkEl, menuPanel);
  const objectiveBody = h("div", { class: "hud-objective-body" });
  const objectiveRule = h("div", { class: "hud-objective-rule" });
  const objectiveEl = h("div", { class: "hud-objective" }, objectiveBody, objectiveRule);
  const barRight = h("div", { class: "hud-bar hud-bar-right" }, chatBtn, endBtn, leaveBtn);
  // Thin top bar above the playfield (.playfield-clear via reserveTop) combining Menu, ping,
  // objective/lives readout, End match and Leave in one unified strip outside the arena.
  const topBar = h("header", { class: "hud-topbar" }, barLeft, objectiveEl, barRight);
  const releaseTop = ctx.reserveTop(topBar);
  ctx.setObjectiveInTopbar(true);
  let lastObjectiveKey = "";
  const rotate = rotateGate();
  const el = h(
    "main",
    { class: "hud-root" },
    spectateLayer,
    touch.el,
    scoresEl,
    topLeftEl,
    xpEl,
    countdownLive,
    topBar,
    connEl,
    matchingEl,
    spectateLabelEl,
    rotate.el,
  );

  function drawStatsGraph(): void {
    const g = statsGraphCtx;
    if (!g) return;
    const w = statsGraph.width;
    const hPx = statsGraph.height;
    g.clearRect(0, 0, w, hPx);
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, hPx / 2);
    g.lineTo(w, hPx / 2);
    g.stroke();
    const plot = (vals: number[], maxFloor: number, color: string): void => {
      if (vals.length < 2) return;
      let peak = maxFloor;
      for (const v of vals) if (v > peak) peak = v;
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.beginPath();
      const step = w / (GRAPH_SAMPLES - 1);
      const offset = (GRAPH_SAMPLES - vals.length) * step;
      for (let i = 0; i < vals.length; i++) {
        const x = offset + i * step;
        const y = hPx - 2 - (Math.max(0, vals[i]!) / peak) * (hPx - 4);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    };
    plot(fpsHist, 60, "#4ade80");
    const lastRtt = rttHist[rttHist.length - 1] ?? 0;
    plot(rttHist, 100, lastRtt > BAD_PING_MS ? "#f87171" : "#60a5fa");
  }

  function renderStats(s: Stats): void {
    const fps = Math.max(0, Math.round(s.fps));
    const rtt = s.rttMs < 0 ? 0 : Math.round(s.rttMs);
    fpsHist.push(fps);
    rttHist.push(rtt);
    if (fpsHist.length > GRAPH_SAMPLES) fpsHist.shift();
    if (rttHist.length > GRAPH_SAMPLES) rttHist.shift();
    statsRows.transport.value.textContent = s.transport === "udp" ? "WebRTC" : "WebSocket";
    statsRows.fps.value.textContent = String(fps);
    statsRows.rtt.value.textContent = s.rttMs < 0 ? "-" : `${rtt} ms`;
    statsRows.predDepth.value.textContent = `${s.predDepth} ticks`;
    statsRows.rollbacks.value.textContent = `${s.rollbacksPerSec.toFixed(1)}/s`;
    statsRows.rollbackP95.value.textContent = `${s.rollbackDepthP95} ticks`;
    statsRows.desync.value.textContent = s.netDesync;
    drawStatsGraph();
  }

  function renderObjective(scene: Scene): void {
    const round = scene.round > 0 ? Math.round(scene.round) : 0;
    const progress = objectiveProgress(scene);
    const pct = progress !== null ? Math.round(progress * 100) : -1;
    if (scene.mode === 1) {
      // Lives mode: show every player's colour swatch, name, and remaining lives right in the top bar (no hearts on nameplates).
      const rows = scene.scores
        .filter((r) => r.team !== TEAM_SPECTATOR)
        .map((r) => ({
          id: r.id,
          team: r.team,
          local: r.id === scene.localId,
          name: roomNames.get(r.id) ?? `#${r.id}`,
          lives: Math.max(0, Math.round(r.lives)),
        }))
        .sort((a, b) => Number(b.local) - Number(a.local) || b.lives - a.lives || a.id - b.id);
      const key = `1|${round}|${pct}|${rows.map((r) => `${r.id}:${r.name}:${r.lives}:${r.team}`).join(",")}`;
      if (key === lastObjectiveKey) return;
      lastObjectiveKey = key;
      const items: Node[] = rows.map((r) => {
        const swatch = h("span", { class: "hud-life-swatch" });
        swatch.style.background = cssHex(playerRgb(r.team, r.id));
        const cls = r.lives === 0 ? "hud-life-item is-out" : r.local ? "hud-life-item is-local" : "hud-life-item";
        return h("span", { class: cls }, swatch, h("span", { class: "hud-life-name" }, r.name), h("span", { class: "hud-life-num" }, String(r.lives)));
      });
      if (round > 0) items.push(h("span", { class: "hud-obj-round" }, `R${round}`));
      objectiveBody.replaceChildren(...items);
    } else if (isTeamMode(scene.mode)) {
      const label = objectiveLabel(scene);
      const red = Math.round(scene.red);
      const blue = Math.round(scene.blue);
      const key = `t|${scene.mode}|${round}|${pct}|${red}|${blue}|${label}`;
      if (key === lastObjectiveKey) return;
      lastObjectiveKey = key;
      const nodes: Node[] = [
        h("span", { class: "hud-obj-label" }, label),
        h(
          "span",
          { class: "hud-obj-score" },
          h("span", { class: "hud-obj-red" }, String(red)),
          " - ",
          h("span", { class: "hud-obj-blue" }, String(blue)),
        ),
      ];
      if (round > 0) nodes.push(h("span", { class: "hud-obj-round" }, `R${round}`));
      objectiveBody.replaceChildren(...nodes);
    } else {
      const label = objectiveLabel(scene);
      const key = `o|${scene.mode}|${round}|${pct}|${label}`;
      if (key === lastObjectiveKey) return;
      lastObjectiveKey = key;
      const nodes: Node[] = [h("span", { class: "hud-obj-label" }, label)];
      if (round > 0) nodes.push(h("span", { class: "hud-obj-round" }, `R${round}`));
      objectiveBody.replaceChildren(...nodes);
    }
    objectiveRule.style.transform = pct >= 0 ? `scaleX(${pct / 100})` : "scaleX(0)";
  }

  function renderLink(s: Stats): void {
    linkKind.textContent = s.transport === "udp" ? "UDP" : "WS";
    linkPing.textContent = s.rttMs < 0 ? "- ms" : `${Math.round(s.rttMs)} ms`;
    linkEl.classList.toggle("hud-link-bad", s.rttMs > BAD_PING_MS);
  }

  function renderScores(state: AppState): void {
    const scene = latestScene;
    if (scene === null) return;
    lastScoresAt = performance.now();
    board.render(scene, roomNames, state.myId ?? -1, state.tickHz);
  }

  /** One chat line. Others' text is masked when the profanity filter pref is on; our own is not. */
  function chatElement(line: ChatLine): HTMLElement {
    if (line.suggest !== undefined) {
      const sug = line.suggest;
      return h(
        "div",
        { class: "hud-chat-line hud-chat-suggest" },
        h("span", null, `🎧 ${line.name} suggests ${sug.title}`),
        isRoomHost()
          ? h(
              "button",
              {
                type: "button",
                class: "hud-chat-play",
                onclick: () => ctx.send({ t: "jukebox", action: "play", video: sug.video }),
              },
              icon("play", 12),
              "Play",
            )
          : null,
      );
    }
    const mine = line.from !== null && line.from === ctx.store.state.myId;
    const text = prefs.value.filterProfanity && line.from !== null && !mine ? filterProfanity(line.text) : line.text;
    const el = h("div", { class: line.from === null ? "hud-chat-line hud-chat-system" : "hud-chat-line" });
    if (line.name !== "") {
      const player = line.from === null ? undefined : roomPlayers.get(line.from);
      const name = h("span", { class: "hud-chat-name" }, `${line.name}: `);
      if (player !== undefined) name.style.color = cssHex(nameText(playerRgb(player.team, player.id)));
      el.append(name);
    }
    el.append(text === " " ? "\u00A0" : text);
    return el;
  }

  const CHAT_FADE_MS = 10_000;
  let chatFadeTimer: number | undefined;
  let chatIdle = false;

  function scheduleChatFade(): void {
    clearTimeout(chatFadeTimer);
    chatIdle = false;
    chatLog.classList.remove("is-idle");
    if (chatOpen) return;
    chatFadeTimer = window.setTimeout(() => {
      chatFadeTimer = undefined;
      if (!chatOpen) {
        chatIdle = true;
        chatLog.classList.add("is-idle");
      }
    }, CHAT_FADE_MS);
  }

  function renderChat(lines: readonly ChatLine[]): void {
    const recent = lines.slice(-CHAT_SHOWN);
    chatLog.replaceChildren(
      ...recent.map((line, i) => {
        const rank = recent.length - 1 - i;
        const el = chatElement(line);
        el.style.opacity = String(Math.max(0.25, 1 - rank * 0.12));
        return el;
      }),
    );
    if (recent.length > 0) scheduleChatFade();
  }

  /** Who is typing now (not us), from the server's typing signals. */
  function renderTyping(): void {
    const state = ctx.store.state;
    const now = performance.now();
    const names: string[] = [];
    for (const [id, at] of Object.entries(state.typing)) {
      const pid = Number(id);
      if (pid === state.myId || now - at > TYPING_MS) continue;
      names.push(roomPlayers.get(pid)?.name ?? `#${pid}`);
    }
    const text = names.length === 0 ? "" : `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing…`;
    if (text === typingLine) return;
    typingLine = text;
    typingEl.textContent = text;
    typingEl.hidden = text === "";
  }

  function showXp(award: XpAward): void {
    xpGain.textContent = `+${award.gained} xp`;
    xpLimit.textContent = award.limit === "short" ? "XP limit reached" : award.limit === "long" ? "Daily XP limit reached" : "";
    xpLimit.hidden = award.limit === null;
    xpEl.hidden = false;
    // Restart the entrance animation when awards arrive back to back.
    xpEl.classList.remove("hud-xp-pop");
    void xpEl.offsetWidth;
    xpEl.classList.add("hud-xp-pop");
    clearTimeout(xpTimer);
    xpTimer = window.setTimeout(() => {
      xpTimer = undefined;
      xpEl.hidden = true;
      if (ctx.store.state.xp === award) ctx.store.set({ xp: null });
    }, XP_SHOW_MS);
  }

  /** Spectating = no local player in the scene. Shows the followed player's name. */
  function updateSpectate(scene: Scene): void {
    const now = scene.localId < 0;
    if (now !== spectating) {
      spectating = now;
      spectateLayer.hidden = !now;
      spectateLabelEl.hidden = !now;
      spectateLabel = "";
    }
    if (!now) return;
    const id = spectatedId();
    const name = id >= 0 ? (roomPlayers.get(id)?.name ?? `#${id}`) : "";
    const text = name === "" ? "Spectating" : `Spectating ${name}`;
    if (text === spectateLabel) return;
    spectateLabel = text;
    spectateName.textContent = text;
  }

  function spectateStep(step: number): void {
    if (latestScene !== null) cycleSpectate(latestScene, step);
    spectateLabel = "";
  }

  function openChat(): void {
    chatOpen = true;
    clearTimeout(chatFadeTimer);
    chatIdle = false;
    chatLog.classList.remove("is-idle");
    chatForm.hidden = false;
    chatBtn.setAttribute("aria-expanded", "true");
    chatInput.focus();
  }

  function closeChat(): void {
    chatOpen = false;
    recall = -1;
    chatInput.value = "";
    chatInput.blur();
    chatForm.hidden = true;
    chatBtn.setAttribute("aria-expanded", "false");
    if (!chatIdle && chatLog.childElementCount > 0) scheduleChatFade();
  }

  function sendChat(): void {
    const raw = Array.from(chatInput.value).slice(0, MAX_CHAT_LEN).join("");
    const trimmed = raw.trim();
    const text = raw.length > 0 && trimmed === "" ? " " : trimmed;
    if (text === "/record") {
      // the clip is cut from this client's own recording; its outcome is a local line
      void recordClip(ctx).then((notice) => {
        const chat = [...ctx.store.state.chat, { from: null, name: "", text: notice }];
        ctx.store.set({ chat: chat.length > CHAT_LIMIT ? chat.slice(chat.length - CHAT_LIMIT) : chat });
      });
    } else if (text !== "") {
      ctx.send({ t: "chat", text });
      sentChat.push(text);
      if (sentChat.length > SENT_HISTORY_MAX) sentChat.shift();
    }
    closeChat();
  }

  /** Up/Down: step back (1) or forward (-1) through own lines; past the newest line the input clears. */
  function recallChat(step: 1 | -1): void {
    if (sentChat.length === 0) return;
    recall = Math.min(Math.max(recall + step, -1), sentChat.length - 1);
    chatInput.value = recall === -1 ? "" : sentChat[sentChat.length - 1 - recall];
  }

  /** Tell the room we are typing, at most once per TYPING_SEND_MS. */
  function onTypingInput(): void {
    const now = performance.now();
    if (now - lastTypingSent < TYPING_SEND_MS) return;
    lastTypingSent = now;
    ctx.send({ t: "typing" });
  }

  /** True while the End match confirm is open: its keys belong to the dialog, not to chat, the menu or the spectator. */
  let endConfirming = false;

  async function endMatch(): Promise<void> {
    if (endConfirming) return;
    endConfirming = true;
    try {
      const ok = await confirmDialog({
        title: "End the match?",
        message: "The match ends for everyone in the room now.",
        action: "End match",
      });
      if (ok) ctx.send({ t: "end_match" });
    } finally {
      endConfirming = false;
    }
  }

  // Capture phase: while chat is open, keys go to chat and never reach the movement input.
  function onWindowKey(e: KeyboardEvent): void {
    if (endConfirming || document.querySelector("dialog.modal[open]") !== null) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || e.isComposing) return;
    if (!chatOpen) {
      if (e.key === "Enter" && !e.repeat) {
        e.preventDefault();
        openChat();
      } else if (e.key === "Escape" && !e.repeat) {
        e.preventDefault();
        setMenu(menuPanel.hidden === true);
      } else if (spectating && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        spectateStep(e.key === "ArrowRight" ? 1 : -1);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.key === "Control" || e.key === "Meta" || e.key === "Alt" || e.key === "Shift") {
      return;
    }
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      sendChat();
    } else if (e.key === "Escape") {
      closeChat();
    } else {
      chatInput.focus();
    }
  }

  function onInputKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Enter") sendChat();
    else if (e.key === "Escape") closeChat();
    else if (e.key === "ArrowUp") recallChat(1);
    else if (e.key === "ArrowDown") recallChat(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Apply the parts of `state` that differ from `prev` (all parts when prev is null). */
  function sync(state: AppState, prev: AppState | null): void {
    const same = <K extends keyof AppState>(k: K): boolean => prev !== null && prev[k] === state[k];
    if (!same("room")) {
      roomPlayers = new Map((state.room?.players ?? []).map((p): [number, PlayerInfo] => [p.id, p]));
      roomNames = new Map([...roomPlayers].map(([id, p]): [number, string] => [id, p.name]));
      setPlayerColors(new Map([...roomPlayers].map(([id, p]): [number, number] => [id, p.color])));
    }
    if (!same("showStats")) statsEl.hidden = !state.showStats;
    if (state.showStats && (!same("showStats") || !same("stats"))) renderStats(state.stats);
    if (!same("stats")) renderLink(state.stats);
    if (!same("showScores")) scoresEl.hidden = !state.showScores;
    if (state.showScores && (!same("showScores") || !same("room"))) renderScores(state);
    if (!same("room") || !same("inMatch")) matchingEl.hidden = !aloneInQuickMatch(state);
    if (!same("chat")) renderChat(state.chat);
    if (!same("chat")) {
      const last = state.chat[state.chat.length - 1];
      if (prev !== null && last !== undefined && last !== prev.chat[prev.chat.length - 1] && last.from !== null && last.from !== state.myId) {
        ctx.sfx.chatPop();
      }
    }
    if (!same("typing") || !same("room")) renderTyping();
    if (prev !== null && !same("xp") && state.xp !== null && state.xp.quick) showXp(state.xp);
    if (!same("connection") || !same("inMatch")) {
      connEl.hidden = !(state.inMatch && state.connection === "closed");
    }
    if (!same("room") || !same("myId")) {
      endBtn.hidden = state.room?.players.find((p) => p.id === state.myId)?.host !== true;
    }
  }

  window.addEventListener("keydown", onWindowKey, true);
  chatInput.addEventListener("keydown", onInputKey);
  chatInput.addEventListener("input", onTypingInput);
  sync(ctx.store.state, null);
  const typingTimer = setInterval(renderTyping, TYPING_TICK_MS);

  return {
    el,
    update(state, prev) {
      sync(state, prev);
    },
    onFrame(scene) {
      latestScene = scene;
      board.record(scene, roomNames);
      renderObjective(scene);
      updateSpectate(scene);
      touch.setLive(scene.intro < 0 && !spectating);
      // The start countdown is announced each second ("Match starting in 3 seconds", then 2, 1) and then "Go"; its digits are also drawn on the canvas.
      const secs = Math.ceil(scene.intro / ctx.store.state.tickHz);
      if (scene.intro < 0) {
        if (countdownSecs > 0) countdownLive.textContent = "Go";
        countdownSecs = -1;
      } else if (secs > 0 && secs !== countdownSecs) {
        countdownSecs = secs;
        countdownLive.textContent = `Match starting in ${secs} ${secs === 1 ? "second" : "seconds"}`;
      }
      if (!ctx.store.state.showScores) return;
      if (performance.now() - lastScoresAt < SCORE_INTERVAL_MS) return;
      renderScores(ctx.store.state);
    },
    destroy() {
      window.removeEventListener("keydown", onWindowKey, true);
      document.removeEventListener("fullscreenchange", syncMenu);
      unsubPrefs();
      clearInterval(typingTimer);
      clearTimeout(xpTimer);
      clearTimeout(chatFadeTimer);
      touch.destroy();
      rotate.destroy();
      chatInput.blur();
      latestScene = null;
      setPlayerColors(new Map());
      ctx.setObjectiveInTopbar(false);
      releaseTop();
      el.remove();
    },
  };
};
