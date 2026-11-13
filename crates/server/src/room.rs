//! A room: lobby (players, teams, chat, host settings, map) and, while a
//! match runs, the authoritative input timeline ticking at the room's rate.

use crate::hub::{ConnInfo, Hub, Out};
use base64::Engine;
use neobox_net::*;
use neobox_sim::start::Outcome;
use neobox_sim::{GameSettings, MapData};
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

/// Longest map code accepted from clients (characters).
pub const MAX_MAP_CODE: usize = 2 * 1024 * 1024;
/// Confirmed ticks kept for resending.
const HISTORY: usize = 256;
/// Clients further behind than this get a snapshot instead of batches.
const MAX_CATCHUP: u32 = 90;

pub enum RoomCmd {
    Join { conn: ConnInfo, password: Option<String>, reply: oneshot::Sender<Result<u32, (String, String)>> },
    Leave { player: u32 },
    Msg { player: u32, msg: ClientMsg },
    Frame { player: u32, frame: ClientFrame },
    Admin(AdminCmd),
    View { reply: oneshot::Sender<Option<Vec<u8>>> },
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AdminCmd {
    Close,
    Kick { player: u32, ban: bool },
    EndMatch,
    SetTickRate { hz: f64 },
    Say { text: String },
    SetHost { player: u32 },
    SetMaxPlayers { max: u8 },
    SetTeam { player: u32, team: u8 },
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct PlayerSummary {
    pub id: u32,
    pub name: String,
    pub team: u8,
    pub host: bool,
    pub ping_ms: u32,
    pub ip: String,
    pub bytes_in_per_s: u64,
    pub bytes_out_per_s: u64,
    pub margin_ticks: f64,
    /// "udp" (WebRTC data channel) or "ws"
    pub transport: &'static str,
    pub input_mask: u8,
    pub connected_s: u64,
    pub in_match: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct RoomSummary {
    pub code: String,
    pub name: String,
    pub password: bool,
    pub public: bool,
    pub max_players: u8,
    pub players: Vec<PlayerSummary>,
    pub in_match: bool,
    pub tick: u32,
    pub tick_hz: f64,
    pub map_name: String,
    pub game_mode: i32,
    pub step_avg_us: f64,
    pub step_max_us: f64,
    pub created_ms: u64,
    pub match_seconds: f64,
    pub bytes_in_per_s: u64,
    pub bytes_out_per_s: u64,
    pub settings: Option<GameSettings>,
    pub round: Option<serde_json::Value>,
}

struct RPlayer {
    id: u32,
    conn: ConnInfo,
    team: u8,
    in_match: bool,
    /// next tick the client needs (its confirmed tick)
    ack: u32,
    last_sent: Option<u32>,
    margin16: i32,
    chat_tokens: f64,
    chat_at: Instant,
    last_bytes: (u64, u64),
    rate: (u64, u64),
}

struct Game {
    m: ServerMatch,
    history: VecDeque<TickData>,
    next_tick: Instant,
    started: Instant,
    step_total_us: f64,
    step_count: u64,
    step_max_us: f64,
    /// time spent in consecutive steps slower than real time
    slow_us: f64,
}

/// A match whose steps stay slower than real time this long is stopped.
const SLOW_LIMIT_US: f64 = 3e6;

pub struct Room {
    hub: Arc<Hub>,
    code: String,
    name: String,
    password: Option<String>,
    public: bool,
    max_players: u8,
    players: Vec<RPlayer>,
    host: Option<u32>,
    settings: GameSettings,
    map_code: String,
    map_name: String,
    tick_hz: f64,
    next_id: u32,
    bans: HashSet<String>,
    game: Option<Game>,
    summary: Arc<Mutex<RoomSummary>>,
    created: u64,
    closed: bool,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Create a room and start its task.
pub fn spawn(hub: Arc<Hub>, code: String, name: String, password: Option<String>, max_players: u8, public: bool) -> crate::hub::RoomHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let summary = Arc::new(Mutex::new(RoomSummary { code: code.clone(), name: name.clone(), ..RoomSummary::default() }));
    let map = hub.maps.first().cloned();
    let room = Room {
        tick_hz: hub.cfg.default_tick_hz,
        hub: hub.clone(),
        code: code.clone(),
        name,
        password: password.filter(|p| !p.is_empty()),
        public,
        max_players: max_players.clamp(1, hub.cfg.max_players),
        players: Vec::new(),
        host: None,
        settings: GameSettings::default(),
        map_code: map.as_ref().map(|m| m.code.clone()).unwrap_or_default(),
        map_name: map.map(|m| m.name).unwrap_or_default(),
        next_id: 0,
        bans: HashSet::new(),
        game: None,
        summary: summary.clone(),
        created: now_ms(),
        closed: false,
    };
    let handle = crate::hub::RoomHandle { tx, summary };
    tokio::spawn(room.run(rx));
    handle
}

fn ip_key(ip: &IpAddr) -> String {
    format!("ip:{ip}")
}

impl Room {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<RoomCmd>) {
        info!(room = %self.code, name = %self.name, "room created");
        let mut stats = tokio::time::interval(Duration::from_secs(1));
        stats.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        self.update_summary();
        loop {
            let deadline = self.game.as_ref().map(|g| g.next_tick);
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(c) => self.handle(c),
                    None => break,
                },
                _ = async { tokio::time::sleep_until(deadline.unwrap().into()).await }, if deadline.is_some() => {
                    self.run_ticks();
                }
                _ = stats.tick() => {
                    self.update_summary();
                    if self.game.is_none() {
                        self.broadcast_room();
                    }
                }
            }
            if self.closed || self.players.is_empty() {
                break;
            }
        }
        for p in &self.players {
            p.conn.send(Out::Text(json(&ServerMsg::Left)));
        }
        self.hub.rooms.lock().unwrap().remove(&self.code);
        info!(room = %self.code, "room closed");
    }

    fn handle(&mut self, cmd: RoomCmd) {
        match cmd {
            RoomCmd::Join { conn, password, reply } => {
                let r = self.join(conn, password);
                let _ = reply.send(r);
            }
            RoomCmd::Leave { player } => self.leave(player, "left"),
            RoomCmd::Msg { player, msg } => self.message(player, msg),
            RoomCmd::Frame { player, frame } => self.frame(player, frame),
            RoomCmd::Admin(a) => self.admin(a),
            RoomCmd::View { reply } => {
                let frame = self.game.as_ref().map(|g| {
                    let mut fb = neobox_wasm::frame::FrameBuilder::default();
                    let meta = neobox_wasm::frame::Meta { tick: g.m.tick, local: -1, ..Default::default() };
                    fb.build(&g.m.state, &g.m.state, 1.0, &g.m.start.settings, meta, &[]);
                    fb.words.iter().flat_map(|w| w.to_le_bytes()).collect()
                });
                let _ = reply.send(frame);
            }
        }
    }

    fn player(&self, id: u32) -> Option<&RPlayer> {
        self.players.iter().find(|p| p.id == id)
    }

    fn player_mut(&mut self, id: u32) -> Option<&mut RPlayer> {
        self.players.iter_mut().find(|p| p.id == id)
    }

    fn is_host(&self, id: u32) -> bool {
        self.host == Some(id)
    }

    fn error(&self, id: u32, code: &str, message: &str) {
        if let Some(p) = self.player(id) {
            p.conn.send(Out::Text(json(&ServerMsg::Error { code: code.into(), message: message.into() })));
        }
    }

    fn system_chat(&self, text: &str) {
        let m = json(&ServerMsg::Chat { from: None, name: String::new(), text: text.into() });
        for p in &self.players {
            p.conn.send(Out::Text(m.clone()));
        }
    }

    /// Team for a new player: FFA, or the smaller team in team modes.
    fn default_team(&self) -> u8 {
        if self.settings.is_team_mode() {
            let red = self.players.iter().filter(|p| p.team == TEAM_RED).count();
            let blue = self.players.iter().filter(|p| p.team == TEAM_BLUE).count();
            if red <= blue { TEAM_RED } else { TEAM_BLUE }
        } else {
            TEAM_FFA
        }
    }

    fn join(&mut self, conn: ConnInfo, password: Option<String>) -> Result<u32, (String, String)> {
        if self.bans.contains(&ip_key(&conn.ip)) {
            return Err(("banned".into(), "You are banned from this room".into()));
        }
        if let Some(pw) = &self.password {
            if password.as_deref() != Some(pw.as_str()) {
                return Err(("wrong_password".into(), "Wrong password".into()));
            }
        }
        if self.players.len() >= self.max_players as usize {
            return Err(("room_full".into(), "The room is full".into()));
        }
        let id = self.next_id;
        self.next_id += 1;
        let team = self.default_team();
        info!(room = %self.code, player = id, name = %conn.name, ip = %conn.ip, "join");
        let mut p = RPlayer {
            id,
            conn,
            team,
            in_match: false,
            ack: 0,
            last_sent: None,
            margin16: 0,
            chat_tokens: 3.0,
            chat_at: Instant::now(),
            last_bytes: (0, 0),
            rate: (0, 0),
        };
        p.conn.send(Out::Text(json(&ServerMsg::Joined { you: id })));
        if self.host.is_none() {
            self.host = Some(id);
        }
        if let Some(g) = self.game.as_mut() {
            // late join: enter the running match at the current tick
            if team != TEAM_SPECTATOR {
                g.m.join(id, team as f64);
                p.in_match = true;
            }
            p.ack = g.m.tick;
            p.last_sent = None;
            let snap = ServerMsg::Snapshot {
                start: g.m.start.clone(),
                tick: g.m.tick,
                state: base64::engine::general_purpose::STANDARD.encode(g.m.snapshot()),
                you: Some(id),
            };
            p.conn.send(Out::Text(json(&ServerMsg::Room { room: self.room_state() })));
            p.conn.send(Out::Text(json(&snap)));
        }
        self.players.push(p);
        self.broadcast_room();
        Ok(id)
    }

    fn leave(&mut self, id: u32, why: &str) {
        let Some(i) = self.players.iter().position(|p| p.id == id) else { return };
        let p = self.players.remove(i);
        info!(room = %self.code, player = id, name = %p.conn.name, reason = why, "leave");
        if let Some(g) = self.game.as_mut() {
            if p.in_match {
                g.m.leave(id);
            }
        }
        if self.host == Some(id) {
            self.host = self.players.iter().map(|p| p.id).min();
            if let Some(h) = self.host {
                if let Some(np) = self.player(h) {
                    self.system_chat(&format!("{} is now the host", np.conn.name));
                }
            }
        }
        self.broadcast_room();
    }

    fn room_state(&self) -> RoomState {
        RoomState {
            code: self.code.clone(),
            name: self.name.clone(),
            max_players: self.max_players,
            password: self.password.is_some(),
            players: self
                .players
                .iter()
                .map(|p| PlayerInfo { id: p.id, name: p.conn.name.clone(), team: p.team, ping_ms: p.conn.stats.rtt(), host: self.host == Some(p.id) })
                .collect(),
            settings: self.settings.clone(),
            map_name: self.map_name.clone(),
            in_match: self.game.is_some(),
            tick_hz: self.tick_hz,
        }
    }

    fn broadcast_room(&self) {
        let m = json(&ServerMsg::Room { room: self.room_state() });
        for p in &self.players {
            p.conn.send(Out::Text(m.clone()));
        }
    }

    fn message(&mut self, id: u32, msg: ClientMsg) {
        let host = self.is_host(id);
        let running = self.game.is_some();
        match msg {
            ClientMsg::Chat { text } => {
                let text: String = text.chars().take(MAX_CHAT_LEN).collect::<String>().trim().to_string();
                if text.is_empty() {
                    return;
                }
                let Some(p) = self.player_mut(id) else { return };
                // 3 messages burst, then one every 3 seconds
                let now = Instant::now();
                p.chat_tokens = (p.chat_tokens + now.duration_since(p.chat_at).as_secs_f64() / 3.0).min(3.0);
                p.chat_at = now;
                if p.chat_tokens < 1.0 {
                    p.conn.send(Out::Text(json(&ServerMsg::Error { code: "rate_limited".into(), message: "You're doing that too much!".into() })));
                    return;
                }
                p.chat_tokens -= 1.0;
                let m = json(&ServerMsg::Chat { from: Some(id), name: p.conn.name.clone(), text });
                for q in &self.players {
                    q.conn.send(Out::Text(m.clone()));
                }
            }
            ClientMsg::SetTeam { team } => {
                if team > TEAM_BLUE {
                    return;
                }
                let team_mode = self.settings.is_team_mode();
                let team = match team {
                    TEAM_FFA if team_mode => return self.error(id, "bad_team", "This mode uses red and blue teams"),
                    TEAM_RED | TEAM_BLUE if !team_mode => return self.error(id, "bad_team", "Teams are only used in team modes"),
                    t => t,
                };
                let Some(p) = self.player_mut(id) else { return };
                let was = p.team;
                p.team = team;
                let in_match = p.in_match;
                if let Some(g) = self.game.as_mut() {
                    if was != team {
                        if in_match {
                            g.m.leave(id);
                        }
                        if team != TEAM_SPECTATOR {
                            g.m.join(id, team as f64);
                        }
                        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
                            p.in_match = team != TEAM_SPECTATOR;
                        }
                    }
                }
                self.broadcast_room();
            }
            ClientMsg::SetMap { code, name } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can change the map");
                }
                if running {
                    return self.error(id, "in_match", "Wait for the match to end");
                }
                if code.len() > MAX_MAP_CODE {
                    return self.error(id, "map_too_large", "Map is too large");
                }
                match MapData::from_code(code.trim()) {
                    Ok(_) => {
                        self.map_code = code.trim().to_string();
                        self.map_name = name.map(|n| n.chars().take(60).collect()).unwrap_or_else(|| "Custom map".into());
                        self.system_chat(&format!("Map changed to {}", self.map_name));
                        self.broadcast_room();
                    }
                    Err(e) => self.error(id, "bad_map", &format!("Could not load the map: {e}")),
                }
            }
            ClientMsg::SetSetting { key, value } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can change settings");
                }
                let mut s = self.settings.clone();
                match s.set(&key, &value) {
                    Ok(confirm) => match s.validate() {
                        Ok(()) => {
                            self.settings = s;
                            self.system_chat(&confirm);
                            if running {
                                self.system_chat("Settings apply from the next match");
                            }
                            self.broadcast_room();
                        }
                        Err(what) => self.error(id, "bad_setting", &format!("Invalid value for {what}")),
                    },
                    Err(e) => self.error(id, "bad_setting", &e),
                }
            }
            ClientMsg::ResetSettings => {
                if !host {
                    return;
                }
                let mode = self.settings.game_mode;
                self.settings = GameSettings { game_mode: mode, ..GameSettings::default() };
                self.system_chat("Settings reset");
                self.broadcast_room();
            }
            ClientMsg::SetMode { mode } => {
                if !host || !(0..=6).contains(&mode) {
                    return;
                }
                self.settings.game_mode = mode;
                // move players to fitting teams
                let team_mode = self.settings.is_team_mode();
                let mut red = 0;
                let mut blue = 0;
                for p in self.players.iter_mut() {
                    if p.team == TEAM_SPECTATOR {
                        continue;
                    }
                    if team_mode && p.team == TEAM_FFA {
                        p.team = if red <= blue { TEAM_RED } else { TEAM_BLUE };
                    } else if !team_mode {
                        p.team = TEAM_FFA;
                    }
                    if p.team == TEAM_RED {
                        red += 1;
                    } else if p.team == TEAM_BLUE {
                        blue += 1;
                    }
                }
                self.broadcast_room();
            }
            ClientMsg::Start => {
                if !host {
                    return self.error(id, "not_host", "Only the host can start");
                }
                if running {
                    return;
                }
                self.start_match();
            }
            ClientMsg::Kick { player, ban } => {
                if !host || player == id {
                    return;
                }
                self.kick(player, ban);
            }
            ClientMsg::Resync => {
                if let (Some(g), Some(p)) = (self.game.as_ref(), self.players.iter().find(|p| p.id == id)) {
                    let snap = ServerMsg::Snapshot {
                        start: g.m.start.clone(),
                        tick: g.m.tick,
                        state: base64::engine::general_purpose::STANDARD.encode(g.m.snapshot()),
                        you: Some(id),
                    };
                    p.conn.send(Out::Text(json(&snap)));
                    let tick = g.m.tick;
                    if let Some(p) = self.player_mut(id) {
                        p.ack = tick;
                        p.last_sent = None;
                    }
                    warn!(room = %self.code, player = id, "resync requested");
                }
            }
            ClientMsg::Hello { .. }
            | ClientMsg::ListRooms
            | ClientMsg::CreateRoom { .. }
            | ClientMsg::JoinRoom { .. }
            | ClientMsg::LeaveRoom
            | ClientMsg::RtcOffer { .. } => {}
        }
    }

    fn kick(&mut self, player: u32, ban: bool) {
        let Some(p) = self.player(player) else { return };
        let (ip, name) = (ip_key(&p.conn.ip), p.conn.name.clone());
        p.conn.send(Out::Text(json(&ServerMsg::Kicked { reason: if ban { "You were banned".into() } else { "You were kicked".into() } })));
        p.conn.send(Out::Close(if ban { "banned" } else { "kicked" }.into()));
        if ban {
            self.bans.insert(ip);
        }
        self.leave(player, if ban { "banned" } else { "kicked" });
        self.system_chat(&format!("{name} was {}", if ban { "banned" } else { "kicked" }));
    }

    fn start_match(&mut self) {
        let players: Vec<(u32, f64)> = self.players.iter().filter(|p| p.team != TEAM_SPECTATOR).map(|p| (p.id, p.team as f64)).collect();
        if players.is_empty() {
            return self.system_chat("Nobody to play: everyone is spectating");
        }
        if self.map_code.is_empty() {
            return self.system_chat("No map selected");
        }
        let start = MatchStart {
            seed: rand::random::<u16>() as u32 + 1,
            start_tick: 0,
            tick_hz: self.tick_hz,
            players,
            settings: self.settings.clone(),
            maps: vec![self.map_code.clone()],
            intro: true,
            rotation: false,
        };
        let m = match ServerMatch::new(start.clone()) {
            Ok(m) => m,
            Err(e) => return self.system_chat(&format!("Could not start: {e}")),
        };
        info!(room = %self.code, players = start.players.len(), map = %self.map_name, mode = self.settings.game_mode, "match start");
        for p in self.players.iter_mut() {
            p.in_match = p.team != TEAM_SPECTATOR;
            p.ack = start.start_tick;
            p.last_sent = None;
            p.margin16 = 0;
            p.conn.send(Out::Text(json(&ServerMsg::MatchStart { start: start.clone(), you: Some(p.id) })));
        }
        let now = Instant::now();
        self.game = Some(Game {
            m,
            history: VecDeque::with_capacity(HISTORY),
            // give clients a moment to set up before the first tick
            next_tick: now + Duration::from_millis(100),
            started: now,
            step_total_us: 0.0,
            step_count: 0,
            step_max_us: 0.0,
            slow_us: 0.0,
        });
        self.broadcast_room();
    }

    fn end_match(&mut self, reason: &str) {
        if self.game.take().is_some() {
            info!(room = %self.code, reason, "match end");
            let m = json(&ServerMsg::MatchEnd { reason: reason.into() });
            for p in self.players.iter_mut() {
                p.in_match = false;
                p.conn.send(Out::Text(m.clone()));
            }
            self.broadcast_room();
        }
    }

    fn frame(&mut self, id: u32, frame: ClientFrame) {
        match frame {
            ClientFrame::Ping { client_time } => {
                let (tick, phase) = match &self.game {
                    Some(g) => {
                        let to_next = g.next_tick.saturating_duration_since(Instant::now()).as_secs_f64();
                        (g.m.tick, (1.0 - to_next * self.tick_hz).clamp(0.0, 1.0))
                    }
                    None => (0, 0.0),
                };
                if let Some(p) = self.player(id) {
                    p.conn.send(Out::Binary(ServerFrame::Pong { client_time, server_tick: tick, tick_phase: phase }.encode()));
                }
            }
            ClientFrame::Input(f) => {
                let Some(g) = self.game.as_mut() else { return };
                let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { return };
                p.ack = p.ack.max(f.ack);
                if !p.in_match {
                    return;
                }
                let m = g.m.submit(id, &f).margin;
                // fraction of the current tick already elapsed counts against the margin
                let to_next = g.next_tick.saturating_duration_since(Instant::now()).as_secs_f64() * self.tick_hz;
                let precise = m as f64 - (1.0 - to_next.clamp(0.0, 1.0));
                p.margin16 = (precise * 16.0).round().clamp(-30000.0, 30000.0) as i32;
            }
        }
    }

    fn run_ticks(&mut self) {
        let period = Duration::from_secs_f64(1.0 / self.tick_hz);
        let mut steps = 0;
        loop {
            let Some(g) = self.game.as_mut() else { return };
            let now = Instant::now();
            if now < g.next_tick {
                break;
            }
            if steps >= 5 {
                // far behind (machine stalled): drop the backlog instead of bursting
                g.next_tick = now + period;
                break;
            }
            let t0 = Instant::now();
            let data = g.m.step();
            let us = t0.elapsed().as_secs_f64() * 1e6;
            g.step_total_us += us;
            g.step_count += 1;
            g.step_max_us = g.step_max_us.max(us);
            // one slow tick is a hiccup; seconds of them mean the map cannot run in real time
            g.slow_us = if us > period.as_secs_f64() * 1e6 { g.slow_us + us } else { 0.0 };
            let too_heavy = g.m.overloaded() || g.slow_us > SLOW_LIMIT_US;
            g.history.push_back(data);
            while g.history.len() > HISTORY {
                g.history.pop_front();
            }
            g.next_tick += period;
            steps += 1;
            let checksum = (g.m.tick % CHECKSUM_INTERVAL == 0).then(|| g.m.checksum());
            let outcome = g.m.last_outcome;
            self.send_batches(checksum);
            if too_heavy {
                warn!(room = %self.code, map = %self.map_name, "map too complex to simulate: match stopped");
                self.system_chat("This map is too complex to simulate, so the match was stopped.");
                self.end_match("map too complex");
                return;
            }
            if outcome == Outcome::MatchOver {
                self.end_match("game over");
                return;
            }
        }
    }

    fn send_batches(&mut self, checksum: Option<u64>) {
        let Some(g) = self.game.as_ref() else { return };
        let latest = g.m.tick; // ticks below are confirmed
        let first_kept = g.history.front().map_or(latest, |d| d.tick);
        let mut snapshots = Vec::new();
        for p in self.players.iter_mut() {
            // over the unreliable data channel every unconfirmed tick is
            // resent (a few bytes each), so a lost packet costs nothing
            let from = match p.last_sent {
                Some(s) if !p.conn.stats.udp.load(std::sync::atomic::Ordering::Relaxed) => (s + 1).max(p.ack),
                _ => p.ack,
            };
            if from >= latest {
                continue;
            }
            if from < first_kept || latest - from > MAX_CATCHUP {
                snapshots.push(p.id);
                continue;
            }
            let ticks: Vec<TickData> = g.history.iter().filter(|d| d.tick >= from).cloned().collect();
            let input_ack = g.m.input_ack(p.id);
            p.conn.send(Out::Binary(ServerFrame::Batch { ticks, input_ack, margin16: p.margin16 }.encode()));
            p.last_sent = Some(latest - 1);
            if let Some(h) = checksum {
                p.conn.send(Out::Binary(ServerFrame::Checksum { tick: latest, hash: h }.encode()));
            }
        }
        for id in snapshots {
            warn!(room = %self.code, player = id, "client too far behind: sending snapshot");
            self.message(id, ClientMsg::Resync);
        }
    }

    fn admin(&mut self, cmd: AdminCmd) {
        info!(room = %self.code, ?cmd, "admin command");
        match cmd {
            AdminCmd::Close => {
                self.system_chat("This room was closed by an administrator");
                for p in &self.players {
                    p.conn.send(Out::Text(json(&ServerMsg::Kicked { reason: "Room closed by an administrator".into() })));
                }
                self.closed = true;
            }
            AdminCmd::Kick { player, ban } => self.kick(player, ban),
            AdminCmd::EndMatch => self.end_match("ended by an administrator"),
            AdminCmd::SetTickRate { hz } => {
                if hz.is_finite() && (5.0..=120.0).contains(&hz) {
                    self.tick_hz = hz;
                    let m = Out::Text(json(&ServerMsg::TickRate { tick_hz: hz }));
                    for p in &self.players {
                        p.conn.send(Out::Text(json(&ServerMsg::TickRate { tick_hz: hz })));
                    }
                    drop(m);
                    if self.game.is_some() {
                        self.system_chat(&format!("Tick rate set to {hz} Hz (applies from the next match)"));
                    }
                    self.broadcast_room();
                }
            }
            AdminCmd::Say { text } => self.system_chat(&format!("[admin] {}", text.chars().take(MAX_CHAT_LEN).collect::<String>())),
            AdminCmd::SetHost { player } => {
                if self.player(player).is_some() {
                    self.host = Some(player);
                    self.broadcast_room();
                }
            }
            AdminCmd::SetMaxPlayers { max } => {
                self.max_players = max.clamp(1, self.hub.cfg.max_players);
                self.broadcast_room();
            }
            AdminCmd::SetTeam { player, team } => {
                if team <= TEAM_BLUE {
                    self.message(player, ClientMsg::SetTeam { team });
                }
            }
        }
    }

    fn update_summary(&mut self) {
        for p in self.players.iter_mut() {
            let bi = p.conn.stats.bytes_in.load(std::sync::atomic::Ordering::Relaxed);
            let bo = p.conn.stats.bytes_out.load(std::sync::atomic::Ordering::Relaxed);
            p.rate = (bi.saturating_sub(p.last_bytes.0), bo.saturating_sub(p.last_bytes.1));
            p.last_bytes = (bi, bo);
        }
        let mut s = self.summary.lock().unwrap();
        s.code = self.code.clone();
        s.name = self.name.clone();
        s.password = self.password.is_some();
        s.public = self.public;
        s.max_players = self.max_players;
        s.in_match = self.game.is_some();
        s.tick_hz = self.tick_hz;
        s.map_name = self.map_name.clone();
        s.game_mode = self.settings.game_mode;
        s.created_ms = self.created;
        s.settings = Some(self.settings.clone());
        s.bytes_in_per_s = self.players.iter().map(|p| p.rate.0).sum();
        s.bytes_out_per_s = self.players.iter().map(|p| p.rate.1).sum();
        match &mut self.game {
            Some(g) => {
                s.tick = g.m.tick;
                s.step_avg_us = if g.step_count > 0 { g.step_total_us / g.step_count as f64 } else { 0.0 };
                s.step_max_us = g.step_max_us;
                s.match_seconds = g.started.elapsed().as_secs_f64();
                let r = &g.m.state.round;
                s.round = Some(serde_json::json!({
                    "intro": r.intro, "round_over": r.round_over, "game_over": r.game_over,
                    "round": r.round_number, "winner": r.winner, "red": r.red, "blue": r.blue,
                    "players": r.players.iter().map(|(id, p)| serde_json::json!({
                        "id": id, "team": p.team, "kills": p.kills, "wins": p.wins, "lives": p.lives, "alive": p.alive
                    })).collect::<Vec<_>>(),
                    "bodies": g.m.state.bodies.len(), "projectiles": g.m.state.projectiles.len(),
                }));
                g.step_total_us = 0.0;
                g.step_count = 0;
                g.step_max_us = 0.0;
            }
            None => {
                s.tick = 0;
                s.step_avg_us = 0.0;
                s.step_max_us = 0.0;
                s.match_seconds = 0.0;
                s.round = None;
            }
        }
        let mask = |id: u32| self.game.as_ref().map_or(0, |g| g.m.current_mask(id));
        s.players = self
            .players
            .iter()
            .map(|p| PlayerSummary {
                id: p.id,
                name: p.conn.name.clone(),
                team: p.team,
                host: self.host == Some(p.id),
                ping_ms: p.conn.stats.rtt(),
                ip: p.conn.ip.to_string(),
                bytes_in_per_s: p.rate.0,
                bytes_out_per_s: p.rate.1,
                margin_ticks: p.margin16 as f64 / 16.0,
                transport: if p.conn.stats.udp.load(std::sync::atomic::Ordering::Relaxed) { "udp" } else { "ws" },
                input_mask: mask(p.id),
                connected_s: p.conn.connected.elapsed().as_secs(),
                in_match: p.in_match,
            })
            .collect();
    }
}

pub fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_default()
}
