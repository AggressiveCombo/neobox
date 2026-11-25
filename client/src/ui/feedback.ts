// Global bug report and suggestion modal + always-accessible top-bar triggers.
// Mounted once on the persistent WIP strip so players can report issues or send
// ideas from any screen (menu, lobby, match, editor, settings) without losing state.

import { errorText } from "../account";
import { sendFeedback, type FeedbackKind } from "../api";
import type { AppCtx } from "../ctx";
import { GAME_MODES } from "../protocol";
import { buildId } from "../version";
import { h } from "./dom";
import { icon } from "./icons";
import { openModal, seg } from "./kit";

const MAX_LEN = 1000;

function captureContext(ctx: AppCtx): { screen: string; context: string; summary: string; name: string } {
  const s = ctx.store.state;
  const screen = s.screen;
  const parts: string[] = [];
  const summaryParts: string[] = [`screen: ${screen}`];

  if (s.room) {
    parts.push(`room=${s.room.code}`);
    summaryParts.push(`room ${s.room.code}`);
    if (s.room.map) {
      parts.push(`map=${s.room.map}`);
      summaryParts.push(`map "${s.room.map}"`);
    }
    const modeNum = s.room.settings["game_mode"];
    if (typeof modeNum === "number") {
      const mName = GAME_MODES.find((m) => m.id === modeNum)?.name ?? String(modeNum);
      parts.push(`mode=${mName}`);
    }
    if (s.inMatch) parts.push("in_match=true");
  }
  const renderer = document.documentElement.dataset.renderer;
  if (renderer) parts.push(`renderer=${renderer}`);
  parts.push(`viewport=${window.innerWidth}x${window.innerHeight}`);
  if (buildId) parts.push(`build=${buildId.slice(0, 12)}`);

  const name = s.account?.name || s.name || "Guest";
  return {
    screen,
    context: parts.join(" | "),
    summary: summaryParts.join(" · "),
    name,
  };
}

export function openFeedbackModal(ctx: AppCtx, initialKind: FeedbackKind): void {
  let kind: FeedbackKind = initialKind;
  let busy = false;
  const snap = captureContext(ctx);

  const textarea = h("textarea", {
    class: "feedback-textarea",
    rows: 5,
    maxlength: MAX_LEN,
    placeholder: "",
    "aria-label": "Details",
  });
  const counter = h("span", { class: "feedback-count" }, `0 / ${MAX_LEN}`);
  const metaLine = h("div", { class: "feedback-meta" }, h("span", null, `Context: ${snap.summary}`), counter);
  const statusEl = h("p", { class: "field-hint feedback-err", role: "alert", hidden: true });

  const submitBtn = h("button", { type: "button", class: "primary", disabled: true }, icon("send", 18), h("span"));
  const submitLabel = submitBtn.lastElementChild as HTMLElement;

  let modal: { close(): void } | null = null;

  const syncKind = (next: FeedbackKind): void => {
    kind = next;
    textarea.placeholder =
      kind === "bug"
        ? "What went wrong? Describe what happened and how to reproduce it..."
        : "What would make neobox better? Share your idea or feature request...";
    submitLabel.textContent = kind === "bug" ? "Send bug report" : "Send suggestion";
    if (titleEl) titleEl.textContent = kind === "bug" ? "Report a bug" : "Send a suggestion";
  };

  const syncInput = (): void => {
    const len = textarea.value.length;
    counter.textContent = `${len} / ${MAX_LEN}`;
    submitBtn.disabled = busy || textarea.value.trim().length === 0;
    if (!statusEl.hidden && textarea.value.trim().length > 0) statusEl.hidden = true;
  };
  textarea.addEventListener("input", syncInput);

  const send = async (): Promise<void> => {
    const message = textarea.value.trim();
    if (!message || busy) return;
    if (!navigator.onLine) {
      statusEl.textContent = "You are offline — connect to the internet to send this.";
      statusEl.hidden = false;
      return;
    }
    busy = true;
    submitBtn.disabled = true;
    statusEl.hidden = true;
    try {
      await sendFeedback({
        kind,
        message,
        screen: snap.screen,
        context: snap.context,
        name: snap.name,
      });
      modal?.close();
      ctx.toast(kind === "bug" ? "Bug report sent — thank you!" : "Suggestion sent — thank you!");
    } catch (err) {
      statusEl.textContent = errorText(err);
      statusEl.hidden = false;
      busy = false;
      syncInput();
    }
  };

  submitBtn.addEventListener("click", () => void send());
  textarea.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  });

  const kindSeg = seg<FeedbackKind>(
    "Feedback type",
    [
      { value: "bug", label: "Bug report", icon: "bug" },
      { value: "suggestion", label: "Suggestion", icon: "lightbulb" },
    ],
    kind,
    (v) => syncKind(v),
  );

  let titleEl: HTMLElement | null = null;
  modal = openModal({
    title: kind === "bug" ? "Report a bug" : "Send a suggestion",
    body: [
      h("div", { class: "feedback-form" }, kindSeg.el, textarea, metaLine, statusEl),
    ],
    actions: [
      submitBtn,
      h("button", { type: "button", onclick: () => modal?.close() }, icon("x", 18), "Cancel"),
    ],
  });
  // Update the dialog title dynamically when toggling between Bug report & Suggestion.
  titleEl = document.querySelector<HTMLElement>("dialog.modal[open] .modal-title");
  syncKind(kind);
  syncInput();
  textarea.focus();
}

/** Mounts always-accessible Bug & Suggest buttons into the top WIP strip. */
export function mountFeedbackBar(ctx: AppCtx): void {
  const wip = document.querySelector<HTMLElement>("[data-wip]");
  if (!wip || wip.querySelector(".wip-actions")) return;
  const bugBtn = h(
    "button",
    {
      type: "button",
      class: "wip-btn",
      id: "wip-bug",
      title: "Report a bug",
      "aria-label": "Report a bug",
      onclick: () => ctx.openFeedback("bug"),
    },
    icon("bug", 12),
    h("span", { class: "wip-btn-lbl" }, "Bug"),
  );
  const suggestBtn = h(
    "button",
    {
      type: "button",
      class: "wip-btn",
      id: "wip-suggest",
      title: "Send a suggestion",
      "aria-label": "Send a suggestion",
      onclick: () => ctx.openFeedback("suggestion"),
    },
    icon("lightbulb", 12),
    h("span", { class: "wip-btn-lbl" }, "Suggest"),
  );
  wip.appendChild(h("div", { class: "wip-actions" }, bugBtn, suggestBtn));
}
