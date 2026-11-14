// Main menu: name entry (fixed to the account name when signed in), Play (show the
// room browser), Quick play and Training, the news button, live players-online and
// top-makers lines, music and fullscreen toggles, and links to the other screens.
// Shared match clips play behind the panel. Status text follows the connection after a try.

import { listMakers } from "../../account";
import { fetchStats } from "../../api";
import type { ScreenFactory } from "../../ctx";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { prefs } from "../../prefs";
import type { AppState } from "../../state";
import { NAME_STORAGE_KEY } from "../../state";
import { h } from "../dom";
import { logoImg } from "../logo";
import { mountMenuClips } from "../menu-clips";
import { hasUnreadNews, openNews } from "../news";
import { CREDIT_LINE, LICENSE_URL, REPO_URL } from "./about";

const STATS_REFRESH_MS = 10_000;

/** Keep only allowed characters, cut to the server limit, trim. */
export function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _]/g, "").slice(0, MAX_NAME_LEN).trim();
}

export function readStoredName(): string {
  try {
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredName(name: string): void {
  try {
    window.localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Storage blocked (private mode, quota): the name still applies to this session.
  }
}

function statusText(state: AppState): string {
  if (state.connection === "connecting") return "Connecting…";
  if (state.connection === "open") return "Connected.";
  return state.connectDetail ? `Disconnected: ${state.connectDetail}` : "Disconnected.";
}

export const menuScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  let attempted = false;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const onlineLine = h("p", { class: "menu-online" });
  const makersLine = h("p", { class: "menu-makers", hidden: true });

  // Signed-in accounts play under their account name, which cannot be edited here.
  const account = store.state.account;
  const initialName = account?.name ?? (store.state.name || readStoredName());

  const nameInput = h("input", {
    type: "text",
    placeholder: "name",
    maxlength: MAX_NAME_LEN,
    autocomplete: "nickname",
    spellcheck: "false",
    "aria-label": "name",
    value: initialName,
    readonly: account !== null,
    oninput: () => {
      sync();
    },
  });

  const playBtn = h("button", { type: "submit", class: "primary" }, "Play");
  const quickBtn = h("button", { type: "button", onclick: () => store.set({ screen: "quick" }) }, "Quick play");
  const accountBtn = h(
    "button",
    { type: "button", class: "menu-account", onclick: () => store.set({ screen: "account" }) },
    account ? "Account" : "Sign in",
  );
  const newsBtn = h(
    "button",
    {
      type: "button",
      class: "menu-news",
      onclick: () => {
        openNews();
        newsBtn.textContent = hasUnreadNews() ? "* News *" : "News";
      },
    },
    hasUnreadNews() ? "* News *" : "News",
  );
  const muteBtn = h("button", {
    type: "button",
    class: "menu-mute",
    onclick: () => prefs.set({ musicMuted: !prefs.value.musicMuted }),
  });
  const fullscreenBtn = h("button", {
    type: "button",
    class: "menu-fullscreen",
    hidden: !document.fullscreenEnabled,
    onclick: () => toggleFullscreen(),
  });

  /** Enable the play button only when the name is valid. */
  function sync(): void {
    playBtn.disabled = !NAME_RE.test(sanitizeName(nameInput.value));
  }

  /** Connect with the name and show the room browser once the server welcomes us. */
  function go(): void {
    const name = sanitizeName(nameInput.value);
    if (!NAME_RE.test(name)) return;
    nameInput.value = name;
    writeStoredName(name);
    attempted = true;
    store.set({ name, intent: null });
    ctx.play(name);
  }

  function syncMute(): void {
    muteBtn.textContent = prefs.value.musicMuted ? "Unmute music" : "Mute music";
  }

  function toggleFullscreen(): void {
    const request =
      document.fullscreenElement !== null ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    // The browser refuses without a user gesture or when the page is already in the state asked for.
    request.catch(() => undefined);
  }

  function syncFullscreen(): void {
    fullscreenBtn.textContent = document.fullscreenElement !== null ? "Exit fullscreen" : "Fullscreen";
  }

  async function refreshStats(): Promise<void> {
    try {
      const s = await fetchStats();
      onlineLine.textContent = `${s.online} ${s.online === 1 ? "player" : "players"} online`;
    } catch {
      // Keep the last number; the next tick retries.
    }
  }

  async function loadMakers(): Promise<void> {
    try {
      const makers = await listMakers();
      makersLine.textContent = `Top map makers this week: ${makers.map((m) => m.name).join(" · ")}`;
      makersLine.hidden = makers.length === 0;
    } catch {
      makersLine.hidden = true;
    }
  }

  sync();
  syncMute();
  syncFullscreen();
  void refreshStats();
  void loadMakers();
  const statsTimer = window.setInterval(() => void refreshStats(), STATS_REFRESH_MS);
  const unsubPrefs = prefs.subscribe(() => syncMute());
  document.addEventListener("fullscreenchange", syncFullscreen);

  const form = h(
    "form",
    {
      class: "menu-form",
      onsubmit: (e: Event) => {
        e.preventDefault();
        go();
      },
    },
    h(
      "label",
      { class: "field" },
      h("span", { class: "field-label" }, account ? "Signed in as" : "Name"),
      nameInput,
    ),
    h("div", { class: "actions" }, playBtn, quickBtn),
  );

  const backdrop = h("div", { class: "menu-backdrop", "aria-hidden": "true" });
  const unmountClips = mountMenuClips(ctx, backdrop);

  const el = h(
    "div",
    { class: "screen menu" },
    backdrop,
    h(
      "section",
      { class: "panel" },
      h("header", { class: "brand" }, logoImg(64), h("h1", { class: "wordmark" }, "neobox")),
      onlineLine,
      form,
      status,
      h(
        "nav",
        { class: "menu-links", "aria-label": "more" },
        h("button", { type: "button", onclick: () => store.set({ screen: "training" }) }, "Training"),
        h("button", { type: "button", onclick: () => store.set({ screen: "library" }) }, "Library"),
        h("button", { type: "button", onclick: () => store.set({ screen: "friends" }) }, "Friends"),
        h("button", { type: "button", onclick: () => store.set({ screen: "practice" }) }, "Practice"),
        h("button", { type: "button", onclick: () => store.set({ screen: "replay" }) }, "Replay"),
        h("button", { type: "button", onclick: () => store.set({ screen: "editor" }) }, "Map editor"),
        h("button", { type: "button", onclick: () => store.set({ screen: "settings" }) }, "Settings"),
        h("button", { type: "button", onclick: () => store.set({ screen: "about" }) }, "About"),
        newsBtn,
        accountBtn,
      ),
      h("div", { class: "menu-tools" }, muteBtn, fullscreenBtn),
      makersLine,
      h("p", { class: "credit" }, CREDIT_LINE),
      h(
        "footer",
        { class: "links" },
        h("a", { href: REPO_URL, target: "_blank", rel: "noopener" }, "Source"),
        " · ",
        h("a", { href: LICENSE_URL, target: "_blank", rel: "noopener" }, "AGPL-3.0-or-later"),
      ),
    ),
  );

  return {
    el,
    update(state) {
      status.textContent = attempted ? statusText(state) : "";
      accountBtn.textContent = state.account ? "Account" : "Sign in";
      if (state.account) {
        nameInput.value = state.account.name;
        nameInput.readOnly = true;
        sync();
      }
    },
    destroy() {
      window.clearInterval(statsTimer);
      unsubPrefs();
      document.removeEventListener("fullscreenchange", syncFullscreen);
      unmountClips();
      el.remove();
    },
  };
};
