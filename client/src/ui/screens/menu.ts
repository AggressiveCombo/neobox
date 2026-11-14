// Main menu: name entry (fixed to the account name when signed in), Play (show the
// room browser), Quick play (join or create a room straight away), and links to the
// offline screens, settings and about. Status text follows the connection after a try.

import type { ScreenFactory } from "../../ctx";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import type { AppState } from "../../state";
import { NAME_STORAGE_KEY } from "../../state";
import { h } from "../dom";
import { logoImg } from "../logo";
import { CREDIT_LINE, LICENSE_URL, REPO_URL } from "./about";

/** Keep only allowed characters, cut to the server limit, trim. */
function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _]/g, "").slice(0, MAX_NAME_LEN).trim();
}

function readStoredName(): string {
  try {
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredName(name: string): void {
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
  const quickBtn = h("button", { type: "button", onclick: () => go(true) }, "Quick play");
  const accountBtn = h(
    "button",
    { type: "button", class: "menu-account", onclick: () => store.set({ screen: "account" }) },
    account ? "Account" : "Sign in",
  );
  /** Enable the buttons only when the name is valid. */
  function sync(): void {
    const valid = NAME_RE.test(sanitizeName(nameInput.value));
    playBtn.disabled = !valid;
    quickBtn.disabled = !valid;
  }

  /** Connect with the name; `quick` joins or makes a room as soon as the server welcomes us. */
  function go(quick: boolean): void {
    const name = sanitizeName(nameInput.value);
    if (!NAME_RE.test(name)) return;
    nameInput.value = name;
    writeStoredName(name);
    attempted = true;
    store.set({ name, intent: quick ? "quick" : null });
    ctx.play(name);
  }

  sync();

  const form = h(
    "form",
    {
      class: "menu-form",
      onsubmit: (e: Event) => {
        e.preventDefault();
        go(false);
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

  const el = h(
    "div",
    { class: "screen menu" },
    h(
      "section",
      { class: "panel" },
      h("header", { class: "brand" }, logoImg(64), h("h1", { class: "wordmark" }, "neobox")),
      form,
      status,
      h(
        "nav",
        { class: "menu-links", "aria-label": "more" },
        h("button", { type: "button", onclick: () => store.set({ screen: "library" }) }, "Library"),
        h("button", { type: "button", onclick: () => store.set({ screen: "friends" }) }, "Friends"),
        h("button", { type: "button", onclick: () => store.set({ screen: "practice" }) }, "Practice"),
        h("button", { type: "button", onclick: () => store.set({ screen: "replay" }) }, "Replay"),
        h("button", { type: "button", onclick: () => store.set({ screen: "editor" }) }, "Map editor"),
        h("button", { type: "button", onclick: () => store.set({ screen: "settings" }) }, "Settings"),
        h("button", { type: "button", onclick: () => store.set({ screen: "about" }) }, "About"),
        accountBtn,
      ),
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
      el.remove();
    },
  };
};
