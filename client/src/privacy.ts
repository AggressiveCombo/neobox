// Privacy notice content. Plain data: the screen that shows it renders these strings.
// Keep it in step with what the server stores and deletes (crates/store, crates/server).

import { STORAGE_KEYS, type StorageKey } from "./storage-keys";

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}

/** The controller: the operator, a private individual. */
export const OPERATOR_NAME = "aggressivecombo";
export const PRIVACY_UPDATED = "2026-11-28";
// The operator's mailbox: GDPR contact and the Digital Services Act single point of contact.
export const PRIVACY_CONTACT = "neobox@aggressivecombo.com";

/** The purposes of the keys kept in one storage area, as "a, b and c". Raw key names are never shown. */
function describe(scope: StorageKey["scope"]): string {
  const items = STORAGE_KEYS.filter((k) => k.scope === scope).map((k) => k.purpose);
  const last = items.pop() ?? "";
  return items.length > 0 ? `${items.join(", ")} and ${last}` : last;
}

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: "Who runs neobox",
    paragraphs: [
      "neobox is a free, fan-made physics platform-fighter. It has no advertising and no analytics.",
      `The operator is ${OPERATOR_NAME}, a private individual. The operator is the controller of your personal data under the GDPR.`,
    ],
  },
  {
    heading: "Legal basis",
    paragraphs: [
      "We process data to provide the service you ask for (GDPR Art. 6(1)(b)), to keep it secure and free of abuse (legitimate interest, Art. 6(1)(f)), and to meet legal duties under the Digital Services Act (Art. 6(1)(c)).",
      "Playing YouTube videos is based on your consent (Art. 6(1)(a)). You can withdraw it at any time by turning off Allow YouTube in Settings.",
    ],
  },
  {
    heading: "What an account stores",
    paragraphs: [
      "An account stores its name, a password hash (argon2id; your password is never stored), the creation date, your XP and level, your settings, your friends, favourites and votes, and the maps you upload. An account stores no email address and no real name.",
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
      "The server sees the IP address of every connection. It uses IP addresses to limit simultaneous connections, to rate-limit sign-in attempts and uploads, and to enforce bans. A ban is stored against the IP address and, for a signed-in player, the account.",
      "Live IP addresses of players in rooms are kept in server memory only and are lost on restart. The admin view shows them.",
      "Server logs, such as joins, admin logins and message-flood disconnects, include IP addresses. They are kept for 14 days in the server's system journal. The admin log view keeps the latest 4000 lines in memory.",
      "Database backups are kept for 14 days on the server, and the newest 30 copies are kept on the operator's own computer.",
      "If the operator provides a local copy of the DB-IP City Lite database, the server looks up IP addresses in it to show a country flag and an approximate distance. The lookup runs on the server and no address is sent to a third party. Room lists show the host's country and your approximate distance from the game server that runs the room; your own country is sent to your browser. Without the database, no country or distance is shown.",
    ],
  },
  {
    heading: "Chat, reports and moderation",
    paragraphs: [
      "Chat messages are kept only in server memory, for the room they were sent in. They are not written to logs or to the database, except the lines copied into a report.",
      "Automatic filters on the server refuse repeated chat spam. Chat words are not filtered on the server; a swear filter that a player turns on in Settings only masks words on that player's own screen. If three different players report the same player in the same room within 10 minutes, that player is muted in that room.",
      "A report stores each player's name, their account id if they are signed in, and their IP address, for both the reporter and the reported player, together with up to 30 recent chat lines from that room as evidence. Feedback you send is stored with your name, account link and IP address.",
      "Reports and feedback are deleted 180 days after they were created. Their IP addresses are cleared after 30 days.",
    ],
  },
  {
    heading: "Third parties and hosting",
    paragraphs: [
      "Hosting: neobox runs on a Vultr server (Vultr Holdings LLC, USA) in Chicago, USA. Your data is therefore transferred to the United States, a country outside the EU. The operator relies on the standard contractual clauses offered by the provider. DNS is served by Cloudflare (DNS only, not proxied).",
      "YouTube: the jukebox plays YouTube videos. Nothing loads from YouTube until you turn on Allow YouTube once, in the jukebox panel or under Settings. After that, your browser loads YouTube's player from www.youtube-nocookie.com, which receives your IP address and may store cookies. Room lists show video thumbnails only after you turn it on; until then a placeholder is shown. When a YouTube link is posted, the server asks YouTube's oEmbed service for the video's title, sending only the video id.",
      "Hitbox.io map search: when you browse or search the Hitbox.io tab, the neobox server queries Hitbox.io's public map endpoints on your behalf, sending only your search query, sort order and page offset. Your browser does not contact Hitbox.io and your IP address and account are not sent to it.",
      "Regional game servers run by the operator receive a signed ticket with your account id, name and XP when you join, and they can see your IP address. Apart from YouTube, the browser loads nothing from outside services.",
    ],
  },
  {
    heading: "Children",
    paragraphs: [
      "neobox has no age limit and collects no more data from children than from anyone else (no email, no real name).",
      "YouTube is opt-in. If you're under 16, ask a parent or guardian before turning it on.",
      `A parent can ask for a child's account to be deleted by writing to ${PRIVACY_CONTACT}.`,
    ],
  },
  {
    heading: "Retention and deletion",
    paragraphs: [
      "Account data is kept until you delete it. Under Delete account, enter your password to remove your account, its sessions, friendships, votes, favourites, settings, your maps with their votes and plays, your fastest times and your XP grants.",
      "When you delete your account, your name, IP address and account link are cleared from the feedback you wrote and the reports you filed, so only the text stays. Reports about you are kept until the limits below.",
      "Retention limits: server logs 14 days; reports and feedback 180 days after creation, with their IP addresses cleared after 30 days; expired suspensions and IP bans 180 days after they end; database backups 14 days on the server and the newest 30 copies on the operator's own computer. Chat and live IP addresses exist only in memory and are lost on restart.",
      "Clips you uploaded are not removed with the account: they stay, under the recorder's name, until an operator removes them.",
    ],
  },
  {
    heading: "Your rights and contact",
    paragraphs: [
      "Under the GDPR you can ask for access to your data, correction, erasure, restriction of processing, objection to processing, and a copy of your data in a portable form. Signed-in players can download a JSON copy of everything stored about their account with the Download my data button on the Account screen (the same file is served at /api/account/export). Requests are answered without undue delay and within one month.",
      "You can complain to a data protection authority, in particular in the EU country where you live, work, or where you think your data was misused.",
      `To use these rights or ask a question, write to ${PRIVACY_CONTACT}.`,
    ],
  },
];

