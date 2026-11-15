// Update news: release notes, one entry per page, shown in a modal over the menu.
// The player has seen the news when the count of entries they last viewed matches
// NEWS.length; a new entry at the top lights the menu's News button again.

import { h } from "./dom";
import { openModal } from "./kit";

interface NewsEntry {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  items: string[];
}

/** Newest first. Player-facing wording only. */
const NEWS: NewsEntry[] = [
  {
    date: "2026-11-15",
    items: [
      "A new look everywhere: clearer screens, bigger type, and a light and a dark theme (Settings, Display; it follows your system by default).",
      "The main menu plays a match inside the big square. Press Play straight away: you get a guest name you can change.",
      "Rooms: the players are front and centre, the host's settings fold away under All settings, and on phones the lobby has Players, Match and Chat tabs with Start always at the bottom.",
      "Phones: play in landscape with a separate Jump button; in portrait the game asks you to turn your phone, and can switch to full screen.",
      "The match HUD shows your connection: ping, and whether it runs over UDP or the slower fallback.",
      "Report a player from the room, or a map from the library. Reports go to the moderators.",
      "Map library: maps show as a grid; open one for its details, votes, Fastest Times and Report.",
      "Room links now show the room's name, map and player count when you paste them in chat apps.",
      "Add neobox to your home screen to play it like an app.",
      "A privacy page explains what neobox stores and why (About, Privacy).",
    ],
  },
  {
    date: "2026-11-15",
    items: [
      "Quick play works like hitbox.io's: Sweaty Bois (up to 4 players, last one standing, win a map twice) and Team Madness (8 players in teams with a shared pool of 50 lives), each with its map rotation and the week's best-rated library maps. Browse a mode's maps with the arrows on its card.",
      "Quick play skips rooms you have already been in, and tells you while it is still matching you with other players.",
      "New custom rooms start in lives mode with 5 lives on Simple Arena 1.",
      "Checkpoint races are back: touch numbered checkpoints in order, return to your last checkpoint when you die, and reach the highest one to finish. Map makers set them in the editor (Race checkpoint, Race object).",
      "Fastest Times: with /set recordMode true, finishing a library map saves your best time. See the board with the Fastest Times button in the room.",
      "Vote on the room's map from its vote counts.",
      "Bodies that become dynamic when damaged now do so.",
      "In matches: damage bars on breakable bodies, a flashing square where you will respawn, grab lines, the bat and the rocket launcher with their charge, movement trails, and a highlight on your player when you press an action key during the countdown.",
    ],
  },
  {
    date: "2026-11-14",
    items: [
      "Experience and levels: finish games to earn XP. The game-over panel shows your placement, the XP you gained and your progress to the next level.",
      "Guests can reach level 1. Sign in to keep earning levels.",
      "Quick play: pick Free for all, Team rounds or Lives. Quick rooms have no host and rotate through maps.",
      "Menu music, with a mute switch on the menu and in Settings.",
      "Jukebox: the room host can play YouTube videos for everyone, then pause, resume or stop them. Players can suggest a video by pasting its link in chat.",
      "Training hall: a new practice screen from the menu.",
      "The menu plays shared match clips in the background.",
      "Appearance colour: pick your player colour in Settings or in a room.",
      "Emoji: type a shortcode such as :smile: in chat to send an emoji.",
      "Profanity filter, on by default. Turn it off in Settings.",
      "Chat shows when someone is typing. Rooms show who is in the map editor.",
      "Start countdowns can be aborted by the host. The room shows each map's author, votes and age.",
      "The menu shows how many players are online and this week's top map makers.",
      "Room list: each room shows its jukebox video, the friends in it and a badge for quick-play rooms.",
    ],
  },
  {
    date: "2026-11-14",
    items: [
      "Accounts: sign up, sign in, change your password or delete your account.",
      "Friends: send and accept friend requests, and see which room your friends are in.",
      "Map library: publish your maps, browse new, hot, top and most-played maps, vote, pick favourites and read map descriptions.",
      "Replays: record finished matches and watch them back.",
      "Practice: play offline against your own settings.",
      "Host tools: lock the room, kick or ban players, move players between teams and hand over host.",
      "Reconnect: if your connection drops during a game, you rejoin the same seat.",
    ],
  },
  {
    date: "2026-11-13",
    items: [
      "neobox launched: a free, open-source browser game inspired by Hitbox.io.",
      "Deterministic physics: the same inputs give the same result on every device, so online matches stay in step.",
      "Rollback netcode keeps online play smooth on slower connections.",
      "Rendering uses WebGPU where it is available, with WebGL2 as the fallback.",
      "Keyboard controls and touch controls for phones and tablets.",
      "Built-in maps to play and learn on.",
    ],
  },
];

const SEEN_KEY = "neobox.newsSeen";

function readSeen(): number {
  try {
    const n = Number(window.localStorage.getItem(SEEN_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeSeen(count: number): void {
  try {
    window.localStorage.setItem(SEEN_KEY, String(count));
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
  const list = h("div", { class: "news-body" });
  const counter = h("span", { class: "news-count", "aria-live": "polite" });
  const prev = h("button", { type: "button", onclick: () => show(index - 1) }, "Previous");
  const next = h("button", { type: "button", class: "primary", onclick: () => show(index + 1) }, "Next");
  const done = h("button", { type: "button", onclick: () => close() }, "Close");

  function show(i: number): void {
    index = Math.min(NEWS.length - 1, Math.max(0, i));
    const entry = NEWS[index];
    list.replaceChildren(
      h("time", { class: "news-date", datetime: entry.date }, entry.date),
      h("ul", { class: "news-list boxed-list" }, entry.items.map((text) => h("li", null, text))),
    );
    counter.textContent = `${index + 1} of ${NEWS.length}`;
    prev.disabled = index === 0;
    next.disabled = index === NEWS.length - 1;
  }

  const { close } = openModal({
    title: "Update news",
    body: [list, h("div", { class: "news-pager" }, prev, counter, next)],
    actions: [done],
  });
  show(0);
  return () => close();
}

