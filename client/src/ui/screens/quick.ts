// Quick play, as the original's quick menu: one tile per mode of the server's rotation
// (/api/rotation, the original's maps2.json), with its title, the players playing in it
// (refreshed every 30 s like playercount.json), its description and a carousel of its map
// rotation. Play starts a match in that mode. Not connected yet: the name is sent with the
// connect and the mode is kept in state.intent, so app.ts starts quick play once the server
// welcomes us.

import { fetchQuickModes, fetchStats, type QuickMode } from "../../api";
import type { ScreenFactory } from "../../ctx";
import { MAX_NAME_LEN } from "../../protocol";
import type { AppState } from "../../state";
import { h } from "../dom";
import { field, loading, page, pageHead } from "../kit";
import { icon } from "../icons";
import { previewCode } from "../map-list";
import { nameProblem, readStoredName, saveTypedName, writeStoredName } from "./menu";

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
  /** Whether the matching loader and Cancel are in the wait box. */
  let waitShown = false;
  /** Set once the transport starts connecting, so an earlier "closed" state is not read as a failure. */
  let sawConnecting = false;
  let counts: Record<string, number> | null = null;
  let destroyed = false;

  const account = store.state.account;
  const status = h("p", { class: "quick-status", role: "status", "aria-live": "polite" });
  const waitBox = h("div", { class: "quick-wait" });

  const nameInput = h("input", {
    type: "text",
    placeholder: "name",
    maxlength: MAX_NAME_LEN,
    autocomplete: "nickname",
    spellcheck: "false",
    value: account?.name ?? (store.state.name || readStoredName()),
    readonly: account !== null,
    oninput: () => {
      sync();
      saveTypedName(nameInput.value);
    },
    onblur: () => sync(),
  });
  const nameError = h("p", { class: "field-error", role: "alert", hidden: true });
  const nameBlock = h("div", { class: "quick-name" }, field("Name", nameInput), nameError);

  const cards = new Map<string, Card>();
  const cardBox = h("div", { class: "quick-cards" }, h("p", { class: "muted" }, "Loading…"));

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
    const caption = h("p", { class: "quick-map-name", "aria-live": "polite" });
    if (maps.length === 1) {
      const only = h("div", { class: "quick-thumbs" }, thumb(maps[0]!));
      only.children[0]?.classList.add("quick-thumb-mid");
      caption.textContent = maps[0]!.author ? `${maps[0]!.name} by ${maps[0]!.author}` : maps[0]!.name;
      return h("div", { class: "quick-maps" }, only, caption);
    }
    let at = 0;
    const thumbs = h("div", { class: "quick-thumbs" });
    const draw = (): void => {
      const n = maps.length;
      thumbs.replaceChildren(thumb(maps[(at + n - 1) % n]!), thumb(maps[at]!), thumb(maps[(at + 1) % n]!));
      thumbs.children[1]?.classList.add("quick-thumb-mid");
      const current = maps[at]!;
      caption.textContent = current.author ? `${current.name} by ${current.author}` : current.name;
    };
    const step = (d: number) => (): void => {
      at = (at + d + maps.length) % maps.length;
      draw();
    };
    draw();
    return h(
      "div",
      { class: "quick-carousel" },
      h(
        "div",
        { class: "quick-maps" },
        h("button", { type: "button", class: "quick-arrow", "aria-label": `Previous ${mode.title} map`, onclick: step(-1) }, icon("arrow-left", 20)),
        thumbs,
        h("button", { type: "button", class: "quick-arrow", "aria-label": `Next ${mode.title} map`, onclick: step(1) }, icon("arrow-right", 20)),
      ),
      caption,
    );
  }

  function buildCards(modes: QuickMode[]): void {
    cards.clear();
    if (modes.length === 0) {
      cardBox.replaceChildren(h("p", { class: "muted" }, "This server has no quick play."));
      return;
    }
    cardBox.replaceChildren(
      ...modes.map((mode) => {
        const count = h("p", { class: "quick-count num" }, "");
        const playButton = h(
          "button",
          { type: "button", class: "primary quick-choose", onclick: () => choose(mode.id) },
          icon("play", 18),
          `Play ${mode.title}`,
        );
        const el = h(
          "article",
          { class: "quick-card" },
          h("div", { class: "quick-card-head" }, h("h2", null, mode.title), count),
          h("p", { class: "quick-text", title: mode.description }, mode.description),
          carousel(mode),
          playButton,
        );
        cards.set(mode.id, { el, choose: playButton, count });
        return el;
      }),
    );
    renderCounts();
    sync();
  }

  /** Cards need a valid name unless the account supplies one. The reason shows next to them while they are disabled. */
  function sync(): void {
    const problem = account !== null ? null : nameProblem(nameInput.value);
    for (const card of cards.values()) {
      card.choose.disabled = problem !== null || waiting;
    }
    nameError.textContent = problem ?? "";
    nameError.hidden = problem === null;
    renderStatus();
  }

  function renderCounts(): void {
    for (const [id, card] of cards) card.count.textContent = `${counts?.[id] ?? 0} playing`;
  }

  /** While matching: the loader and Cancel. Otherwise the connection state after an attempt. */
  function renderStatus(state?: AppState): void {
    if (waiting) {
      // Built once per wait: every store update passes through here, and a rebuilt Cancel loses clicks and focus.
      if (!waitShown) {
        waitBox.replaceChildren(
          loading("Finding a room…"),
          h("button", { type: "button", class: "quiet", onclick: () => cancel() }, "Cancel"),
        );
        waitShown = true;
      }
      status.textContent = "";
      return;
    }
    if (waitShown) {
      waitBox.replaceChildren();
      waitShown = false;
    }
    status.textContent = attempted ? statusText(state ?? store.state) : "";
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
    sync();
    if (store.state.connection === "open") {
      ctx.quickPlay(queue);
      return;
    }
    const name = account?.name ?? nameInput.value.trim();
    if (!account && nameProblem(name) !== null) {
      waiting = false;
      sync();
      return;
    }
    nameInput.value = name;
    if (!account) writeStoredName(name);
    attempted = true;
    store.set({ name, intent: queue });
    ctx.play(name);
  }

  function cancel(): void {
    if (!waiting) return;
    waiting = false;
    ctx.disconnect();
    store.set({ intent: null });
    sync();
  }

  function back(): void {
    if (waiting) {
      cancel();
      return;
    }
    store.set({ screen: store.state.connection === "open" ? "browse" : "menu" });
  }

  void quickModes().then(
    (modes) => {
      if (!destroyed) buildCards(modes);
    },
    () => {
      if (!destroyed) cardBox.replaceChildren(h("p", { class: "muted" }, "Could not load quick play. Try again later."));
    },
  );
  void refresh();
  const timer = window.setInterval(() => void refresh(), REFRESH_MS);

  const head = pageHead({ title: "Quick play", back: () => back() });
  const el = page(
    "quick",
    head,
    account ? null : nameBlock,
    cardBox,
    waitBox,
    status,
  );

  renderStatus();

  return {
    el,
    update(state) {
      if (state.connection === "connecting") sawConnecting = true;
      // A connection that started and then closed before a room was found: report it and allow a retry.
      if (waiting && sawConnecting && state.connection === "closed") {
        waiting = false;
      }
      if (state.account && !nameInput.readOnly) {
        nameInput.value = state.account.name;
        nameInput.readOnly = true;
      }
      sync();
      renderStatus(state);
    },
    destroy() {
      destroyed = true;
      window.clearInterval(timer);
      el.remove();
    },
  };
};
