//! Wire protocol.
//!
//! * Control messages (lobby, chat, match start/end, snapshots) are JSON text
//!   frames: [`ClientMsg`] / [`ServerMsg`].
//! * The gameplay hot path is binary frames: [`ClientFrame`] / [`ServerFrame`]
//!   (a few bytes per tick). Ticks are absolute `u32`s encoded as LEB128
//!   varints.

use neobox_sim::GameSettings;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;
/// Room size limit (the original allows 1..=10).
pub const MAX_ROOM_PLAYERS: u8 = 32;
/// Player name limit (characters) and allowed characters (letters, digits,
/// space, underscore), as in the original.
pub const MAX_NAME_LEN: usize = 15;
pub const MAX_CHAT_LEN: usize = 300;
pub const MAX_ROOM_NAME_LEN: usize = 50;

/// Teams.
pub const TEAM_SPECTATOR: u8 = 0;
pub const TEAM_FFA: u8 = 1;
pub const TEAM_RED: u8 = 2;
pub const TEAM_BLUE: u8 = 3;

pub fn valid_name(name: &str) -> bool {
    let n = name.chars().count();
    (1..=MAX_NAME_LEN).contains(&n) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_')
}

// ------------------------------------------------------------------ control (JSON)

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello { version: u16, name: String },
    ListRooms,
    CreateRoom { name: String, password: Option<String>, max_players: u8, public: bool },
    /// Join a room by code. `resume` is the token from an earlier `joined`:
    /// within the reconnect grace period it gives back the same player slot.
    JoinRoom {
        room: String,
        password: Option<String>,
        #[serde(default)]
        resume: Option<String>,
    },
    /// Join the fullest public, open, password-less room with space, or
    /// create one.
    QuickPlay,
    LeaveRoom,
    /// Chat line. Lines starting with `/` are commands (`/help` lists them).
    Chat { text: String },
    SetTeam { team: u8 },
    /// Host: load a map (Hitbox map code).
    SetMap { code: String, name: Option<String> },
    /// Host: `/set <key> <value>`.
    SetSetting { key: String, value: String },
    /// Host: reset settings to defaults (keeps the game mode).
    ResetSettings,
    /// Host: game mode.
    SetMode { mode: i32 },
    Start,
    /// Host: stop the running match (back to the lobby).
    EndMatch,
    /// Host: kick or ban a player.
    Kick { player: u32, ban: bool },
    /// Host: lift a ban (by the banned player's name as listed in `RoomState::bans`).
    Unban { name: String },
    /// Host: hand the host role to another player.
    GiveHost { player: u32 },
    /// Host: move another player to a team.
    MovePlayer { player: u32, team: u8 },
    /// Host: lock teams (players can no longer change their own team).
    SetLock { locked: bool },
    /// Ask for a full state snapshot (desync recovery).
    Resync,
    /// WebRTC offer (SDP) for the unreliable game data channel.
    RtcOffer { sdp: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RoomInfo {
    pub code: String,
    pub name: String,
    pub players: u8,
    pub max_players: u8,
    pub password: bool,
    pub in_match: bool,
    pub map: String,
    /// Game mode (see `GameSettings::game_mode`).
    pub mode: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PlayerInfo {
    pub id: u32,
    pub name: String,
    pub team: u8,
    pub ping_ms: u32,
    pub host: bool,
    /// Signed in: `name` is the account name.
    pub account: bool,
    /// False while the player's connection is lost and its slot is held for
    /// a reconnect.
    pub connected: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RoomState {
    pub code: String,
    pub name: String,
    pub max_players: u8,
    pub password: bool,
    pub players: Vec<PlayerInfo>,
    pub settings: GameSettings,
    pub map_name: String,
    pub in_match: bool,
    pub tick_hz: f64,
    /// Teams locked by the host.
    pub locked: bool,
    /// Names of banned players (the host can lift bans).
    pub bans: Vec<String>,
}

/// Everything a client needs to reproduce a match deterministically.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MatchStart {
    pub seed: u32,
    /// Tick of the initial state.
    pub start_tick: u32,
    pub tick_hz: f64,
    /// (player id, team)
    pub players: Vec<(u32, f64)>,
    pub settings: GameSettings,
    /// Rotation playlist (map codes); the first one is played first.
    pub maps: Vec<String>,
    pub intro: bool,
    pub rotation: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    /// `rtc`: the server accepts WebRTC data channels (`rtc_offer`).
    Welcome { version: u16, server: String, rtc: bool },
    /// Sent to a player entering a room: its player id there and the token
    /// that resumes this slot after a lost connection (`join_room.resume`).
    Joined { you: u32, token: String },
    Error { code: String, message: String },
    Rooms { rooms: Vec<RoomInfo> },
    Room { room: RoomState },
    Left,
    Chat { from: Option<u32>, name: String, text: String },
    MatchStart { start: MatchStart, you: Option<u32> },
    /// Full state at `tick` (postcard + zlib, base64) for late joiners and
    /// desync recovery. Batches continue from `tick`.
    /// `held`: input masks players hold at that point (the state does not
    /// record them; see `ServerMatch::held_masks`).
    Snapshot { start: MatchStart, tick: u32, state: String, you: Option<u32>, held: Vec<(u32, u8)> },
    MatchEnd { reason: String },
    Kicked { reason: String },
    TickRate { tick_hz: f64 },
    /// WebRTC answer (SDP) to `rtc_offer`.
    RtcAnswer { sdp: String },
}

// ------------------------------------------------------------------ binary codec

#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    pub fn var(&mut self, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.buf.push(b);
                return;
            }
            self.buf.push(b | 0x80);
        }
    }
    pub fn svar(&mut self, v: i64) {
        self.var(((v << 1) ^ (v >> 63)) as u64);
    }
    pub fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
}

pub struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DecodeError;

impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8]) -> Reader<'a> {
        Reader { b, pos: 0 }
    }
    pub fn u8(&mut self) -> Result<u8, DecodeError> {
        let v = *self.b.get(self.pos).ok_or(DecodeError)?;
        self.pos += 1;
        Ok(v)
    }
    pub fn var(&mut self) -> Result<u64, DecodeError> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.u8()?;
            v |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(DecodeError)
    }
    pub fn var32(&mut self) -> Result<u32, DecodeError> {
        u32::try_from(self.var()?).map_err(|_| DecodeError)
    }
    pub fn svar(&mut self) -> Result<i64, DecodeError> {
        let u = self.var()?;
        Ok(((u >> 1) as i64) ^ -((u & 1) as i64))
    }
    pub fn f64(&mut self) -> Result<f64, DecodeError> {
        let s = self.b.get(self.pos..self.pos + 8).ok_or(DecodeError)?;
        self.pos += 8;
        Ok(f64::from_le_bytes(s.try_into().map_err(|_| DecodeError)?))
    }
    pub fn u64(&mut self) -> Result<u64, DecodeError> {
        let s = self.b.get(self.pos..self.pos + 8).ok_or(DecodeError)?;
        self.pos += 8;
        Ok(u64::from_le_bytes(s.try_into().map_err(|_| DecodeError)?))
    }
    pub fn done(&self) -> bool {
        self.pos == self.b.len()
    }
}

/// Inputs from a client: every input change not yet acknowledged (resent
/// until acknowledged, so a lost packet costs nothing) plus the client's
/// current tick as a heartbeat for timing feedback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputFrame {
    /// The client's confirmed tick (it has every tick below).
    pub ack: u32,
    /// The client's current (predicted) tick.
    pub now: u32,
    /// (sequence number, tick, mask) of each change, ascending sequence.
    pub changes: Vec<(u32, u32, u8)>,
}

/// Join/leave event for a tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TickEvent {
    Leave(u32),
    Join(u32, f64),
}

/// Confirmed inputs and events effective at one tick.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TickData {
    pub tick: u32,
    /// (player, new mask)
    pub changes: Vec<(u32, u8)>,
    pub events: Vec<TickEvent>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClientFrame {
    Input(InputFrame),
    Ping { client_time: f64 },
}

#[derive(Clone, Debug, PartialEq)]
pub enum ServerFrame {
    /// Consecutive confirmed ticks, plus per-recipient feedback: the newest
    /// input change sequence number processed, and how many ticks early the
    /// client's heartbeat arrived (in 1/16 ticks; negative = late).
    Batch { ticks: Vec<TickData>, input_ack: u32, margin16: i32 },
    Pong { client_time: f64, server_tick: u32, tick_phase: f64 },
    Checksum { tick: u32, hash: u64 },
}

const C_INPUT: u8 = 1;
const C_PING: u8 = 2;
const S_BATCH: u8 = 0x81;
const S_PONG: u8 = 0x82;
const S_CHECKSUM: u8 = 0x83;

impl ClientFrame {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        match self {
            ClientFrame::Input(f) => {
                w.u8(C_INPUT);
                w.var(f.ack as u64);
                w.var(f.now as u64);
                w.u8(f.changes.len() as u8);
                for (seq, t, m) in &f.changes {
                    w.var(*seq as u64);
                    w.svar(*t as i64 - f.now as i64);
                    w.u8(*m);
                }
            }
            ClientFrame::Ping { client_time } => {
                w.u8(C_PING);
                w.f64(*client_time);
            }
        }
        w.buf
    }

    pub fn decode(b: &[u8]) -> Result<ClientFrame, DecodeError> {
        let mut r = Reader::new(b);
        let f = match r.u8()? {
            C_INPUT => {
                let ack = r.var32()?;
                let now = r.var32()?;
                let n = r.u8()? as usize;
                if n > 64 {
                    return Err(DecodeError);
                }
                let mut changes = Vec::with_capacity(n);
                for _ in 0..n {
                    let seq = r.var32()?;
                    let t = now as i64 + r.svar()?;
                    let t = u32::try_from(t).map_err(|_| DecodeError)?;
                    changes.push((seq, t, r.u8()?));
                }
                ClientFrame::Input(InputFrame { ack, now, changes })
            }
            C_PING => ClientFrame::Ping { client_time: r.f64()? },
            _ => return Err(DecodeError),
        };
        if !r.done() {
            return Err(DecodeError);
        }
        Ok(f)
    }
}

impl ServerFrame {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        match self {
            ServerFrame::Batch { ticks, input_ack, margin16 } => {
                w.u8(S_BATCH);
                w.var(*input_ack as u64);
                w.svar(*margin16 as i64);
                w.var(ticks.first().map_or(0, |t| t.tick) as u64);
                w.var(ticks.len() as u64);
                for t in ticks {
                    w.var(t.changes.len() as u64);
                    for (p, m) in &t.changes {
                        w.var(*p as u64);
                        w.u8(*m);
                    }
                    w.var(t.events.len() as u64);
                    for e in &t.events {
                        match e {
                            TickEvent::Leave(p) => {
                                w.u8(0);
                                w.var(*p as u64);
                            }
                            TickEvent::Join(p, team) => {
                                w.u8(1);
                                w.var(*p as u64);
                                w.f64(*team);
                            }
                        }
                    }
                }
            }
            ServerFrame::Pong { client_time, server_tick, tick_phase } => {
                w.u8(S_PONG);
                w.f64(*client_time);
                w.var(*server_tick as u64);
                w.f64(*tick_phase);
            }
            ServerFrame::Checksum { tick, hash } => {
                w.u8(S_CHECKSUM);
                w.var(*tick as u64);
                w.u64(*hash);
            }
        }
        w.buf
    }

    pub fn decode(b: &[u8]) -> Result<ServerFrame, DecodeError> {
        let mut r = Reader::new(b);
        let f = match r.u8()? {
            S_BATCH => {
                let input_ack = r.var32()?;
                let margin16 = r.svar()? as i32;
                let first = r.var32()?;
                let n = r.var()? as usize;
                if n > 4096 {
                    return Err(DecodeError);
                }
                let mut ticks = Vec::with_capacity(n);
                for i in 0..n {
                    let nc = r.var()? as usize;
                    if nc > 4096 {
                        return Err(DecodeError);
                    }
                    let mut changes = Vec::with_capacity(nc);
                    for _ in 0..nc {
                        changes.push((r.var32()?, r.u8()?));
                    }
                    let ne = r.var()? as usize;
                    if ne > 4096 {
                        return Err(DecodeError);
                    }
                    let mut events = Vec::with_capacity(ne);
                    for _ in 0..ne {
                        events.push(match r.u8()? {
                            0 => TickEvent::Leave(r.var32()?),
                            1 => TickEvent::Join(r.var32()?, r.f64()?),
                            _ => return Err(DecodeError),
                        });
                    }
                    ticks.push(TickData { tick: first + i as u32, changes, events });
                }
                ServerFrame::Batch { ticks, input_ack, margin16 }
            }
            S_PONG => ServerFrame::Pong { client_time: r.f64()?, server_tick: r.var32()?, tick_phase: r.f64()? },
            S_CHECKSUM => ServerFrame::Checksum { tick: r.var32()?, hash: r.u64()? },
            _ => return Err(DecodeError),
        };
        if !r.done() {
            return Err(DecodeError);
        }
        Ok(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_roundtrip() {
        let c = ClientFrame::Input(InputFrame { ack: 1234, now: 1301, changes: vec![(7, 1300, 2), (8, 1305, 6), (9, 1306, 0)] });
        assert_eq!(ClientFrame::decode(&c.encode()).unwrap(), c);
        let s = ServerFrame::Batch {
            ticks: vec![
                TickData { tick: 99, changes: vec![(0, 3), (7, 128)], events: vec![TickEvent::Join(7, 2.0)] },
                TickData { tick: 100, changes: vec![], events: vec![TickEvent::Leave(3)] },
            ],
            input_ack: 101,
            margin16: -9,
        };
        assert_eq!(ServerFrame::decode(&s.encode()).unwrap(), s);
        assert!(ClientFrame::decode(&[1, 0x80]).is_err());
    }
}
