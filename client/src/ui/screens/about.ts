// About panel: credit line, originality and license notice, links.

import type { ScreenFactory } from "../../ctx";
import { h } from "../dom";
import { page, pageHead } from "../kit";
import { icon } from "../icons";
import { openNews } from "../news";
import { privacyLink } from "./privacy";
import { termsLink } from "./terms";
import "./info.css";

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
    title: "Electronic music / chiptune 3",
    author: "2D_PlatformerGuy",
    licence: "CC0 1.0 (public domain dedication)",
    licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://opengameart.org/content/electronic-music-chiptune-3",
  },
  {
    asset: "Match music",
    title: "JRPG Music Pack #5 [Action]: Action2 and Action3",
    author: "Juhani Junkala (SubspaceAudio pack)",
    licence: "CC0 1.0 (public domain dedication)",
    licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://opengameart.org/content/jrpg-pack-5-action",
  },
  {
    asset: "Sound effects",
    title: "UI, impact, sci-fi, digital and jingle packs",
    author: "Kenney (kenney.nl)",
    licence: "CC0 1.0 (public domain dedication)",
    licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://kenney.nl/assets",
  },
  {
    asset: "Typeface",
    title: "Hanken Grotesk",
    author: "the Hanken Grotesk Project Authors",
    licence: "SIL Open Font License 1.1",
    licenceUrl: "https://openfontlicense.org",
    sourceUrl: "https://github.com/marcologous/hanken-grotesk",
  },
  {
    asset: "Readable typeface",
    title: "OpenDyslexic",
    author: "Abbie Gonzalez",
    licence: "SIL Open Font License 1.1",
    licenceUrl: "https://openfontlicense.org",
    sourceUrl: "https://github.com/antijingoist/opendyslexic",
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
    asset: "Interface icons",
    title: "Lucide",
    author: "Lucide Contributors (portions Cole Bemis, Feather)",
    licence: "ISC",
    licenceUrl: "https://github.com/lucide-icons/lucide/blob/main/LICENSE",
    sourceUrl: "https://lucide.dev",
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
  const head = pageHead({ title: "About neobox", back: () => ctx.store.set({ screen: "menu" }) });
  const el = page(
    "about",
    head,
    h(
      "div",
      { class: "info-grid" },
      h(
        "section",
        { class: "info-main" },
        h("p", { class: "info-lead" }, "neobox is a free game of square fighters batting each other off floating maps. It runs in the browser: no install, and guests can play."),
        h("p", null, CREDIT_LINE),
        h("p", null, "neobox is free software licensed under the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later)."),
        h(
          "ul",
          { class: "info-links" },
          h("li", null, h("a", { href: REPO_URL, target: "_blank", rel: "noopener" }, "Source code", icon("external-link", 16))),
          h("li", null, h("a", { href: LICENSE_URL, target: "_blank", rel: "noopener" }, "AGPL-3.0-or-later licence text", icon("external-link", 16))),
        ),
        h(
          "div",
          { class: "info-actions" },
          h("button", { type: "button", onclick: () => openNews() }, icon("newspaper", 18), "News"),
          privacyLink(ctx.store),
          termsLink(ctx.store),
        ),
      ),
      h(
        "section",
        { class: "info-credits" },
        h("h2", null, icon("book-open", 20), "Third-party assets"),
        h(
          "ul",
          { class: "boxed-list" },
          THIRD_PARTY.map((c) =>
            h(
              "li",
              null,
              h("strong", null, c.asset),
              `: "${c.title}" by ${c.author}, licensed ${c.licence}. `,
              h("a", { href: c.sourceUrl, target: "_blank", rel: "noopener", "aria-label": `Source page for ${c.asset} (${c.title})` }, "Source page"),
              " · ",
              h("a", { href: c.licenceUrl, target: "_blank", rel: "noopener", "aria-label": `Licence for ${c.asset} (${c.title})` }, "Licence"),
            ),
          ),
        ),
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
