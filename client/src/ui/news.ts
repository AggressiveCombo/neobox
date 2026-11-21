// Update news: release notes, one entry per page, shown in a modal over the menu.
// The player has seen the news when the count of entries they last viewed matches
// NEWS.length; a new entry at the top lights the menu's News button again.

import { h } from "./dom";
import { openModal } from "./kit";
import { icon } from "./icons";
import { NEWS_SEEN_KEY } from "../storage-keys";
import { local } from "../storage";

interface NewsEntry {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  items: string[];
}

/**
 * Newest first. Player-facing wording only: each entry says what changed for players since the previous public
 * release. Development builds before the public launch get no entries (players never saw them).
 */
const NEWS: NewsEntry[] = [
  {
    date: "2026-11-21",
    items: [
      "neobox is out: a free browser game inspired by Hitbox.io. Play straight away as a guest, or sign up to keep your level, friends and maps.",
      "Quick play has two modes: Sweaty Bois (up to 4 players, last one standing each round, first to 2 round wins) and Team Madness (up to 8 players in two teams, each with a shared pool of 50 lives).",
      "Custom rooms: the host picks the map and rules, can lock teams, kick or ban players, move players between teams and hand over host. Vote on the room's map.",
      "Jukebox: the room host can play YouTube videos for everyone. Suggest one by pasting its link in chat.",
      "Map editor and library: make maps (race checkpoints included), publish them, browse new, hot, top and most-played maps and vote on them. Rooms in record mode keep each map's Fastest Times.",
      "Training hall teaches the moves. Practice lets you play offline on any built-in or pasted map.",
      "Earn XP and levels by finishing games. Open a player's profile from the room or your friends list, see which room your friends are in, and watch replays of your matches.",
      "Phones and tablets: touch controls in landscape, with a Control size slider and a Left-handed layout (Settings, Touch). Add neobox to your home screen to play it like an app.",
      "Settings: light or dark theme, your player colour, music and sound, and a profanity filter.",
    ],
  },
];

function readSeen(): number {
  try {
    const n = Number(local.getItem(NEWS_SEEN_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeSeen(count: number): void {
  try {
    local.setItem(NEWS_SEEN_KEY, String(count));
  } catch {
    // Storage blocked (private mode, quota): the news shows as unread next time.
  }
}

/** True while entries exist that the player has not opened the news for. */
export function hasUnreadNews(): boolean {
  return readSeen() < NEWS.length;
}

/** Open the news modal (marks it read). Returns a function that closes it; calling it again does nothing. */
export function openNews(): () => void {
  writeSeen(NEWS.length);
  let index = 0;
  const list = h("div", { class: "news-body", role: "region", tabindex: "0", "aria-label": "Update news" });
  const pages = NEWS.map((entry) =>
    h(
      "div",
      { class: "news-page" },
      h("time", { class: "news-date", datetime: entry.date }, entry.date),
      h("ul", { class: "news-list boxed-list" }, entry.items.map((text) => h("li", null, text))),
    ),
  );
  list.replaceChildren(...pages);
  const counter = h("span", { class: "news-count", "aria-live": "polite" });
  const prev = h("button", { type: "button", onclick: () => show(index - 1) }, icon("arrow-left", 18), "Previous");
  const next = h("button", { type: "button", class: "primary", onclick: () => show(index + 1) }, icon("arrow-right", 18), "Next");
  const done = h("button", { type: "button", onclick: () => close() }, icon("x", 18), "Close");

  // Every page sits in one grid cell; only the current one is visible. The body is as tall as the
  // tallest page, so the modal (and its buttons) keeps its place as the player pages through.
  function show(i: number): void {
    index = Math.min(NEWS.length - 1, Math.max(0, i));
    pages.forEach((page, n) => {
      const current = n === index;
      page.classList.toggle("is-active", current);
      page.setAttribute("aria-hidden", String(!current));
    });
    list.scrollTop = 0;
    counter.textContent = `${index + 1} of ${NEWS.length}`;
    prev.disabled = index === 0;
    next.disabled = index === NEWS.length - 1;
  }

  show(0);
  const { close } = openModal({
    title: "Update news",
    body: [list, counter],
    actions: [prev, next, done],
  });
  return () => close();
}

