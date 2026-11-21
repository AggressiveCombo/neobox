// Player profile: a signed-in player's public stats from GET /api/players/{name}.
// `showProfile` opens the card in a modal; `profileSummary` is the same card as a
// block for other screens. Both load themselves and show their own loading and
// error states.

import "./profile.css";
import { ApiError, errorText, getPlayer, type PlayerMap, type PlayerProfile } from "../account";
import type { AppCtx } from "../ctx";
import { xpForLevel } from "../levels";
import { reducedMotion } from "./a11y";
import { h } from "./dom";
import { icon, type IconName } from "./icons";
import { avatar, openModal } from "./kit";

/** How long the numbers take to count up to their values (once per card). */
const COUNT_MS = 700;

/** Open a player's profile in a modal. The card loads the profile itself. */
export function showProfile(_ctx: AppCtx, name: string): void {
  const modal = openModal({ title: "Profile", body: [profileSummary(name)] });
  modal.dialog.classList.add("profile-dialog");
}

/** The profile card for `name`, loading itself: safe to embed in any screen. */
export function profileSummary(name: string): HTMLElement {
  const root = h("div", { class: "profile enter" });
  const load = (): void => {
    root.replaceChildren(status("Loading profile…"));
    getPlayer(name).then(
      (p) => root.replaceChildren(card(p)),
      (err: unknown) => root.replaceChildren(failure(name, err, load)),
    );
  };
  load();
  return root;
}

function status(text: string, ...extra: Node[]): HTMLElement {
  return h("p", { class: "profile-status", role: "status" }, icon("triangle-alert", 18), text, ...extra);
}

/** Not found is a fact about the name; anything else is worth a retry. */
function failure(name: string, err: unknown, retry: () => void): HTMLElement {
  if (err instanceof ApiError && err.status === 404) {
    return status(`No profile for ${name}. Only signed-in players have one.`);
  }
  if (err instanceof ApiError && err.status === 429) return status(errorText(err));
  const again = h("button", { type: "button", onclick: retry }, icon("refresh-cw", 18), "Try again");
  if (!navigator.onLine) {
    // Offline there is nothing to fetch: the card loads again once the connection is back.
    window.addEventListener("online", retry, { once: true });
    return status(`${name}'s profile is unavailable offline.`, again);
  }
  return status(`Couldn't load ${name}'s profile. Check the connection, then try again.`, again);
}

function card(p: PlayerProfile): HTMLElement {
  const from = xpForLevel(p.level);
  const to = xpForLevel(p.level + 1);
  const into = Math.min(to - from, Math.max(0, p.xp - from));

  // The fill starts empty and grows once the card is on the page (the meter's own transition).
  const fill = h("span", {});
  const meter = h(
    "div",
    {
      class: "meter",
      role: "progressbar",
      "aria-label": `Experience to level ${p.level + 1}`,
      "aria-valuemin": "0",
      "aria-valuemax": String(to - from),
      "aria-valuenow": String(into),
    },
    fill,
  );
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${(100 * into) / (to - from)}%`)));

  const s = p.stats;
  const joined = new Date(p.joined);

  return h(
    "div",
    { class: "profile enter" },
    h(
      "div",
      { class: "profile-head" },
      avatar(p.name, p.color),
      h(
        "div",
        { class: "profile-id" },
        h("p", { class: "profile-name" }, p.name),
        h("div", { class: "profile-level" }, h("span", {}, `Level ${p.level}`), h("span", { class: "num" }, `${p.xp.toLocaleString()} xp`)),
        meter,
        h("p", { class: "profile-xp" }, `${(to - p.xp).toLocaleString()} xp to level ${p.level + 1}`),
      ),
    ),
    h(
      "div",
      { class: "profile-stats" },
      stat("gamepad-2", "Games", s.games),
      stat("trophy", "Wins", s.wins),
      stat("flag", "Rounds won", s.rounds_won),
      stat("swords", "Kills", s.kills),
      stat("skull", "Deaths", s.deaths),
      stat("timer", "Time played", s.play_seconds, playTime),
    ),
    h(
      "ul",
      { class: "profile-facts" },
      h("li", {}, icon("calendar", 16), `Joined ${joined.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`),
      h("li", {}, icon("map", 16), plural(p.published, "map published", "maps published")),
      h("li", {}, icon("crown", 16), plural(p.records, "fastest time", "fastest times")),
      h("li", {}, icon("users", 16), plural(p.friends, "friend", "friends")),
    ),
    mapsSection(p),
  );
}

function mapsSection(p: PlayerProfile): HTMLElement {
  const body = p.maps.length === 0 ? h("p", { class: "muted small empty" }, icon("map", 40), "No listed maps yet.") : h("ul", {}, p.maps.map(mapRow));
  return h("section", { class: "profile-maps" }, h("h3", {}, icon("map", 20), "Top maps"), body);
}

function mapRow(m: PlayerMap): HTMLElement {
  return h(
    "li",
    {},
    h("span", { class: "profile-map-name", title: m.name }, m.name),
    h(
      "span",
      { class: "profile-map-figs" },
      h("span", {}, h("span", { class: "num" }, m.plays.toLocaleString()), " plays"),
      h("span", {}, h("span", { class: "num" }, m.score.toLocaleString()), " score"),
    ),
  );
}

/** One figure with its icon and label; the number counts up once. */
function stat(glyph: IconName, label: string, value: number, format: (n: number) => string = (n) => n.toLocaleString()): HTMLElement {
  const num = h("span", { class: "num" });
  countUp(num, value, format);
  return h(
    "div",
    { class: "profile-stat" },
    h("span", { class: "profile-stat-icon" }, icon(glyph, 22)),
    num,
    h("span", { class: "profile-stat-label" }, label),
  );
}

function countUp(el: HTMLElement, to: number, format: (n: number) => string): void {
  if (reducedMotion() || to === 0) {
    el.textContent = format(to);
    return;
  }
  el.textContent = format(0);
  const start = performance.now();
  const frame = (now: number): void => {
    const t = Math.min(1, (now - start) / COUNT_MS);
    el.textContent = format(Math.round(to * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Seconds as hours and minutes: "45m", "3h 12m". */
function playTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
