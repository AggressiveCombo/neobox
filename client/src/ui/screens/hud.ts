// In-match HUD: touch pad, scoreboard, stats overlay, chat and leave button.
// DOM only; it sits over the render canvases and enables pointer events only on
// interactive elements (see hud.css).

import type { AppCtx, HudFactory } from "../../ctx";
import type { Scene, ScoreRow } from "../../frame";
import { BIT } from "../../input";
import { MAX_CHAT_LEN, TEAM_BLUE, TEAM_FFA, TEAM_RED, TEAM_SPECTATOR } from "../../protocol";
import type { AppState, ChatLine, Stats } from "../../state";
import { h } from "../dom";

const SCORE_INTERVAL_MS = 100;
const CHAT_SHOWN = 8;

interface TouchSpec {
  bit: number;
  area: string;
  label: string;
  aria: string;
}

/** Stick: fraction of the radius before a direction engages. */
const STICK_DEAD = 0.3;
/** tan(67.5°): a direction stays on within 67.5° of its axis (8-way). */
const STICK_SECTOR = 2.414;

const ACTIONS: TouchSpec[] = [
  { bit: BIT.PUSH, area: "push", label: "Push", aria: "Push X" },
  { bit: BIT.ROCKET, area: "rocket", label: "Rocket", aria: "Rocket Z" },
  { bit: BIT.BAT, area: "bat", label: "Bat", aria: "Bat C" },
  { bit: BIT.GRAB, area: "grab", label: "Grab", aria: "Grab V" },
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
    spec.label,
  );
  const press = (on: boolean): void => {
    ctx.input.setTouch(spec.bit, on);
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
    ctx.input.setTouch(BIT.LEFT, horizontal && dx < 0);
    ctx.input.setTouch(BIT.RIGHT, horizontal && dx > 0);
    ctx.input.setTouch(BIT.UP, vertical && dy < 0);
    ctx.input.setTouch(BIT.DOWN, vertical && dy > 0);
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
  const touchCapable = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;

  let latestScene: Scene | null = null;
  let lastScoresAt = -Infinity;
  let chatOpen = false;

  // Touch controls.
  const padEl = touchStick(ctx);
  const actionsEl = h("div", { class: "hud-actions" }, ...ACTIONS.map((s) => touchButton(ctx, s)));
  const chatBtn = h("button", { type: "button", class: "hud-chat-btn", "aria-label": "Chat", onclick: () => (chatOpen ? closeChat() : openChat()) }, "Chat");
  const touchEl = h("div", { class: "hud-touch-layer", hidden: !touchCapable }, padEl, actionsEl, chatBtn);

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
  const chatInput = h("input", {
    class: "hud-chat-input",
    type: "text",
    maxlength: MAX_CHAT_LEN,
    autocomplete: "off",
    placeholder: "Message",
    "aria-label": "Chat message",
  });
  const chatForm = h("div", { class: "hud-chat-form", hidden: true }, chatInput);
  const topLeftEl = h("div", { class: "hud-topleft" }, statsEl, chatLog, chatForm);

  const leaveBtn = h(
    "button",
    { type: "button", class: "hud-leave", onclick: () => ctx.send({ t: "leave_room" }) },
    "Leave",
  );
  const connEl = h("div", { class: "hud-conn", role: "status", hidden: true }, "connection lost");

  const el = h("div", { class: "hud-root" }, touchEl, scoresEl, topLeftEl, leaveBtn, connEl);

  function renderStats(s: Stats): void {
    statsRows.transport.value.textContent = s.transport === "udp" ? "WebRTC" : "WebSocket";
    statsRows.fps.value.textContent = String(Math.round(s.fps));
    statsRows.ping.value.textContent = s.pingMs < 0 ? "-" : `${Math.round(s.pingMs)} ms`;
    statsRows.rtt.value.textContent = `${Math.round(s.rttMs)} ms`;
    statsRows.predDepth.value.textContent = `${s.predDepth} ticks`;
    statsRows.rollbacks.value.textContent = `${s.rollbacksPerSec.toFixed(1)}/s`;
  }

  function renderScores(state: AppState): void {
    const scene = latestScene;
    if (scene === null) return;
    lastScoresAt = performance.now();
    const names = new Map<number, string>();
    for (const p of state.room?.players ?? []) names.set(p.id, p.name);
    const rows = [...scene.scores].sort((a, b) => teamRank(a.team) - teamRank(b.team) || a.id - b.id);
    tbody.replaceChildren(
      ...rows.map((row) =>
        scoreRow(row, names.get(row.id) ?? `#${row.id}`, row.id === state.myId, state.tickHz),
      ),
    );
  }

  function renderChat(lines: readonly ChatLine[]): void {
    const recent = lines.slice(-CHAT_SHOWN);
    chatLog.replaceChildren(
      ...recent.map((line, i) => {
        const rank = recent.length - 1 - i;
        const el = h(
          "div",
          { class: line.from === null ? "hud-chat-line hud-chat-system" : "hud-chat-line" },
          line.name !== "" ? h("span", { class: "hud-chat-name" }, `${line.name}: `) : null,
          line.text,
        );
        el.style.opacity = String(Math.max(0.25, 1 - rank * 0.12));
        return el;
      }),
    );
  }

  function openChat(): void {
    chatOpen = true;
    chatForm.hidden = false;
    chatInput.focus();
  }

  function closeChat(): void {
    chatOpen = false;
    chatInput.value = "";
    chatInput.blur();
    chatForm.hidden = true;
  }

  function sendChat(): void {
    const text = Array.from(chatInput.value.trim()).slice(0, MAX_CHAT_LEN).join("").trim();
    if (text !== "") ctx.send({ t: "chat", text });
    closeChat();
  }

  // Capture phase: while chat is open, keys go to chat and never reach the movement input.
  function onWindowKey(e: KeyboardEvent): void {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || e.isComposing) return;
    if (!chatOpen) {
      if (e.key === "Enter" && !e.repeat) {
        e.preventDefault();
        openChat();
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
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Apply the parts of `state` that differ from `prev` (all parts when prev is null). */
  function sync(state: AppState, prev: AppState | null): void {
    const same = <K extends keyof AppState>(k: K): boolean => prev !== null && prev[k] === state[k];
    if (!same("showStats")) statsEl.hidden = !state.showStats;
    if (state.showStats && (!same("showStats") || !same("stats"))) renderStats(state.stats);
    if (!same("showScores")) scoresEl.hidden = !state.showScores;
    if (state.showScores && (!same("showScores") || !same("room"))) renderScores(state);
    if (!same("chat")) renderChat(state.chat);
    if (!same("connection") || !same("inMatch")) {
      connEl.hidden = !(state.inMatch && state.connection === "closed");
    }
  }

  window.addEventListener("keydown", onWindowKey, true);
  chatInput.addEventListener("keydown", onInputKey);
  sync(ctx.store.state, null);

  return {
    el,
    update(state, prev) {
      sync(state, prev);
    },
    onFrame(scene) {
      latestScene = scene;
      if (!ctx.store.state.showScores) return;
      if (performance.now() - lastScoresAt < SCORE_INTERVAL_MS) return;
      renderScores(ctx.store.state);
    },
    destroy() {
      window.removeEventListener("keydown", onWindowKey, true);
      ctx.input.clearTouch();
      chatInput.blur();
      latestScene = null;
      el.remove();
    },
  };
};
