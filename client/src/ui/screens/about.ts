// About panel: credit line, originality and license notice, links.

import type { ScreenFactory } from "../../ctx";
import { h } from "../dom";
import { logoSvg } from "../logo";

export const CREDIT_LINE = "neobox is a fan-made spiritual successor to Hitbox.io, created by Chaz. Not affiliated.";
export const REPO_URL = "https://github.com/AggressiveCombo/neobox";
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

export const aboutScreen: ScreenFactory = (ctx) => {
  const el = h(
    "div",
    { class: "screen about" },
    h(
      "section",
      { class: "panel" },
      h("header", { class: "brand" }, logoSvg(64), h("h1", { class: "wordmark" }, "About neobox")),
      h("p", { class: "credit" }, CREDIT_LINE),
      h(
        "p",
        null,
        "The game is original work. No Hitbox.io assets, images, sounds, fonts or texts are used.",
      ),
      h(
        "p",
        null,
        "neobox is free software licensed under the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later).",
      ),
      h(
        "ul",
        { class: "links-list" },
        h("li", null, h("a", { href: REPO_URL, target: "_blank", rel: "noopener" }, "Source code")),
        h("li", null, h("a", { href: LICENSE_URL, target: "_blank", rel: "noopener" }, "AGPL-3.0-or-later license text")),
      ),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => ctx.store.set({ screen: "menu" }) }, "Back"),
      ),
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
