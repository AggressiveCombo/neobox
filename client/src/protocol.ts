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

export type ClientMsg =
  | { t: "hello"; version: number; name: string }
  | { t: "list_rooms" }
  | { t: "create_room"; name: string; password: string | null; max_players: number; public: boolean }
  | { t: "join_room"; room: string; password: string | null }
  | { t: "leave_room" }
  | { t: "chat"; text: string }
  | { t: "set_team"; team: number }
  | { t: "set_map"; code: string; name: string | null }
  | { t: "set_setting"; key: string; value: string }
  | { t: "reset_settings" }
  | { t: "set_mode"; mode: number }
  | { t: "start" }
  | { t: "kick"; player: number; ban: boolean }
  | { t: "resync" }
  | { t: "rtc_offer"; sdp: string };

export interface RoomInfo {
  code: string;
  name: string;
  players: number;
  max_players: number;
  password: boolean;
  in_match: boolean;
  map: string;
}

export interface PlayerInfo {
  id: number;
  name: string;
  team: number;
  ping_ms: number;
  host: boolean;
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
  | { t: "welcome"; version: number; server: string; rtc: boolean }
  | { t: "joined"; you: number }
  | { t: "rtc_answer"; sdp: string }
  | { t: "error"; code: string; message: string }
  | { t: "rooms"; rooms: RoomInfo[] }
  | { t: "room"; room: RoomState }
  | { t: "left" }
  | { t: "chat"; from: number | null; name: string; text: string }
  | { t: "match_start"; start: MatchStart; you: number | null }
  | { t: "snapshot"; start: MatchStart; tick: number; state: string; you: number | null }
  | { t: "match_end"; reason: string }
  | { t: "kicked"; reason: string }
  | { t: "tick_rate"; tick_hz: number };

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
