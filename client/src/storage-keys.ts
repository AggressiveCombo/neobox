// Every key the client writes to localStorage or sessionStorage. Writers import
// these constants; the privacy notice is built from STORAGE_KEYS, and a test fails
// when client source uses a `neobox.` key that is not listed here.
//
// The strings are saved data: never change one without migrating existing players.

export const REMEMBER_KEY = "neobox.staySignedIn";
export const NAME_STORAGE_KEY = "neobox.name";
/** sessionStorage: this tab's room seat `{ room, token }`, so a reload resumes it. */
export const SEAT_STORAGE_KEY = "neobox.seat";
export const PREFS_KEY = "neobox.prefs";
export const GUEST_XP_KEY = "neobox.guestXp";
export const NEWS_SEEN_KEY = "neobox.newsSeen";
export const DRAFT_KEY = "neobox.editor.draft";
export const PHONE_SPLASH_SEEN_KEY = "neobox.phoneSplashSeen";
/** The first-visit "Start here" badge on Training was dismissed. */
export const TRAINING_SEEN_KEY = "neobox.hintSeen";

export interface StorageKey {
  key: string;
  /** localStorage survives visits; sessionStorage lasts as long as the tab. */
  scope: "local" | "session";
  /** What the key holds, as the privacy notice describes it. */
  purpose: string;
}

export const STORAGE_KEYS: readonly StorageKey[] = [
  { key: REMEMBER_KEY, scope: "local", purpose: "whether you chose to stay signed in" },
  { key: NAME_STORAGE_KEY, scope: "local", purpose: "the name you last played under" },
  { key: PREFS_KEY, scope: "local", purpose: "settings used while you are a guest" },
  { key: GUEST_XP_KEY, scope: "local", purpose: "XP earned as a guest" },
  { key: NEWS_SEEN_KEY, scope: "local", purpose: "news items you have read" },
  { key: DRAFT_KEY, scope: "local", purpose: "an unsaved map editor draft" },
  { key: PHONE_SPLASH_SEEN_KEY, scope: "local", purpose: "whether the phone welcome has been shown" },
  { key: TRAINING_SEEN_KEY, scope: "local", purpose: "whether the Training badge has been dismissed" },
  { key: SEAT_STORAGE_KEY, scope: "session", purpose: "the room you are seated in and a resume token, so a reload can rejoin the match" },
];
