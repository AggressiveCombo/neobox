// In-match HUD: touch pad, scoreboard, stats overlay, chat and leave button.
// DOM only; it sits over the render canvases and enables pointer events only on
// interactive elements (see hud.css).

import { applyAccount, errorText, logout } from "../../account";
import type { AppCtx, HudFactory } from "../../ctx";
import { cycleSpectate, spectatedId } from "../../camera";
import { recordClip } from "../../clips";
import type { Scene, ScoreRow } from "../../frame";
import { BIT } from "../../input";
import { filterProfanity } from "../../profanity";
import { prefs } from "../../prefs";
import { MAX_CHAT_LEN, TEAM_BLUE, TEAM_FFA, TEAM_RED, TEAM_SPECTATOR, type PlayerInfo, type XpAward } from "../../protocol";
import { cssHex, mixRgb, playerRgb, setPlayerColors } from "../../render/geometry";
import { CHAT_LIMIT, type AppState, type ChatLine, type Stats } from "../../state";
import { chatPlaceholder } from "../chat-hint";
import { h } from "../dom";
import { icon, type IconName } from "../icons";
import { confirmDialog, contrastRatio } from "../kit";

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

interface TouchSpec {
  bit: number;
  area: string;
  label: string;
  aria: string;
  icon: IconName;
}

/** Stick: fraction of the radius before a direction engages. */
const STICK_DEAD = 0.3;
/** tan(67.5°): a direction stays on within 67.5° of its axis (8-way). */
const STICK_SECTOR = 2.414;

const ACTIONS: TouchSpec[] = [
  { bit: BIT.UP, area: "jump", label: "Jump", aria: "Jump", icon: "move-up" },
  { bit: BIT.PUSH, area: "push", label: "Push", aria: "Push X", icon: "arrow-right" },
  { bit: BIT.ROCKET, area: "rocket", label: "Rocket", aria: "Rocket Z", icon: "rocket" },
  { bit: BIT.BAT, area: "bat", label: "Bat", aria: "Bat C", icon: "swords" },
  { bit: BIT.GRAB, area: "grab", label: "Grab", aria: "Grab V", icon: "hand" },
];

/** Display order of scoreboard teams; unknown teams sort last. */
const TEAM_ORDER: readonly number[] = [TEAM_RED, TEAM_BLUE, TEAM_FFA, TEAM_SPECTATOR];

function teamRank(team: number): number {
  const i = TEAM_ORDER.indexOf(team);
  return i === -1 ? TEAM_ORDER.length : i;
}

function teamInfo(team: number): { label: string; cls: string } {
  switch (team) {
    case TEAM_RED:
      return { label: "Red", cls: "hud-team-red" };
    case TEAM_BLUE:
      return { label: "Blue", cls: "hud-team-blue" };
    case TEAM_FFA:
      return { label: "FFA", cls: "hud-team-ffa" };
    default:
      return { label: "spectator", cls: "hud-team-spec" };
  }
}

function statusText(row: ScoreRow, tickHz: number): string {
  if (row.alive) return "alive";
  if (row.eliminated !== 0) return "eliminated";
  if (row.respawn <= 0) return "dead";
  return tickHz > 0 ? `respawn ${(row.respawn / tickHz).toFixed(1)}s` : `respawn ${Math.ceil(row.respawn)} ticks`;
}

function touchButton(ctx: AppCtx, spec: TouchSpec): HTMLButtonElement {
  const btn = h(
    "button",
    { type: "button", class: `hud-touch hud-touch-${spec.area}`, "aria-label": spec.aria, tabindex: -1 },
    icon(spec.icon, 22),
    h("span", { class: "hud-touch-label" }, spec.label),
  );
  const press = (on: boolean): void => {
    ctx.input.setTouch("buttons", spec.bit, on);
    btn.classList.toggle("hud-on", on);
  };
  btn.addEventListener("pointerdown", (e: PointerEvent) => {
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
  const set = (dx: number, dy: number): void => {
    const dist = Math.hypot(dx, dy);
    const on = dist > radius * STICK_DEAD;
    const horizontal = on && Math.abs(dx) * STICK_SECTOR >= Math.abs(dy);
    const vertical = on && Math.abs(dy) * STICK_SECTOR >= Math.abs(dx);
    ctx.input.setTouch("stick", BIT.LEFT, horizontal && dx < 0);
    ctx.input.setTouch("stick", BIT.RIGHT, horizontal && dx > 0);
    ctx.input.setTouch("stick", BIT.UP, vertical && dy < 0);
    ctx.input.setTouch("stick", BIT.DOWN, vertical && dy > 0);
    const k = dist > radius ? radius / dist : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    pad.classList.toggle("hud-on", on);
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
    el.hidden = !(coarse.matches && portrait.matches && !dismissed);
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
    "Play in portrait anyway",
  );
  const el: HTMLElement = h(
    "div",
    { class: "hud-rotate", role: "dialog", "aria-label": "Turn your phone sideways", hidden: true },
    h("div", { class: "hud-rotate-icon", "aria-hidden": "true" }),
    h("h2", null, "Turn your phone sideways"),
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
export function touchControls(ctx: AppCtx): { el: HTMLElement; destroy(): void } {
  const touchCapable = isTouchDevice();
  const el = h(
    "div",
    { class: "hud-touch-layer", hidden: !touchCapable },
    touchStick(ctx),
    h("div", { class: "hud-actions" }, ...ACTIONS.map((s) => touchButton(ctx, s))),
  );
  const applyPrefs = (): void => {
    el.style.setProperty("--hud-touch-scale", String(prefs.value.touchScale));
    el.classList.toggle("hud-left-handed", prefs.value.touchLeftHanded);
  };
  applyPrefs();
  const unsubscribe = prefs.subscribe(applyPrefs);
  return {
    el,
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

function scoreRow(row: ScoreRow, name: string, self: boolean, tickHz: number): HTMLTableRowElement {
  const team = teamInfo(row.team);
  return h(
    "tr",
    { class: self ? "hud-row hud-row-self" : "hud-row" },
    h("td", { class: "hud-name" }, name),
    h("td", { class: team.cls }, team.label),
    h("td", { class: "hud-num" }, String(Math.round(row.kills))),
    h("td", { class: "hud-num" }, String(Math.round(row.wins))),
    h("td", { class: "hud-num" }, String(Math.round(row.lives))),
    h("td", null, statusText(row, tickHz)),
  );
}

export const hudScreen: HudFactory = (ctx) => {
  let latestScene: Scene | null = null;
  let lastScoresAt = -Infinity;
  let chatOpen = false;
  let recall = -1;
  let roomPlayers = new Map<number, PlayerInfo>();
  let lastTypingSent = -Infinity;
  let spectating = false;
  let spectateLabel = "";
  let xpTimer: number | undefined;
  let typingLine = "";

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

  // Stats overlay.
  const statsRows = {
    transport: statRow("Transport"),
    fps: statRow("FPS"),
    ping: statRow("Ping"),
    rtt: statRow("RTT"),
    predDepth: statRow("Prediction"),
    rollbacks: statRow("Rollbacks"),
  };
  const statsEl = h("div", { class: "hud-stats" }, ...Object.values(statsRows).map((r) => r.el));
  // Connection chip: transport and ping; only its colour changes when the ping is bad.
  const linkKind = h("span", { class: "hud-link-kind" });
  const linkPing = h("span");
  const linkEl = h("span", { class: "hud-link", title: "Connection" }, icon("wifi", 18), linkKind, linkPing);

  // Scoreboard.
  const tbody = h("tbody");
  const scoresEl = h(
    "div",
    { class: "hud-scores" },
    h(
      "table",
      { class: "hud-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "Player"),
          h("th", null, "Team"),
          h("th", { class: "hud-num" }, "Kills"),
          h("th", { class: "hud-num" }, "Wins"),
          h("th", { class: "hud-num" }, "Lives"),
          h("th", null, "Status"),
        ),
      ),
      tbody,
    ),
  );

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
  const topLeftEl = h("div", { class: "hud-topleft" }, statsEl, chatLog, typingEl, chatForm);

  // Quick-play XP popup, centre screen.
  const xpGain = h("div", { class: "hud-xp-gain" });
  const xpLimit = h("div", { class: "hud-xp-limit" });
  const xpEl = h("div", { class: "hud-xp", hidden: true, role: "status" }, xpGain, xpLimit);

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
  const signOutItem = h("button", { type: "button", onclick: () => void signOut() }, icon("log-out", 18), h("span", null, "Sign out"));
  const menuPanel = h(
    "div",
    { class: "hud-menu", id: "hud-menu", hidden: true },
    h("button", { type: "button", onclick: () => ctx.store.set({ screen: "room" }) }, icon("users", 18), h("span", null, "Show lobby")),
    fullscreenItem,
    h("label", { class: "hud-menu-volume" }, icon("volume-2", 18), h("span", null, "Volume"), volumeInput),
    muteItem,
    h("button", { type: "button", onclick: () => ctx.store.set({ screen: "settings" }) }, icon("keyboard", 18), h("span", null, "Change controls")),
    signOutItem,
  );
  const menuBtn = h(
    "button",
    { type: "button", class: "hud-menu-btn", "aria-expanded": "false", "aria-controls": "hud-menu", onclick: () => setMenu(menuPanel.hidden) },
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
    volumeInput.value = String(Math.round(prefs.value.volume * 100));
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
      await logout();
      applyAccount(ctx, null);
      setMenu(false);
    } catch (err) {
      ctx.toast(errorText(err), "error");
    }
  }
  menuPanel.addEventListener("keydown", onMenuKey);
  const unsubPrefs = prefs.subscribe(() => syncMenu());
  document.addEventListener("fullscreenchange", syncMenu);

  const endBtn = h("button", { type: "button", class: "hud-end", hidden: true, onclick: endMatch }, icon("flag", 18), h("span", { class: "hud-chip-label" }, "End match"));
  const barLeft = h("div", { class: "hud-bar hud-bar-left" }, menuBtn, linkEl, menuPanel);
  const barRight = h("div", { class: "hud-bar hud-bar-right" }, chatBtn, endBtn, leaveBtn);
  const releaseChips = [ctx.reserveChrome(barLeft), ctx.reserveChrome(barRight)];
  const rotate = rotateGate();
  const el = h(
    "div",
    { class: "hud-root" },
    spectateLayer,
    touch.el,
    scoresEl,
    topLeftEl,
    xpEl,
    barLeft,
    barRight,
    connEl,
    matchingEl,
    spectateLabelEl,
    rotate.el,
  );

  function renderStats(s: Stats): void {
    statsRows.transport.value.textContent = s.transport === "udp" ? "WebRTC" : "WebSocket";
    statsRows.fps.value.textContent = String(Math.round(s.fps));
    statsRows.ping.value.textContent = s.pingMs < 0 ? "-" : `${Math.round(s.pingMs)} ms`;
    statsRows.rtt.value.textContent = s.rttMs < 0 ? "-" : `${Math.round(s.rttMs)} ms`;
    statsRows.predDepth.value.textContent = `${s.predDepth} ticks`;
    statsRows.rollbacks.value.textContent = `${s.rollbacksPerSec.toFixed(1)}/s`;
  }

  function renderLink(s: Stats): void {
    linkKind.textContent = s.transport === "udp" ? "UDP" : "WS";
    linkPing.textContent = s.pingMs < 0 ? "- ms" : `${Math.round(s.pingMs)} ms`;
    linkEl.classList.toggle("hud-link-bad", s.pingMs > BAD_PING_MS);
  }

  function renderScores(state: AppState): void {
    const scene = latestScene;
    if (scene === null) return;
    lastScoresAt = performance.now();
    const rows = [...scene.scores].sort((a, b) => teamRank(a.team) - teamRank(b.team) || a.id - b.id);
    tbody.replaceChildren(
      ...rows.map((row) =>
        scoreRow(row, roomPlayers.get(row.id)?.name ?? `#${row.id}`, row.id === state.myId, state.tickHz),
      ),
    );
  }

  /** One chat line. Others' text is masked when the profanity filter pref is on; our own is not. */
  function chatElement(line: ChatLine): HTMLElement {
    if (line.suggest !== undefined) {
      return h("div", { class: "hud-chat-line hud-chat-suggest" }, `🎧 ${line.name} suggests ${line.suggest.title}`);
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
    el.append(text);
    return el;
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
  }

  function sendChat(): void {
    const text = Array.from(chatInput.value.trim()).slice(0, MAX_CHAT_LEN).join("").trim();
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
    if (endConfirming) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || e.isComposing) return;
    if (!chatOpen) {
      if (e.key === "Enter" && !e.repeat) {
        e.preventDefault();
        openChat();
      } else if (e.key === "Escape" && !e.repeat) {
        e.preventDefault();
        setMenu(menuPanel.hidden);
      } else if (spectating && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        spectateStep(e.key === "ArrowRight" ? 1 : -1);
      }
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
      setPlayerColors(new Map([...roomPlayers].map(([id, p]): [number, number] => [id, p.color])));
    }
    if (!same("showStats")) statsEl.hidden = !state.showStats;
    if (state.showStats && (!same("showStats") || !same("stats"))) renderStats(state.stats);
    if (!same("stats")) renderLink(state.stats);
    if (!same("showScores")) scoresEl.hidden = !state.showScores;
    if (state.showScores && (!same("showScores") || !same("room"))) renderScores(state);
    if (!same("chat") || !same("room")) renderChat(state.chat);
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
      updateSpectate(scene);
      const alone = ctx.store.state.room?.quick != null && scene.scores.length === 1;
      if (matchingEl.hidden === alone) matchingEl.hidden = !alone;
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
      touch.destroy();
      rotate.destroy();
      chatInput.blur();
      latestScene = null;
      setPlayerColors(new Map());
      for (const release of releaseChips) release();
      el.remove();
    },
  };
};
