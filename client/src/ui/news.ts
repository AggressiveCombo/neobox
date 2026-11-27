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
    date: "2026-11-27",
    items: [
      "Invite links: guests choose their name before joining a room from a link.",
      "Swear filter: off by default. Turn it on in Settings to hide swearing on your screen.",
      "Reports: new reasons, including illegal content, and a player reported by three different people in the same room is muted there.",
      "YouTube: the jukebox and video thumbnails load only after you choose Allow YouTube (in the jukebox or in Settings).",
      "New Terms page, a clearer Privacy page, and Download my data on the Account screen.",
    ],
  },
  {
    date: "2026-11-26",
    items: [
      "Phones and tablets: the main menu's buttons and the Bug and Suggest buttons are bigger and easier to tap (thanks for the suggestion, whaleice).",
      "Connection drops: if your connection drops, your seat is held for 60 seconds again so you can rejoin; closing the tab still leaves the room straight away.",
      "Sound: effects play from the centre, without random pitch changes, jumps are softer, and the rocket hum no longer keeps playing over the menu.",
      "Lobby: less repeated information and no duplicate controls; the host's End match button is back.",
      "Map editor: pasted shapes keep their rotation, and pasting into another map no longer attaches joints to the wrong objects.",
      "Account: the Account screen stays open when room updates arrive and when you sign in or out.",
    ],
  },
  {
    date: "2026-11-24",
    items: [
      "Bug reports & suggestions: click Bug or Suggest in the top bar at any time to report issues or share ideas directly from the game.",
      "In-game Jukebox: open Menu → Jukebox or use /play, /pause, /resume and /stop in chat to control music during a match, or click Play right on a chat song suggestion.",
      "Map editor: selecting multiple objects or shapes now lets you bulk-edit their shared properties and colours at once instead of only merging.",
      "Endless teams: maps without objectives now show Endless teams cleanly instead of displaying a misleading objective limit.",
      "Lobby settings: scrolling or tweaking Settings while in a room lobby no longer closes the Settings screen when room updates arrive.",
      "Updates: opening the site fresh after a new release no longer triggers a false \"new version\" banner when you are already on the latest build.",
    ],
  },
  {
    date: "2026-11-23",
    items: [
      "Main menu: the replay showcase is larger on widescreen displays and cycles infinitely between replays with a smooth sliding transition.",
      "Match HUD: lives, scores and objectives now live inside one slim top bar instead of floating over the arena, with each player's remaining lives shown cleanly at the top.",
      "Advanced stats (F3): added a compact live FPS and ping graph over time.",
      "Sound effects: refreshed gameplay and interface sounds with distinct effects for each action, including menu wheel scrolling and pitch-tracked sliders.",
      "Map editor and library: added Cut, Copy and Paste (Ctrl+X / Ctrl+C / Ctrl+V) in the editor, Delete buttons for your own maps in the library and editor, properly framed map previews, and fair play-count tracking.",
      "Chat and Jukebox: keyboard copy and paste now work directly in chat, space-only chat lines are allowed, and the Jukebox plays audio-only with no popup unless you enable the popup in Sound settings.",
      "Performance, connections and polish: fixed matches locking to 30 FPS on smooth displays, reduced unnecessary WebRTC fallbacks, matched room flags to server regions, and fixed initial page scrollbars and layout shifts.",
    ],
  },
  {
    date: "2026-11-22",
    items: [
      "Capturing the flag now ends the round, and the match ends when a team reaches the objective limit.",
      "Quick play no longer picks team-only maps for free-for-all modes.",
      "Everyone's stamina bar shows on their name, not only yours.",
      "The camera follows you at the normal size instead of zooming out to keep other players in view.",
      "Training hall: landing on a dummy completes that lesson.",
      "Phones: hold Jump to jump again once your air jump is ready, and the stick steers in eight directions without flicking between them.",
      "Jukebox: music only by default; Show video turns the video on.",
      "Sounds and music are evened out, so no effect is much louder or quieter than the others.",
      "The lobby fits your window: new chat messages and More settings no longer push things around.",
      "When a new version is out, the game tells you and reloads on the menu, so you never join a room on an old version.",
    ],
  },
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

