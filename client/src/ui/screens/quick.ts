// Quick play, as the original's quick menu: one card per mode of the server's rotation
// (/api/rotation, the original's maps2.json), with its title, the players online in it
// (refreshed every 30 s like playercount.json), its description and a carousel of its map
// rotation. Clicking a card (not its arrows) finds a match. Not connected yet: the name is
// sent with the connect and the mode is kept in state.intent, so app.ts starts quick play
// once the server welcomes us.

import type { ScreenFactory } from "../../ctx";
import { fetchQuickModes, fetchStats, type QuickMode } from "../../api";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import type { AppState } from "../../state";
import { h } from "../dom";
import { previewCode } from "../map-list";
import { readStoredName, sanitizeName, writeStoredName } from "./menu";

const REFRESH_MS = 30_000;

/** The rotation, fetched once per page load. */
let modesP: Promise<QuickMode[]> | null = null;

function quickModes(): Promise<QuickMode[]> {
  modesP ??= fetchQuickModes().catch((err: unknown) => {
    modesP = null;
    throw err;
  });
  return modesP;
}

function statusText(state: AppState): string {
  if (state.connection === "connecting") return "Connecting…";
  if (state.connection === "open") return "Connected.";
  return state.connectDetail ? `Disconnected: ${state.connectDetail}` : "Disconnected.";
}

interface Card {
  el: HTMLElement;
  choose: HTMLButtonElement;
  count: HTMLElement;
}

export const quickScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  let waiting = false;
  let attempted = false;
  /** Set once the transport starts connecting, so an earlier "closed" state is not read as a failure. */
  let sawConnecting = false;
  let counts: Record<string, number> | null = null;
  let destroyed = false;

  const account = store.state.account;
  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });

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

  const cards = new Map<string, Card>();
  const cardBox = h("div", { class: "quick-cards" }, h("p", { class: "quick-loading" }, "Loading…"));

  /** A map preview of the carousel; `code` drawn into a fresh canvas. */
  function thumb(map: QuickMode["maps"][number]): HTMLElement {
    const canvas = h("canvas", { "aria-hidden": "true" });
    const label = map.author ? `${map.name} by ${map.author}` : map.name;
    const box = h("div", { class: "map-thumb quick-thumb", title: label, role: "img", "aria-label": label }, canvas);
    void previewCode(ctx, canvas, map.code).then((err) => {
      if (err !== null) box.replaceChildren(h("span", { class: "thumb-missing" }, "no preview"));
    });
    return box;
  }

  /**
   * The mode's rotation as the original shows it: the current map in the middle, the previous and
   * next one beside it, and arrows that step through the rotation.
   */
  function carousel(mode: QuickMode): HTMLElement | null {
    const maps = mode.maps;
    if (maps.length === 0) return null;
    if (maps.length === 1) return h("div", { class: "quick-maps" }, h("div", { class: "quick-thumbs" }, thumb(maps[0]!)));
    let at = 0;
    const thumbs = h("div", { class: "quick-thumbs" });
    const draw = (): void => {
      const n = maps.length;
      thumbs.replaceChildren(thumb(maps[(at + n - 1) % n]!), thumb(maps[at]!), thumb(maps[(at + 1) % n]!));
      thumbs.children[1]?.classList.add("quick-thumb-mid");
    };
    const step = (d: number) => (e: Event): void => {
      e.stopPropagation();
      at = (at + d + maps.length) % maps.length;
      draw();
    };
    draw();
    return h(
      "div",
      { class: "quick-maps" },
      h("button", { type: "button", class: "quick-arrow", "aria-label": `Previous ${mode.title} map`, onclick: step(-1) }, "‹"),
      thumbs,
      h("button", { type: "button", class: "quick-arrow", "aria-label": `Next ${mode.title} map`, onclick: step(1) }, "›"),
    );
  }

  function buildCards(modes: QuickMode[]): void {
    cards.clear();
    if (modes.length === 0) {
      cardBox.replaceChildren(h("p", { class: "quick-loading" }, "This server has no quick play."));
      return;
    }
    cardBox.replaceChildren(
      ...modes.map((mode) => {
        const count = h("span", { class: "quick-count" }, "");
        const pick = h(
          "button",
          { type: "button", class: "quick-choose", onclick: (e: Event) => { e.stopPropagation(); choose(mode.id); } },
          h("span", { class: "quick-title" }, mode.title),
          count,
          h("span", { class: "quick-text" }, mode.description),
        );
        // like the original's card, a click anywhere on it but the arrows picks the mode
        const el = h("div", { class: "quick-card", onclick: () => { if (!pick.disabled) pick.click(); } }, pick, carousel(mode));
        cards.set(mode.id, { el, choose: pick, count });
        return el;
      }),
    );
    renderCounts();
    sync();
  }

  /** Cards need a valid name unless the account supplies one. */
  function sync(): void {
    const valid = account !== null || NAME_RE.test(sanitizeName(nameInput.value));
    for (const card of cards.values()) {
      card.choose.disabled = !valid || waiting;
      card.el.classList.toggle("disabled", card.choose.disabled);
    }
  }

  function renderCounts(): void {
    for (const [id, card] of cards) card.count.textContent = `${counts?.[id] ?? 0} players online`;
  }

  async function refresh(): Promise<void> {
    try {
      counts = (await fetchStats()).counts;
      renderCounts();
    } catch {
      // Keep the last counts; the next tick retries.
    }
  }

  /** Find a match: now when connected, otherwise connect and let the welcome start it. */
  function choose(queue: string): void {
    waiting = true;
    sawConnecting = false;
    status.textContent = "Finding a match...";
    sync();
    if (store.state.connection === "open") {
      ctx.quickPlay(queue);
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

  const backBtn = h("button", { type: "button", class: "quick-back", onclick: () => back() }, "Back");

  void quickModes().then(
    (modes) => {
      if (!destroyed) buildCards(modes);
    },
    () => {
      if (!destroyed) cardBox.replaceChildren(h("p", { class: "quick-loading" }, "Could not load quick play. Try again later."));
    },
  );
  void refresh();
  const timer = window.setInterval(() => void refresh(), REFRESH_MS);

  const el = h(
    "div",
    { class: "screen quick" },
    h(
      "section",
      { class: "panel quick-panel" },
      h("header", { class: "quick-head" }, h("h1", null, "Quick play")),
      account ? null : nameField,
      cardBox,
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
      if (waiting) status.textContent = "Finding a match...";
      else status.textContent = attempted ? statusText(state) : "";
      if (state.account && !nameInput.readOnly) {
        nameInput.value = state.account.name;
        nameInput.readOnly = true;
      }
      sync();
    },
    destroy() {
      destroyed = true;
      window.clearInterval(timer);
      el.remove();
    },
  };
};
