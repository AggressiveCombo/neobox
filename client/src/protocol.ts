// Mirror of crates/net/src/protocol.rs (JSON control messages, serde tag "t").
// Keep in sync by hand; the Rust file is the source of truth.

export const PROTOCOL_VERSION = 1;

export const TEAM_SPECTATOR = 0;
export const TEAM_FFA = 1;
export const TEAM_RED = 2;
export const TEAM_BLUE = 3;

export const MAX_CHAT_LEN = 300;
export const MAX_ROOM_NAME_LEN = 50;
export const MAX_NAME_LEN = 15;
/** Name rule from the server: letters, digits, space, underscore; 1..15 chars. */
export const NAME_RE = /^[A-Za-z0-9 _]{1,15}$/;

/** Room size range offered by the UI (the server is configurable, 1..32). */
export const ROOM_MIN_PLAYERS = 1;
export const ROOM_MAX_PLAYERS = 32;

export type QuickQueue = "ffa" | "teams" | "lives";

/** Quick-play queues (crates/net/src/protocol.rs `QUICK_QUEUES`): id and game mode. */
export const QUICK_QUEUES: { id: QuickQueue; mode: number }[] = [
  { id: "ffa", mode: 0 },
  { id: "teams", mode: 3 },
  { id: "lives", mode: 1 },
];

export type JukeboxAction = "play" | "pause" | "resume" | "stop";

export type ClientMsg =
  | { t: "hello"; version: number; name: string; color?: number | null; ticket?: string | null }
  | { t: "list_rooms" }
  | { t: "create_room"; name: string; password: string | null; max_players: number; public: boolean }
  | { t: "join_room"; room: string; password: string | null; resume?: string | null }
  | { t: "quick_play"; queue?: QuickQueue | null }
  | { t: "leave_room" }
  | { t: "chat"; text: string }
  | { t: "set_team"; team: number }
  | { t: "set_map"; code: string; name: string | null }
  | { t: "set_library_map"; id: number }
  | { t: "set_setting"; key: string; value: string }
  | { t: "reset_settings" }
  | { t: "set_mode"; mode: number }
  | { t: "start" }
  | { t: "abort_start" }
  | { t: "end_match" }
  | { t: "kick"; player: number; ban: boolean }
  | { t: "unban"; name: string }
  | { t: "give_host"; player: number }
  | { t: "move_player"; player: number; team: number }
  | { t: "set_lock"; locked: boolean }
  | { t: "set_color"; color: number }
  | { t: "typing" }
  | { t: "editing"; open: boolean }
  | { t: "jukebox"; action: JukeboxAction; video?: string | null }
  | { t: "get_map" }
  | { t: "resync" }
  | { t: "rtc_offer"; sdp: string };

/** A map of the map library, as rooms show it. */
export interface MapMeta {
  id: number;
  name: string;
  author: string;
  description: string;
  /** Unix seconds. */
  created: number;
  up: number;
  down: number;
}

/** The room's jukebox (a YouTube video). */
export interface JukeboxState {
  video: string;
  title: string;
  playing: boolean;
  /** Seconds into the video when the server sent this. */
  position: number;
}

export interface RoomInfo {
  code: string;
  name: string;
  players: number;
  max_players: number;
  password: boolean;
  in_match: boolean;
  map: string;
  mode: number;
  /** Queue of a quick-play room. */
  quick: QuickQueue | null;
  jukebox: { video: string; title: string } | null;
  /** Names of the viewer's friends in the room. */
  friends: string[];
  /** Region name of the room's server ("" on a single-server setup). */
  region: string;
  /** Kilometres from the viewer to the room's server; null when unknown. */
  distance: number | null;
  /** ISO 3166-1 alpha-2 country of the host (upper case), if known. */
  country: string | null;
}

export interface PlayerInfo {
  id: number;
  name: string;
  team: number;
  ping_ms: number;
  host: boolean;
  /** Signed in: `name` is the account name. */
  account: boolean;
  /** False while the slot is held for a reconnect. */
  connected: boolean;
  /** Account level (0 for guests). */
  level: number;
  /** Appearance colour (0xRRGGBB). */
  color: number;
  /** In the map editor. */
  editing: boolean;
}

/** GameSettings serialises to an object keyed by Rust field names. */
export type GameSettings = Record<string, number | boolean | string>;

export interface RoomState {
  code: string;
  name: string;
  max_players: number;
  password: boolean;
  players: PlayerInfo[];
  settings: GameSettings;
  map_name: string;
  in_match: boolean;
  tick_hz: number;
  locked: boolean;
  bans: string[];
  /** Queue of a quick-play room (no host; maps rotate). */
  quick: QuickQueue | null;
  /** The start countdown is running. */
  starting: boolean;
  /** The current map, when it comes from the map library. */
  map: MapMeta | null;
  jukebox: JukeboxState | null;
}

/** Experience awarded to one player at the end of a game. */
export interface XpAward {
  /** Placement (1 = first; team modes: 1 won, 2 lost; -1 none). */
  placement: number;
  gained: number;
  /** Account total after the award (null for guests). */
  xp: number | null;
  /** Account level after the award (0 for guests). */
  level: number;
  /** The hourly ("short") or daily ("long") limit cut the award. */
  limit: "short" | "long" | null;
  /** Awarded by a quick-play rotation game. */
  quick: boolean;
}

export interface MatchStart {
  seed: number;
  start_tick: number;
  tick_hz: number;
  /** [player id, team] */
  players: [number, number][];
  settings: GameSettings;
  maps: string[];
  intro: boolean;
  rotation: boolean;
}

export type ServerMsg =
  | { t: "welcome"; version: number; server: string; rtc: boolean; region: string }
  | { t: "joined"; you: number; token: string }
  | { t: "rtc_answer"; sdp: string }
  | { t: "error"; code: string; message: string }
  | { t: "rooms"; rooms: RoomInfo[]; country: string | null }
  | { t: "redirect"; url: string; then: ClientMsg }
  | { t: "room"; room: RoomState }
  | { t: "left" }
  | { t: "chat"; from: number | null; name: string; text: string }
  | { t: "match_start"; start: MatchStart; you: number | null }
  | { t: "snapshot"; start: MatchStart; tick: number; state: string; you: number | null; held: [number, number][] }
  | { t: "match_end"; reason: string }
  | { t: "kicked"; reason: string }
  | { t: "tick_rate"; tick_hz: number }
  | { t: "typing"; player: number }
  | ({ t: "xp" } & XpAward)
  | { t: "suggest"; from: number; name: string; video: string; title: string }
  | { t: "jukebox"; jukebox: JukeboxState | null }
  | { t: "map_code"; code: string; name: string };

/** Mode numbers from crates/sim/src/settings.rs `mode` module. */
export const GAME_MODES: { id: number; name: string; team: boolean }[] = [
  { id: 0, name: "Kills", team: false },
  { id: 1, name: "Lives", team: false },
  { id: 2, name: "Rounds", team: false },
  { id: 3, name: "Team rounds", team: true },
  { id: 4, name: "Endless teams", team: true },
  { id: 5, name: "Lives teams", team: true },
  { id: 6, name: "Endless", team: false },
];

export function isTeamMode(mode: number): boolean {
  return GAME_MODES.some((m) => m.id === mode && m.team);
}
