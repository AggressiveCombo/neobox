// Legal pages (privacy notice, terms of use): long-form English text, rendered from src/privacy.ts and src/terms.ts.

import type { AppCtx, ScreenFactory, ScreenHandle } from "../../ctx";
import { PRIVACY_CONTACT, PRIVACY_SECTIONS, PRIVACY_UPDATED, type LegalSection } from "../../privacy";
import type { AppState, Store } from "../../state";
import { h } from "../dom";
import { page, pageHead } from "../kit";
import { icon } from "../icons";
import "./info.css";

/** A long-form legal page. */
export function legalScreen(
  ctx: AppCtx,
  id: string,
  title: string,
  updated: string,
  sections: LegalSection[],
): ScreenHandle {
  const meta = h(
    "p",
    { class: "muted small" },
    `Last updated ${updated}. Questions: `,
    h("a", { href: `mailto:${PRIVACY_CONTACT}` }, PRIVACY_CONTACT),
  );
  const article = h(
    "article",
    { class: "doc" },
    ...sections.map((s) => h("section", { class: "doc-section" }, h("h2", null, s.heading), ...s.paragraphs.map((p) => h("p", null, p)))),
  );

  const head = pageHead({ title, back: () => ctx.store.set({ screen: "menu" }) });
  const el = page(id, head, h("div", { class: "legal-top" }, meta), article);

  return {
    el,
    update() {},
    destroy() {
      el.remove();
    },
  };
}

export const privacyScreen: ScreenFactory = (ctx) => legalScreen(ctx, "privacy", "Privacy", PRIVACY_UPDATED, PRIVACY_SECTIONS);

/** A link-styled button to the privacy notice, for footers and forms. */
export function privacyLink(store: Store<AppState>): HTMLButtonElement {
  return h("button", { type: "button", class: "quiet", onclick: () => store.set({ screen: "privacy" }) }, icon("shield", 18), "Privacy");
}
