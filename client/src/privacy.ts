// Privacy notice content. Plain data: the screen that shows it renders these strings.
// Keep it in step with what the server stores (crates/store, crates/server).

import { STORAGE_KEYS, type StorageKey } from "./storage-keys";

export const PRIVACY_UPDATED = "2026-11-15";

// Operator address (placeholder): confirm before release.
export const PRIVACY_CONTACT = "neobox@aggressivecombo.com";

/** The purposes of the keys kept in one storage area, as "a, b and c". Raw key names are never shown. */
function describe(scope: StorageKey["scope"]): string {
  const items = STORAGE_KEYS.filter((k) => k.scope === scope).map((k) => k.purpose);
  const last = items.pop() ?? "";
  return items.length > 0 ? `${items.join(", ")} and ${last}` : last;
}

export const PRIVACY_SECTIONS: { heading: string; paragraphs: string[] }[] = [
  {
    heading: "Who runs neobox",
    paragraphs: [
      "neobox is a free, fan-made physics platform-fighter. It has no advertising and no analytics.",
    ],
  },
  {
    heading: "What an account stores",
    paragraphs: [
      "An account stores its name, a password hash (argon2id; your password is never stored), the creation date, your XP and level, your settings, your friends, favourites and votes, and the maps you upload.",
      "Your fastest time on each map is stored with your name and the date. Clips you upload are stored with the name of the account that recorded them. Names, fastest times and uploaded maps are visible to other players.",
    ],
  },
  {
    heading: "Sessions and cookies",
    paragraphs: [
      "Signing in sets a session cookie, nb_session. It is HttpOnly and SameSite=Lax and is used only to keep you signed in. With Stay signed in ticked it lasts 30 days; otherwise it ends when you close the browser. The server extends a session that you use in its last 15 days, but the cookie is set only at sign-in, so with Stay signed in ticked you sign in again after 30 days.",
      "The server stores only a SHA-256 digest of each session token and keeps at most 20 sessions per account. Operators who use the admin page get a separate admin cookie, neobox_admin, which is HttpOnly, SameSite=Strict and limited to the /admin path. No other cookies are set.",
    ],
  },
  {
    heading: "Data kept in your browser",
    paragraphs: [
      `localStorage on your device holds ${describe("local")}. Signed-in settings are also synced to the server.`,
      `sessionStorage holds ${describe("session")}. Each tab has its own. It is cleared when the tab closes. Clearing site data removes everything listed here.`,
    ],
  },
  {
    heading: "IP addresses, logs and location",
    paragraphs: [
      "The server sees the IP address of every connection. It uses IP addresses to limit simultaneous connections, to rate-limit sign-in attempts and uploads, and to enforce bans. A ban is recorded, in the memory of the room it applies to, against the IP address and, for a signed-in player, the account.",
      "The admin view shows the IP addresses of players in live rooms. Server logs, such as joins, admin logins and message-flood disconnects, include IP addresses; they are kept in server memory for the admin log view (the latest 4000 lines) and written to the server's standard output, which the host may keep.",
      "If the operator provides a local copy of the DB-IP City Lite database, the server looks up IP addresses in it to show a country flag and an approximate distance. The lookup runs on the server and no address is sent to a third party. Room lists show the host's country and your approximate distance from the game server that runs the room; your own country is sent to your browser. Without the database, no country or distance is shown.",
    ],
  },
  {
    heading: "Chat and reports",
    paragraphs: [
      "Chat messages are kept only in memory, for the room they were sent in. They are not written to logs or to the database, except the lines copied into a player report (below).",
      "A player report stores each player's name, their account id if they are signed in, and their IP address, for both the reporter and the reported player, together with up to 30 recent chat lines from that room as evidence. Reports are kept until an operator removes them.",
    ],
  },
  {
    heading: "Third parties",
    paragraphs: [
      "The jukebox plays YouTube videos. Once a room has a jukebox set, your browser loads the YouTube player, even while the video is paused, and room lists load video thumbnails from YouTube's image servers for rooms with a video. YouTube then receives your IP address. When a YouTube link is posted, the server asks YouTube's oEmbed service for the video's title, sending only the video id.",
      "Regional game servers run by the operator receive a signed ticket with your account id, name and XP when you join, and they can see your IP address. Apart from the YouTube requests above, the game loads nothing from other outside services.",
    ],
  },
  {
    heading: "Retention and deletion",
    paragraphs: [
      "Account data is kept until you delete it. Under Delete account, enter your password to remove your account, its sessions, friendships, votes, favourites, settings, your maps with their votes and plays, your fastest times and your XP grants.",
      "Clips you uploaded are not removed with the account: they stay, under the recorder's name, until an operator removes them. Reports stay until an operator removes them. IP addresses and chat in server memory are lost on restart.",
    ],
  },
  {
    heading: "Your rights and contact",
    paragraphs: [
      "Under the GDPR you can ask for access to your data, correction, erasure, restriction of processing, and objection to processing, and you can complain to a data protection supervisory authority. We process data to provide the service you ask for and for the legitimate interest of keeping it secure and free of abuse.",
      `To use these rights or ask a question, write to ${PRIVACY_CONTACT}.`,
    ],
  },
];
