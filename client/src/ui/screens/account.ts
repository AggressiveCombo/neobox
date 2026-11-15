// Account screen: signed out, one form signs in or creates an account. Signed in, the
// profile (level and XP) sits beside the forms: change password, sign out, delete the
// account. Signing in or out re-opens the live connection so the server knows the identity.

import { applyAccount, changePassword, deleteAccount, errorText, login, logout, register, returnScreen } from "../../account";
import type { AppCtx, ScreenFactory } from "../../ctx";
import { guestXp, levelOf, xpForLevel } from "../../levels";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { type Account, type AppState } from "../../state";
import { h, type Child } from "../dom";
import { avatar, field, page, pageHead, toggle } from "../kit";
import { privacyLink } from "./privacy";

const NAME_ERROR = "Names are 1 to 15 letters, numbers, spaces or _.";
const PASSWORD_HINT = "8 to 128 characters.";
const PASSWORD_ERROR = "Passwords are 8 to 128 characters.";
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function passwordInput(autocomplete: string, label: string): HTMLInputElement {
  return h("input", { type: "password", autocomplete, spellcheck: "false", "aria-label": label });
}

/** A password is 8 to 128 characters (counted as the server counts them). */
function passwordOk(value: string): boolean {
  const n = [...value].length;
  return n >= PASSWORD_MIN && n <= PASSWORD_MAX;
}

/** Level, and the XP meter toward the next level. */
function levelMeter(xp: number): HTMLElement {
  const level = levelOf(xp);
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  const pct = Math.min(100, ((xp - from) / (to - from)) * 100);
  const fill = h("span");
  fill.style.width = `${pct}%`;
  return h(
    "div",
    { class: "account-level" },
    h("p", { class: "account-level-num num" }, `Level ${level}`),
    h(
      "div",
      { class: "meter", role: "progressbar", "aria-label": "Progress to the next level", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)) },
      fill,
    ),
    h("p", { class: "field-hint num" }, `${xp - from} of ${to - from} XP to level ${level + 1}`),
  );
}

/** A panel that asks for a signed-in player, with a button to the account screen. */
export function signInPrompt(ctx: AppCtx, text: string): HTMLElement {
  return h(
    "section",
    { class: "panel sign-in-prompt" },
    h("p", { class: "lead" }, text),
    h("div", { class: "actions" }, h("button", { type: "button", class: "primary", onclick: () => ctx.store.set({ screen: "account" }) }, "Sign in")),
  );
}

export const accountScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  const body = h("div", { class: "account-body" });
  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  let busy = false;
  let shownId: number | null | undefined;

  function say(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle("field-error", error);
  }

  /** Run one account action: a server error goes to the status line; success shows `ok`. */
  async function act(run: () => Promise<void>, ok: string): Promise<boolean> {
    if (busy) return false;
    busy = true;
    say("");
    try {
      await run();
      say(ok);
      return true;
    } catch (err) {
      say(errorText(err), true);
      return false;
    } finally {
      busy = false;
    }
  }

  function guestView(): HTMLElement {
    const name = h("input", {
      type: "text",
      maxlength: MAX_NAME_LEN,
      autocomplete: "username",
      spellcheck: "false",
      "aria-label": "name",
    });
    const password = passwordInput("current-password", "password");
    // off by default: the session ends with the browser
    let remember = false;

    /** Validated name and password, or null with the problem in the status line. */
    function credentials(): { name: string; password: string } | null {
      const who = name.value.trim();
      if (!NAME_RE.test(who)) {
        say(NAME_ERROR, true);
        return null;
      }
      if (password.value === "") {
        say("Enter a password.", true);
        return null;
      }
      return { name: who, password: password.value };
    }

    function signIn(e: Event): void {
      e.preventDefault();
      const creds = credentials();
      if (creds === null) return;
      void act(async () => {
        applyAccount(ctx, await login(creds.name, creds.password, remember));
      }, "Signed in.");
    }

    function createAccount(): void {
      const creds = credentials();
      if (creds === null) return;
      if (!passwordOk(creds.password)) {
        say(PASSWORD_ERROR, true);
        return;
      }
      void act(async () => {
        applyAccount(ctx, await register(creds.name, creds.password, remember));
      }, "Account created.");
    }

    return h(
      "div",
      { class: "account-guest" },
      h(
        "section",
        { class: "section account-pitch" },
        h("h2", null, "Why sign in?"),
        h(
          "ul",
          { class: "boxed-list" },
          h("li", null, "Your settings follow you to any device."),
          h("li", null, "Add friends and see when they are online."),
          h("li", null, "Upload maps, vote and star them in the library."),
        ),
        levelMeter(guestXp()),
      ),
      h(
        "form",
        { class: "panel account-form", onsubmit: signIn },
        h("h2", null, "Sign in or create an account"),
        field("Name", name, "1 to 15 letters, numbers, spaces or _."),
        field("Password", password, PASSWORD_HINT),
        toggle("Stay signed in", false, (on) => {
          remember = on;
        }),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "submit", class: "primary" }, "Sign in"),
          h("button", { type: "button", onclick: createAccount }, "Create account"),
          privacyLink(store),
        ),
        status,
      ),
    );
  }

  function memberView(account: Account): HTMLElement {
    const oldPassword = passwordInput("current-password", "current password");
    const newPassword = passwordInput("new-password", "new password");
    const deletePassword = passwordInput("current-password", "password");
    const confirmName = h("input", { type: "text", autocomplete: "off", spellcheck: "false", "aria-label": "your name" });

    function changeSubmit(e: Event): void {
      e.preventDefault();
      if (!passwordOk(newPassword.value)) {
        say(newPassword.value === "" ? "Enter a new password." : PASSWORD_ERROR, true);
        return;
      }
      void act(() => changePassword(oldPassword.value, newPassword.value), "Password changed.").then((done) => {
        if (done) {
          oldPassword.value = "";
          newPassword.value = "";
        }
      });
    }

    function signOut(): void {
      void act(async () => {
        await logout();
        applyAccount(ctx, null);
      }, "Signed out.");
    }

    function deleteSubmit(e: Event): void {
      e.preventDefault();
      if (confirmName.value.trim() !== account.name) {
        say(`Type your name, ${account.name}, to confirm.`, true);
        return;
      }
      if (deletePassword.value === "") {
        say("Enter your password to delete the account.", true);
        return;
      }
      void act(async () => {
        await deleteAccount(deletePassword.value);
        applyAccount(ctx, null);
      }, "Account deleted.");
    }

    const profile: Child[] = [
      h(
        "div",
        { class: "account-id" },
        avatar(account.name, null),
        h("div", null, h("p", { class: "field-hint" }, "Signed in as"), h("h2", { class: "account-name" }, account.name)),
      ),
      levelMeter(account.xp),
    ];

    return h(
      "div",
      { class: "account-member" },
      h("section", { class: "panel account-profile" }, ...profile),
      h(
        "div",
        { class: "account-forms" },
        h(
          "form",
          { class: "panel account-form", onsubmit: changeSubmit },
          h("h2", null, "Change password"),
          field("Current password", oldPassword),
          field("New password", newPassword, PASSWORD_HINT),
          h("div", { class: "actions" }, h("button", { type: "submit" }, "Change password")),
        ),
        h(
          "section",
          { class: "section" },
          h("h2", null, "Sign out"),
          h("p", { class: "field-hint" }, "Your settings stay on this device."),
          h("div", { class: "actions" }, h("button", { type: "button", onclick: signOut }, "Sign out")),
        ),
        h(
          "form",
          { class: "panel danger-panel", onsubmit: deleteSubmit },
          h("h2", null, "Delete account"),
          h("p", { class: "field-hint" }, "Deletes your account, friends and uploaded maps. This can't be undone."),
          field("Your name, to confirm", confirmName),
          field("Password", deletePassword),
          h("div", { class: "actions" }, h("button", { type: "submit", class: "danger" }, "Delete account")),
        ),
        status,
      ),
    );
  }

  function render(state: AppState): void {
    shownId = state.account?.id ?? null;
    body.replaceChildren(state.account ? memberView(state.account) : guestView());
    say("");
  }

  const el = page(
    "account-page",
    pageHead({ title: "Account", back: () => store.set({ screen: returnScreen(store.state) }) }),
    body,
  );

  render(store.state);

  return {
    el,
    update(state) {
      if ((state.account?.id ?? null) !== shownId) render(state);
    },
    destroy() {
      el.remove();
    },
  };
};
