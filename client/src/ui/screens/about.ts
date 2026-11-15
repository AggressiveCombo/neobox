// About panel: credit line, originality and license notice, links.

import type { ScreenFactory } from "../../ctx";
import { h } from "../dom";
import { logoImg } from "../logo";

export const CREDIT_LINE = "neobox is a fan-made spiritual successor to Hitbox.io, created by Chaz. Not affiliated.";
export const REPO_URL = "https://github.com/AggressiveCombo/neobox";
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

/** Third-party assets shipped with neobox. The same entries are listed in CREDITS.md. */
export interface AssetCredit {
  asset: string;
  title: string;
  author: string;
  licence: string;
  licenceUrl: string;
  sourceUrl: string;
}

export const THIRD_PARTY: AssetCredit[] = [
  {
    asset: "Menu music",
    title: "Menu Loop",
    author: "Umplix",
    licence: "CC0 1.0 (public domain dedication)",
    licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://opengameart.org/content/menu-loop-0",
  },
  {
    asset: "Chat emoji names",
    title: "gemoji",
    author: "GitHub",
    licence: "MIT",
    licenceUrl: "https://github.com/github/gemoji/blob/master/LICENSE",
    sourceUrl: "https://github.com/github/gemoji",
  },
  {
    asset: "Profanity filter word list",
    title: "List of Dirty, Naughty, Obscene, and Otherwise Bad Words",
    author: "LDNOOBW contributors",
    licence: "CC BY 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    sourceUrl: "https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words",
  },
  {
    asset: "Country flags",
    title: "flag-icons",
    author: "Panayiotis Lipiridis",
    licence: "MIT",
    licenceUrl: "https://github.com/lipis/flag-icons/blob/main/LICENSE",
    sourceUrl: "https://github.com/lipis/flag-icons",
  },
  {
    asset: "Room distances and flags (IP geolocation)",
    title: "DB-IP IP to City Lite",
    author: "DB-IP",
    licence: "CC BY 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    sourceUrl: "https://db-ip.com/db_lite.php",
  },
];

export const aboutScreen: ScreenFactory = (ctx) => {
  const el = h(
    "div",
    { class: "screen about" },
    h(
      "section",
      { class: "panel" },
      h("header", { class: "brand" }, logoImg(64), h("h1", { class: "wordmark" }, "About neobox")),
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
      h("p", null, "Third-party assets:"),
      h(
        "ul",
        { class: "links-list" },
        THIRD_PARTY.map((c) =>
          h(
            "li",
            null,
            `${c.asset}: "${c.title}" by ${c.author}, licensed ${c.licence}. `,
            h("a", { href: c.sourceUrl, target: "_blank", rel: "noopener" }, "Source page"),
            " / ",
            h("a", { href: c.licenceUrl, target: "_blank", rel: "noopener" }, "Licence"),
          ),
        ),
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
