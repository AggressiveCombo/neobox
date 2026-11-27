// The join prompt an invite link opens for a guest: the name to join under, with Join, Sign in and Cancel.
// Cancel and Escape just close it; the caller decides what is left on screen.

import "./invite-prompt.css";
import { h } from "./dom";
import { field, openModal, setFieldError, uid } from "./kit";
import { MAX_NAME_LEN } from "../protocol";
import { nameProblem } from "./screens/menu";

export interface InvitePromptOptions {
  /** The room the invite names. */
  code: string;
  /** What the name field starts with: the guest name kept on this device, or a fresh one. */
  name: string;
  /** A refusal to show under the field (the server's reason for the last join), if any. */
  error?: string;
  onJoin: (name: string) => void;
  onSignIn: () => void;
}

/** Opens the prompt. Join and Sign in each call their callback once, after the prompt has closed. */
export function openInvitePrompt(opts: InvitePromptOptions): void {
  const formId = uid("invite-form");
  const input = h("input", {
    type: "text",
    class: "invite-name-input",
    value: opts.name,
    maxlength: MAX_NAME_LEN,
    autofocus: true,
    autocomplete: "nickname",
    autocapitalize: "off",
    spellcheck: "false",
    enterkeyhint: "go",
  });
  const form = h("form", { class: "invite-form", id: formId, novalidate: true }, field("Your name", input, "1 to 15 letters, numbers, spaces or _."));
  setFieldError(input, opts.error ?? null);
  input.addEventListener("input", () => {
    // Once a problem shows, it follows the text as it is typed.
    if (input.getAttribute("aria-invalid") === "true") setFieldError(input, nameProblem(input.value));
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    const problem = nameProblem(name);
    setFieldError(input, problem);
    if (problem !== null) {
      input.focus();
      return;
    }
    modal.close();
    opts.onJoin(name);
  });

  const cancel = h("button", { type: "button", onclick: () => modal.close() }, "Cancel");
  const signIn = h(
    "button",
    {
      type: "button",
      onclick: () => {
        modal.close();
        opts.onSignIn();
      },
    },
    "Sign in",
  );
  // Outside the form, joined to it by its id: Enter in the field submits the form through this button.
  const join = h("button", { type: "submit", class: "primary", form: formId }, "Join");

  const modal = openModal({ title: `Join room ${opts.code}`, body: [form], actions: [cancel, signIn, join] });
  modal.dialog.classList.add("invite-dialog");
  input.select();
}
