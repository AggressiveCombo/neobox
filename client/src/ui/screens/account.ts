// Account screen: signed out, one form signs in or creates an account. Signed in, the
// profile (level and XP) leads, with Security (password, delete), friends and sign out beside it.
// Signing in or out re-opens the live connection so the server knows the identity.

import { applyAccount, changePassword, deleteAccount, errorText, login, register, returnScreen, signOutAccount } from "../../account";
import type { AppCtx, ScreenFactory } from "../../ctx";
import { guestXp, levelOf, xpForLevel } from "../../levels";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { type Account, type AppState } from "../../state";
import { h, type Child } from "../dom";
import { icon } from "../icons";
import { field, page, pageHead, setFieldError, toggle } from "../kit";
import { profileSummary } from "../profile";
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

/** One line of the perks list: an icon, then what the account adds. */
function perk(name: Parameters<typeof icon>[0], text: string): HTMLElement {
  return h("li", { class: "account-perk" }, h("span", { class: "account-perk-icon" }, icon(name, 18)), h("span", null, text));
}

/** A panel that asks for a signed-in player, with a button to the account screen. */
export function signInPrompt(ctx: AppCtx, text: string): HTMLElement {
  return h(
    "section",
    { class: "panel sign-in-prompt" },
    h("p", { class: "lead" }, text),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "primary", onclick: () => ctx.store.set({ screen: "account" }) }, icon("log-in", 18), "Sign in"),
    ),
  );
}

export const accountScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  const body = h("div", { class: "account-body" });
  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  let busy = false;
  let shownId: number | null | undefined;

  function say(text: string, error = false): void {
    // The same message again (a repeated press on an invalid form) would look unchanged: flash the line so the press shows.
    const again = text !== "" && status.textContent === text;
    status.textContent = text;
    // A failed form's message sits under the fold on a tall panel: bring it into view, or the press shows nothing.
    if (error) status.scrollIntoView({ block: "nearest" });
    status.classList.toggle("field-error", error);
    if (again) {
      status.classList.remove("is-repeat");
      void status.offsetWidth;
      status.classList.add("is-repeat");
    }
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

    /** Validated name and password, or null with each problem under its field. */
    function credentials(): { name: string; password: string } | null {
      const who = name.value.trim();
      setFieldError(name, null);
      setFieldError(password, null);
      if (!NAME_RE.test(who)) {
        setFieldError(name, NAME_ERROR);
        name.focus();
        return null;
      }
      if (password.value === "") {
        setFieldError(password, "Enter a password.");
        password.focus();
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
        setFieldError(password, PASSWORD_ERROR);
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
        "form",
        { class: "panel account-form", onsubmit: signIn },
        h("h2", null, icon("log-in", 20), "Sign in"),
        field("Name", name, "1 to 15 letters, numbers, spaces or _."),
        field("Password", password, PASSWORD_HINT),
        toggle("Stay signed in", false, (on) => {
          remember = on;
        }),
        h(
          "div",
          { class: "actions account-submit" },
          h("button", { type: "submit", class: "primary" }, icon("log-in", 18), "Sign in"),
          h("button", { type: "button", onclick: createAccount }, icon("user-plus", 18), "Create account"),
        ),
        status,
        h("div", { class: "account-foot" }, privacyLink(store)),
      ),
      h(
        "section",
        { class: "account-aside" },
        h("h2", null, icon("star", 20), "Your level"),
        levelMeter(guestXp()),
        h(
          "ul",
          { class: "account-perks" },
          perk("settings", "Settings on any device"),
          perk("users", "Friends and who is online"),
          perk("map", "Upload, vote and star maps"),
        ),
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
      setFieldError(newPassword, null);
      if (!passwordOk(newPassword.value)) {
        setFieldError(newPassword, newPassword.value === "" ? "Enter a new password." : PASSWORD_ERROR);
        return;
      }
      void act(() => changePassword(oldPassword.value, newPassword.value), "Password changed.").then((done) => {
        if (done) {
          oldPassword.value = "";
          newPassword.value = "";
        }
      });
    }

    function deleteSubmit(e: Event): void {
      e.preventDefault();
      setFieldError(confirmName, null);
      setFieldError(deletePassword, null);
      if (confirmName.value.trim() !== account.name) {
        setFieldError(confirmName, `Type your name, ${account.name}, to confirm.`);
        return;
      }
      if (deletePassword.value === "") {
        setFieldError(deletePassword, "Enter your password to delete the account.");
        return;
      }
      void act(async () => {
        await deleteAccount(deletePassword.value);
        applyAccount(ctx, null);
      }, "Account deleted.");
    }

    const security = h(
      "details",
      { class: "panel account-security", open: true },
      h("summary", null, icon("shield", 18), h("span", null, "Security"), icon("chevron-down", 18)),
      h(
        "div",
        { class: "account-security-body" },
        h(
          "form",
          { class: "account-subform", onsubmit: changeSubmit },
          h("h3", null, icon("key-round", 20), "Change password"),
          field("Current password", oldPassword),
          field("New password", newPassword, PASSWORD_HINT),
          h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, icon("key-round", 18), "Change password")),
        ),
        h(
          "form",
          { class: "account-subform danger-zone", onsubmit: deleteSubmit },
          h("h3", null, icon("trash-2", 20), "Delete account"),
          h("p", { class: "field-hint" }, "Deletes your account, friends and uploaded maps. This can't be undone."),
          field("Your name, to confirm", confirmName),
          field("Password", deletePassword),
          h("div", { class: "actions" }, h("button", { type: "submit", class: "danger" }, icon("trash-2", 18), "Delete account")),
        ),
      ),
    );

    const signOutBtn = h("button", { type: "button", class: "quiet", onclick: signOut }, icon("log-out", 18), "Sign out");

    return h(
      "div",
      { class: "account-member" },
      h(
        "section",
        { class: "panel account-profile" },
        h("h2", { class: "sr-only" }, "Profile"),
        profileSummary(account.name),
      ),
      security,
      h(
        "section",
        { class: "panel account-session" },
        h("h2", { class: "panel-title" }, icon("user", 20), "Account"),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "quiet", onclick: () => store.set({ screen: "friends" }) }, icon("users", 18), "Friends"),
          signOutBtn,
        ),
      ),
      status,
    );
  }

  function render(state: AppState): void {
    shownId = state.account?.id ?? null;
    body.replaceChildren(state.account ? memberView(state.account) : guestView());
    say("");
  }

  function signOut(): void {
    void act(async () => {
      await signOutAccount(ctx);
      applyAccount(ctx, null);
    }, "Signed out.");
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
