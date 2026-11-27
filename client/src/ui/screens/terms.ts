// The terms of use page: long-form text from src/terms.ts, shown by the shared legal-page renderer.

import type { AppCtx, ScreenHandle } from "../../ctx";
import type { AppState, Store } from "../../state";
import { TERMS_SECTIONS, TERMS_UPDATED } from "../../terms";
import { h } from "../dom";
import { legalScreen } from "./privacy";

export function termsScreen(ctx: AppCtx): ScreenHandle {
  return legalScreen(ctx, "terms", "Terms", TERMS_UPDATED, TERMS_SECTIONS);
}

/** A link-styled button to the terms of use, for footers and forms. */
export function termsLink(store: Store<AppState>): HTMLButtonElement {
  return h("button", { type: "button", class: "quiet", onclick: () => store.set({ screen: "terms" }) }, "Terms");
}
