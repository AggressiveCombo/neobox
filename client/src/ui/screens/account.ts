// Account screen: sign in or create an account (guests), and for signed-in players
// change the password, sign out or delete the account. Signing in or out re-opens a
// live connection so the server knows the new identity.

import { applyAccount, changePassword, deleteAccount, errorText, login, logout, register, returnScreen } from "../../account";
import type { AppCtx, ScreenFactory } from "../../ctx";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { type Account, type AppState } from "../../state";
import { h } from "../dom";

const NAME_HINT = "Names are 1 to 15 letters, numbers, spaces or _.";

function field(label: string, input: HTMLInputElement): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input);
}

function passwordInput(label: string, autocomplete: string): HTMLInputElement {
  return h("input", { type: "password", autocomplete, "aria-label": label, placeholder: label, spellcheck: "false" });
}

/** A notice with a button to the account screen, for screens that need a signed-in player. */
export function signInPrompt(ctx: AppCtx, text: string): HTMLElement {
  return h(
    "div",
    { class: "sign-in-prompt" },
    h("p", { class: "status" }, text),
    h("button", { type: "button", class: "primary", onclick: () => ctx.store.set({ screen: "account" }) }, "Sign in"),
  );
}

export const accountScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  const body = h("div", { class: "social-body" });
  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  let busy = false;
  let shownId: number | null | undefined;

  /** Run one account action: a server error goes to the status line; success sets `ok`. */
  async function act(run: () => Promise<void>, ok: string): Promise<boolean> {
    if (busy) return false;
    busy = true;
    status.textContent = "";
    try {
      await run();
      status.textContent = ok;
      return true;
    } catch (err) {
      status.textContent = errorText(err);
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
      placeholder: "name",
    });
    const password = passwordInput("password", "current-password");

    /** Validated name and password, or null with the problem in the status line. */
    function credentials(): { name: string; password: string } | null {
      const who = name.value.trim();
      if (!NAME_RE.test(who)) {
        status.textContent = NAME_HINT;
        return null;
      }
      if (password.value === "") {
        status.textContent = "Enter a password.";
        return null;
      }
      return { name: who, password: password.value };
    }

    function signIn(e: Event): void {
      e.preventDefault();
      const creds = credentials();
      if (creds === null) return;
      void act(async () => {
        applyAccount(ctx, await login(creds.name, creds.password));
      }, "Signed in.");
    }

    function createAccount(): void {
      const creds = credentials();
      if (creds === null) return;
      void act(async () => {
        applyAccount(ctx, await register(creds.name, creds.password));
      }, "Account created.");
    }

    return h(
      "div",
      { class: "social-section" },
      h("p", { class: "credit" }, "Sign in to keep your settings on any device, add friends and publish maps."),
      h(
        "form",
        { class: "social-form", onsubmit: signIn },
        field("Name", name),
        field("Password", password),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "submit", class: "primary" }, "Sign in"),
          h("button", { type: "button", onclick: createAccount }, "Create account"),
        ),
      ),
    );
  }

  function memberView(account: Account): HTMLElement {
    const oldPassword = passwordInput("current password", "current-password");
    const newPassword = passwordInput("new password", "new-password");
    const deletePassword = passwordInput("password", "current-password");

    function changeSubmit(e: Event): void {
      e.preventDefault();
      if (newPassword.value === "") {
        status.textContent = "Enter a new password.";
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
      if (deletePassword.value === "") {
        status.textContent = "Enter your password to delete the account.";
        return;
      }
      void act(async () => {
        await deleteAccount(deletePassword.value);
        applyAccount(ctx, null);
      }, "Account deleted.");
    }

    return h(
      "div",
      { class: "social-section" },
      h("p", null, "Signed in as ", h("strong", null, account.name), "."),
      h(
        "form",
        { class: "social-form", onsubmit: changeSubmit },
        h("h2", null, "Change password"),
        field("Current password", oldPassword),
        field("New password", newPassword),
        h("div", { class: "actions" }, h("button", { type: "submit" }, "Change password")),
      ),
      h(
        "div",
        { class: "social-form" },
        h("h2", null, "Sign out"),
        h("p", { class: "credit" }, "Your settings stay on this device."),
        h("div", { class: "actions" }, h("button", { type: "button", onclick: signOut }, "Sign out")),
      ),
      h(
        "form",
        { class: "social-form danger-zone", onsubmit: deleteSubmit },
        h("h2", null, "Delete account"),
        h("p", { class: "credit" }, "Deletes your account, friends and uploaded maps. This can't be undone."),
        field("Password", deletePassword),
        h("div", { class: "actions" }, h("button", { type: "submit", class: "danger" }, "Delete account")),
      ),
    );
  }

  function render(state: AppState): void {
    shownId = state.account?.id ?? null;
    body.replaceChildren(state.account ? memberView(state.account) : guestView());
    status.textContent = "";
  }

  const back = h(
    "button",
    { type: "button", class: "back", onclick: () => store.set({ screen: returnScreen(store.state) }) },
    "Back",
  );

  const el = h(
    "div",
    { class: "screen social-screen account-screen" },
    h(
      "section",
      { class: "panel" },
      h("header", { class: "social-head" }, back, h("h1", { class: "social-title" }, "Account")),
      body,
      status,
    ),
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
