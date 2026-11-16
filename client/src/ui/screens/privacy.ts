// The privacy notice: a long-form page rendered from src/privacy.ts.

import type { ScreenFactory } from "../../ctx";
import { PRIVACY_CONTACT, PRIVACY_SECTIONS, PRIVACY_UPDATED } from "../../privacy";
import type { AppState, Store } from "../../state";
import { h } from "../dom";
import { page, pageHead } from "../kit";
import { icon } from "../icons";
import "./info.css";

export const privacyScreen: ScreenFactory = (ctx) => {
  const head = pageHead({ title: "Privacy", back: () => ctx.store.set({ screen: "menu" }) });
  const el = page(
    "privacy",
    head,
    h("p", { class: "muted small" }, `Last updated ${PRIVACY_UPDATED}. Questions: `, h("a", { href: `mailto:${PRIVACY_CONTACT}` }, PRIVACY_CONTACT)),
    h(
      "article",
      { class: "doc" },
      PRIVACY_SECTIONS.map((s) => h("section", { class: "doc-section" }, h("h2", null, s.heading), s.paragraphs.map((p) => h("p", null, p)))),
    ),
  );

  return {
    el,
    update() {},
    destroy() {
      el.remove();
    },
  };
};

/** A link-styled button to the privacy notice, for footers and forms. */
export function privacyLink(store: Store<AppState>): HTMLButtonElement {
  return h("button", { type: "button", class: "quiet", onclick: () => store.set({ screen: "privacy" }) }, icon("shield", 18), "Privacy");
}
