// Quick play: pick a queue and the server seats us in an open room of that queue or
// makes one. Each card shows the players currently in that queue (refreshed every
// 10 s). Not connected yet: the name is sent with the connect and the queue is kept in
// state.intent, so app.ts sends quick_play once the server welcomes us.

import type { ScreenFactory } from "../../ctx";
import { fetchStats } from "../../api";
import { MAX_NAME_LEN, NAME_RE, QUICK_QUEUES, type QuickQueue } from "../../protocol";
import type { AppState } from "../../state";
import { h } from "../dom";
import { readStoredName, sanitizeName, writeStoredName } from "./menu";

const REFRESH_MS = 10_000;

const QUEUE_INFO: Record<QuickQueue, { title: string; text: string }> = {
  ffa: { title: "Free for all", text: "Score kills against everyone. Rooms rotate maps by themselves." },
  teams: { title: "Team rounds", text: "Red against blue, round after round, with no host to manage." },
  lives: { title: "Lives", text: "Every player gets a few lives. The last one standing wins." },
};

function statusText(state: AppState): string {
  if (state.connection === "connecting") return "Connecting…";
  if (state.connection === "open") return "Connected.";
  return state.connectDetail ? `Disconnected: ${state.connectDetail}` : "Disconnected.";
}

export const quickScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  let waiting = false;
  let attempted = false;
  /** Set once the transport starts connecting, so an earlier "closed" state is not read as a failure. */
  let sawConnecting = false;
  let counts: Record<QuickQueue, number> | null = null;

  const account = store.state.account;
  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const countsLine = h("p", { class: "quick-online" });

  const nameInput = h("input", {
    type: "text",
    placeholder: "name",
    maxlength: MAX_NAME_LEN,
    autocomplete: "nickname",
    spellcheck: "false",
    "aria-label": "name",
    value: account?.name ?? (store.state.name || readStoredName()),
    readonly: account !== null,
    oninput: () => sync(),
  });
  const nameField = h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, "Name"),
    nameInput,
  );

  const cards = new Map<QuickQueue, HTMLButtonElement>();
  for (const { id } of QUICK_QUEUES) {
    const info = QUEUE_INFO[id];
    cards.set(
      id,
      h(
        "button",
        { type: "button", class: "quick-card", onclick: () => choose(id) },
        h("span", { class: "quick-title" }, info.title),
        h("span", { class: "quick-text" }, info.text),
        h("span", { class: "quick-count", "data-queue": id }, ""),
      ),
    );
  }

  const backBtn = h("button", { type: "button", class: "quick-back", onclick: () => back() }, "Back");

  /** Cards need a valid name unless the account supplies one. */
  function sync(): void {
    const valid = account !== null || NAME_RE.test(sanitizeName(nameInput.value));
    for (const card of cards.values()) card.disabled = !valid || waiting;
  }

  function renderCounts(): void {
    for (const { id } of QUICK_QUEUES) {
      const el = cards.get(id)?.querySelector<HTMLElement>(".quick-count");
      if (!el) continue;
      el.textContent = counts ? `${counts[id]} playing now` : "";
    }
    countsLine.textContent = counts ? `${Object.values(counts).reduce((a, b) => a + b, 0)} players in quick play` : "";
  }

  async function refresh(): Promise<void> {
    try {
      const s = await fetchStats();
      counts = s.quick;
      renderCounts();
    } catch {
      // Keep the last counts; the next tick retries.
    }
  }

  /** Join the queue: send now when connected, otherwise connect and let the welcome send it. */
  function choose(queue: QuickQueue): void {
    waiting = true;
    sawConnecting = false;
    status.textContent = "Finding a room…";
    sync();
    if (store.state.connection === "open") {
      ctx.send({ t: "quick_play", queue });
      return;
    }
    const name = account?.name ?? sanitizeName(nameInput.value);
    if (!account && !NAME_RE.test(name)) {
      waiting = false;
      sync();
      return;
    }
    nameInput.value = name;
    writeStoredName(name);
    attempted = true;
    store.set({ name, intent: queue });
    ctx.play(name);
  }

  function back(): void {
    if (waiting) {
      waiting = false;
      ctx.disconnect();
      store.set({ intent: null });
      status.textContent = "";
      sync();
      return;
    }
    store.set({ screen: store.state.connection === "open" ? "browse" : "menu" });
  }

  sync();
  void refresh();
  const timer = window.setInterval(() => void refresh(), REFRESH_MS);

  const el = h(
    "div",
    { class: "screen quick" },
    h(
      "section",
      { class: "panel quick-panel" },
      h("header", { class: "quick-head" }, h("h1", null, "Quick play")),
      countsLine,
      account ? null : nameField,
      h("div", { class: "quick-cards" }, [...cards.values()]),
      status,
      h("div", { class: "actions" }, backBtn),
    ),
  );

  return {
    el,
    update(state) {
      if (state.connection === "connecting") sawConnecting = true;
      // A connection that started and then closed before a room was found: report it and allow a retry.
      if (waiting && sawConnecting && state.connection === "closed") {
        waiting = false;
      }
      if (waiting) status.textContent = "Finding a room…";
      else status.textContent = attempted ? statusText(state) : "";
      if (state.account && !nameInput.readOnly) {
        nameInput.value = state.account.name;
        nameInput.readOnly = true;
      }
      sync();
    },
    destroy() {
      window.clearInterval(timer);
      el.remove();
    },
  };
};
