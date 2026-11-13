// Main menu: name entry, Play (connect and show the room browser), About,
// connection status after a Play attempt, credit line and links.

import type { ScreenFactory } from "../../ctx";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { NAME_STORAGE_KEY, type AppState } from "../../state";
import { h } from "../dom";
import { logoSvg } from "../logo";
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

  const initialName = store.state.name || readStoredName();
  const nameInput = h("input", {
    type: "text",
    placeholder: "name",
    maxlength: MAX_NAME_LEN,
    autocomplete: "nickname",
    spellcheck: "false",
    "aria-label": "name",
    value: initialName,
    oninput: () => {
      playBtn.disabled = !NAME_RE.test(sanitizeName(nameInput.value));
    },
  });

  const playBtn = h("button", {
    type: "submit",
    class: "primary",
    disabled: !NAME_RE.test(sanitizeName(initialName)),
  }, "Play");

  function onPlay(e: Event): void {
    e.preventDefault();
    const name = sanitizeName(nameInput.value);
    if (!NAME_RE.test(name)) return;
    nameInput.value = name;
    writeStoredName(name);
    attempted = true;
    store.set({ name });
    ctx.play(name);
  }

  const form = h(
    "form",
    { class: "menu-form", onsubmit: onPlay },
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Name"), nameInput),
    h(
      "div",
      { class: "actions" },
      playBtn,
      h("button", { type: "button", onclick: () => store.set({ screen: "about" }) }, "About"),
    ),
  );

  const el = h(
    "div",
    { class: "screen menu" },
    h(
      "section",
      { class: "panel" },
      h("header", { class: "brand" }, logoSvg(64), h("h1", { class: "wordmark" }, "neobox")),
      form,
      status,
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
    },
    destroy() {
      el.remove();
    },
  };
};
