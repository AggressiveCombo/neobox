//! A room: lobby (players, teams, chat, host settings, map) and, while a
//! match runs, the authoritative input timeline ticking at the room's rate.

use crate::hub::{close, AccountRef, ConnInfo, Hub, Out, RoomHandle};
use crate::{award, emoji, qa_events, youtube};
use base64::Engine;
use neobox_net::*;
use neobox_sim::start::Outcome;
use neobox_sim::{GameSettings, MapData};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};
use crate::backend::{MapAction, MapCommandBody, RecordBody};
use neobox_store::{ReportChat, ReportedMap, ReportedPlayer, RoomMap, XpGrant, MAX_REPORT_CHAT};

/// Longest map code accepted from clients (characters).
pub const MAX_MAP_CODE: usize = 2 * 1024 * 1024;
/// Longest room password (characters).
pub const MAX_PASSWORD_LEN: usize = 64;
/// Confirmed ticks kept for resending.
const HISTORY: usize = 256;
/// Clients further behind than this get a snapshot instead of batches.
const MAX_CATCHUP: u32 = 90;
/// A player whose connection dropped keeps their slot this long.
const LOST_LIMIT: Duration = Duration::from_secs(60);
/// Countdown between the host's start and the match (two or more players).
const START_DELAY: Duration = Duration::from_secs(1);
/// Quick-play players who change no input and say nothing this long are removed.
const IDLE_LIMIT: Duration = Duration::from_secs(120);
/// Minimum elapsed match duration before an unfinished match counts as a map play.
const PLAY_MIN_ELAPSED: Duration = Duration::from_secs(10);
/// Minimum time between counted plays of the same library map in one room.
const PLAY_COOLDOWN: Duration = Duration::from_secs(30);
/// Typing signals relayed per player at most this often.
const TYPING_GAP: Duration = Duration::from_millis(800);
/// The quick-play rotation awards experience when the game-over countdown
/// reaches this tick (the original's `xo == 10`).
const QUICK_AWARD_TICK: f64 = 10.0;
/// Ticks run at 30 per second in the original, whatever rate the room simulates at.
const RECORD_TICKS_PER_SECOND: f64 = 30.0;
/// Appearance colours (the original's FFA palette) for players who have not picked one. Each joiner takes the first
/// one no current player uses, so colours stay distinct in a room until more than six players are in it.
const DEFAULT_COLORS: [u32; 6] = [0xf9fc91, 0x33658a, 0xe34a6f, 0x3acf60, 0xbc56d5, 0xeea210];
const HELP: &str = "Commands: /set <key> <value>, /settings, /reset, /mode <n>, /start, /end, /lock, /unlock, \
    /kick <name>, /ban <name>, /unban <name>, /mute <name>, /unmute <name>, /host <name>, \
    /team <name> <ffa|red|blue|spec>, /join <ffa|red|blue|spec>, /upvote, /downvote, /fav, /unfav, /record";

/// (player id, resume token) on success, or (code, message).
type JoinReply = Result<(u32, String), (String, String)>;

pub enum RoomCmd {
    /// `resume`: the token of an earlier slot, which gives that slot back.
    Join { conn: ConnInfo, password: Option<String>, resume: Option<String>, reply: oneshot::Sender<JoinReply> },
    /// The connection left on purpose. `out` identifies the connection, so a
    /// stale command from a replaced connection changes nothing.
    Leave { player: u32, out: mpsc::UnboundedSender<Out> },
    /// The connection dropped: its slot is held for a reconnect.
    Lost { player: u32, out: mpsc::UnboundedSender<Out> },
    /// Chat or a game command. `out` identifies the connection; a stale one changes nothing (see `Leave`).
    Msg { player: u32, msg: ClientMsg, out: mpsc::UnboundedSender<Out> },
    Frame { player: u32, frame: ClientFrame, out: mpsc::UnboundedSender<Out> },
    Admin(AdminCmd),
    View { reply: oneshot::Sender<Option<Vec<u8>>> },
    /// What a report keeps of the room; `player` is the one reported.
    Evidence { player: Option<u32>, reply: oneshot::Sender<Evidence> },
    /// The title of a suggested video arrived (fetched off the room task).
    Suggested { from: u32, name: String, video: String, title: String },
    /// The title of the jukebox video arrived.
    JukeboxTitle { video: String, title: String },
    /// An award's store answer arrived.
    XpGranted { player: u32, award: PendingAward, result: Result<XpGrant, String> },
    /// A map vote or favourite change was applied; `done` is the notice on success.
    MapCommandDone { player: u32, done: &'static str, refresh: bool, result: Result<(), String> },
    /// The current map's library entry was reloaded.
    MapMetaLoaded { result: Result<RoomMap, String> },
    /// A map the host asked for arrived from the library.
    LibraryMapLoaded { player: u32, map: i64, result: Result<RoomMap, String> },
    /// A finish time was saved for a signed-in player (`result`: whether it is their new best).
    RecordSaved { name: String, ticks: i64, result: Result<bool, String> },
}

/// An award waiting for the store's answer.
pub struct PendingAward {
    pub placement: i32,
    pub quick: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    /// Lift a ban by the banned player's name.
    Unban { name: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
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
    pub transport: String,
    pub input_mask: u8,
    /// False while the slot is held for a reconnect.
    pub connected: bool,
    pub connected_s: u64,
    pub in_match: bool,
    /// Signed-in account id (`None` for guests).
    pub account: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
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
    /// Names of banned players.
    pub bans: Vec<String>,
    /// Queue of a quick-play room.
    pub quick: Option<String>,
    /// The jukebox video, if any.
    pub jukebox: Option<JukeboxInfo>,
    /// Country of the host's address (ISO alpha-2), when geolocation knows it.
    pub host_country: Option<String>,
}

/// A banned player: the name listed in the room and the keys that block
/// them (see [`conn_keys`]).
#[derive(Clone, Debug)]
struct Ban {
    name: String,
    keys: Vec<String>,
}

enum Link {
    Live(ConnInfo),
    /// Connection dropped at this instant; the slot waits for a resume.
    Lost(Instant),
}

/// What a chat line is throttled by: the player, its address and its account.
/// Sockets of one player share all three, so extra tabs add no budget.
#[derive(Clone, Copy, Hash, PartialEq, Eq)]
enum ChatKey {
    Player(u32),
    Address(IpAddr),
    Account(i64),
}

/// Tokens of one [`ChatKey`]: 3 lines at once, then one line every 3 seconds.
#[derive(Clone, Copy)]
struct ChatBucket {
    tokens: f64,
    at: Instant,
}

const CHAT_BURST: f64 = 3.0;
const CHAT_REFILL_SECS: f64 = 3.0;

impl ChatBucket {
    fn tokens_at(&self, now: Instant) -> f64 {
        (self.tokens + now.duration_since(self.at).as_secs_f64() / CHAT_REFILL_SECS).min(CHAT_BURST)
    }
}

/// Spends one token from each bucket in `keys`. False, spending nothing, when one of them is empty.
fn spend_chat(buckets: &mut HashMap<ChatKey, ChatBucket>, keys: &[ChatKey], now: Instant) -> bool {
    let held: Vec<f64> = keys.iter().map(|k| buckets.get(k).map_or(CHAT_BURST, |b| b.tokens_at(now))).collect();
    if held.iter().any(|t| *t < 1.0) {
        return false;
    }
    if buckets.len() > 256 {
        // a bucket that has refilled is the same as no bucket
        buckets.retain(|_, b| b.tokens_at(now) < CHAT_BURST);
    }
    for (key, tokens) in keys.iter().zip(held) {
        buckets.insert(*key, ChatBucket { tokens: tokens - 1.0, at: now });
    }
    true
}

struct RPlayer {
    id: u32,
    name: String,
    account: Option<AccountRef>,
    /// Account experience (`None` for guests).
    xp: Option<u64>,
    ip: IpAddr,
    token: String,
    link: Link,
    team: u8,
    in_match: bool,
    /// Appearance colour (0xRRGGBB).
    color: u32,
    /// In the map editor.
    editing: bool,
    /// Last input change or chat line (quick-play idle check).
    active: Instant,
    /// Last relayed typing signal.
    typing_at: Option<Instant>,
    /// next tick the client needs (its confirmed tick)
    ack: u32,
    last_sent: Option<u32>,
    margin16: i32,
    /// The client frame number `margin16` was measured from.
    margin_frame: u32,
    last_bytes: (u64, u64),
    rate: (u64, u64),
    /// The best (map, ticks) already announced for this player; a finish counts only when it beats it.
    record_seen: Option<(i64, i64)>,
    /// Host-muted: chat lines and typing signals are refused.
    muted: bool,
}

impl RPlayer {
    fn live(&self) -> Option<&ConnInfo> {
        match &self.link {
            Link::Live(c) => Some(c),
            Link::Lost(_) => None,
        }
    }

    /// Sends to the player's connection; nothing while the slot is held.
    fn send(&self, o: Out) {
        if let Some(c) = self.live() {
            c.send(o);
        }
    }

    fn text(&self, m: &ServerMsg) {
        self.send(Out::Text(json(m)));
    }
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
    /// per-player numbers of this game, for the signed-in players' stats
    tallies: award::Tallies,
    /// the server's own record of the match, when NEOBOX_QA_EVENTS is set
    qa: Option<qa_events::EventLog>,
    /// whether this match has already recorded a library map play
    play_counted: bool,
}

/// A match whose steps stay slower than real time this long is stopped.
const SLOW_LIMIT_US: f64 = 3e6;

/// The room's jukebox video. The position is kept as a base plus the time
/// it has been playing since.
struct Jukebox {
    video: String,
    title: String,
    playing: bool,
    /// Seconds into the video at `since`.
    base: f64,
    since: Instant,
}

impl Jukebox {
    fn position(&self) -> f64 {
        if self.playing { self.base + self.since.elapsed().as_secs_f64() } else { self.base }
    }

    fn state(&self) -> JukeboxState {
        JukeboxState { video: self.video.clone(), title: self.title.clone(), playing: self.playing, position: self.position() }
    }
}

pub struct Room {
    hub: Arc<Hub>,
    /// The room's own command channel (for work finished off the room task).
    tx: mpsc::UnboundedSender<RoomCmd>,
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
    /// The current map's library entry, when it comes from the library.
    map_meta: Option<MapMeta>,
    /// Last time a play was counted for each library map ID in this room (anti-spam cooldown).
    last_play: HashMap<i64, Instant>,
    /// Quick-play mode (`qp_N`): no host, the rotation plays by itself.
    quick: Option<String>,
    /// Maps the quick-play rotation plays, in order.
    rotation: Vec<crate::hub::BuiltinMap>,
    /// When the start countdown ends.
    starting: Option<Instant>,
    jukebox: Option<Jukebox>,
    tick_hz: f64,
    /// Tick rate set during a match; applied when the next match starts.
    next_tick_hz: Option<f64>,
    next_id: u32,
    locked: bool,
    bans: Vec<Ban>,
    /// Keys (`conn_keys`) of the players the host muted; a rejoin under one of them starts muted.
    mutes: Vec<Vec<String>>,
    game: Option<Game>,
    /// Account grants still in flight: the match's end waits for them.
    pending_xp: usize,
    /// Why the match ended, held until its experience is in.
    finishing: Option<String>,
    summary: Arc<Mutex<RoomSummary>>,
    created: u64,
    closed: bool,
    /// The last chat lines, kept for reports.
    chat_log: VecDeque<ReportChat>,
    /// Chat budgets (see [`ChatKey`]).
    chat_buckets: HashMap<ChatKey, ChatBucket>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What a report keeps of a room. Nodes send it to the main server as JSON.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evidence {
    pub room_code: String,
    pub room_name: String,
    pub player: Option<ReportedPlayer>,
    pub map: ReportedMap,
    pub chat: Vec<ReportChat>,
}

/// Ask a room task for its evidence. `None` once the room has closed.
pub async fn gather_evidence(room: &RoomHandle, player: Option<u32>) -> Option<Evidence> {
    let (reply, rx) = oneshot::channel();
    room.tx.send(RoomCmd::Evidence { player, reply }).ok()?;
    rx.await.ok()
}

/// How a new room starts.
pub enum RoomSetup {
    /// A custom room: its first map and game-mode defaults (the rotation's
    /// `custom` entry, like the original's server).
    Custom { map: Option<crate::hub::BuiltinMap>, defaults: Option<crate::rotation::ModeMeta> },
    /// A quick-play room of `mode`, playing `maps` in order.
    Quick { mode: crate::rotation::QuickMode, maps: Vec<crate::hub::BuiltinMap> },
}

/// Create a room and start its task.
pub fn spawn(
    hub: Arc<Hub>,
    code: String,
    name: String,
    password: Option<String>,
    max_players: u8,
    public: bool,
    setup: RoomSetup,
) -> RoomHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let quick = match &setup {
        RoomSetup::Quick { mode, .. } => Some(mode.id.clone()),
        RoomSetup::Custom { .. } => None,
    };
    // Filled in completely once a second; the room list (and a node's
    // "room created" heartbeat) must see whether it is public right away.
    let summary = Arc::new(Mutex::new(RoomSummary {
        code: code.clone(),
        name: name.clone(),
        public,
        password: password.is_some(),
        max_players: max_players.clamp(1, hub.cfg.max_players),
        quick: quick.clone(),
        created_ms: now_ms(),
        ..RoomSummary::default()
    }));
    let mut settings = GameSettings::default();
    let (map, rotation) = match setup {
        RoomSetup::Custom { map, defaults } => {
            if let Some(d) = defaults {
                settings.game_mode = d.game_mode;
                settings.objective_limit = d.limit;
            }
            (map.or_else(|| hub.maps.first().cloned()), Vec::new())
        }
        RoomSetup::Quick { mode, mut maps } => {
            settings.game_mode = mode.meta.game_mode;
            settings.objective_limit = mode.meta.limit;
            // every quick-play room starts somewhere else in the rotation
            if !maps.is_empty() {
                let k = rand::random_range(0..maps.len());
                maps.rotate_left(k);
            }
            (maps.first().cloned(), maps)
        }
    };
    let room = Room {
        tick_hz: hub.cfg.default_tick_hz,
        hub: hub.clone(),
        tx: tx.clone(),
        code: code.clone(),
        name,
        password: password.filter(|p| !p.is_empty()),
        public,
        max_players: max_players.clamp(1, hub.cfg.max_players),
        players: Vec::new(),
        host: None,
        settings,
        map_code: map.as_ref().map(|m| m.code.clone()).unwrap_or_default(),
        map_name: map.map(|m| m.name).unwrap_or_default(),
        map_meta: None,
        last_play: HashMap::new(),
        quick,
        rotation,
        starting: None,
        jukebox: None,
        next_tick_hz: None,
        next_id: 0,
        locked: false,
        bans: Vec::new(),
        mutes: Vec::new(),
        game: None,
        pending_xp: 0,
        finishing: None,
        summary: summary.clone(),
        created: now_ms(),
        closed: false,
        chat_log: VecDeque::new(),
        chat_buckets: HashMap::new(),
    };
    let handle = RoomHandle { tx, summary };
    tokio::spawn(room.run(rx));
    handle
}

/// Keys a ban matches: the player's address, and their account if signed in.
fn conn_keys(ip: &IpAddr, account: Option<&AccountRef>) -> Vec<String> {
    let mut keys = vec![format!("ip:{ip}")];
    if let Some(a) = account {
        keys.push(format!("acct:{}", a.id));
    }
    keys
}

/// Compares secrets without stopping at the first differing byte.
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// This process's part of every resume token. A token from an earlier process names a room that no longer exists.
fn boot_id() -> &'static str {
    static BOOT: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| format!("{:08x}", rand::random::<u32>()));
    &BOOT
}

fn new_token() -> String {
    format!("{}{:016x}{:016x}", boot_id(), rand::random::<u64>(), rand::random::<u64>())
}

/// True for a resume token issued by an earlier server process (the server restarted since).
pub fn is_stale_token(token: &str) -> bool {
    !token.starts_with(boot_id())
}

/// Splits a leading player name off `text`: a quoted name, or else the
/// longest of `names` that `text` starts with, followed by a space or the end.
/// Returns the matched name and the rest of the text.
fn take_name(text: &str, names: &[&str]) -> Option<(String, String)> {
    if let Some(quoted) = text.strip_prefix('"') {
        let (name, rest) = quoted.split_once('"')?;
        let hit = names.iter().find(|n| n.eq_ignore_ascii_case(name))?;
        return Some(((*hit).to_string(), rest.trim().to_string()));
    }
    let mut best: Option<&str> = None;
    for &n in names {
        let starts = text.get(..n.len()).is_some_and(|s| s.eq_ignore_ascii_case(n));
        let ends_word = text.get(n.len()..).is_some_and(|r| r.chars().next().is_none_or(|c| c == ' '));
        if starts && ends_word && best.is_none_or(|b| n.len() > b.len()) {
            best = Some(n);
        }
    }
    best.and_then(|n| text.get(n.len()..).map(|rest| (n.to_string(), rest.trim().to_string())))
}

/// Full state for a player at the current tick (see `ServerMsg::Snapshot`). `you` is set only
/// while `playing`: a spectator has no seat in the engine, so the client must not treat it as one.
fn snapshot_msg(g: &Game, id: u32, playing: bool) -> ServerMsg {
    ServerMsg::Snapshot {
        start: g.m.start.clone(),
        tick: g.m.tick,
        state: base64::engine::general_purpose::STANDARD.encode(g.m.snapshot()),
        you: playing.then_some(id),
        held: g.m.held_masks(),
    }
}

/// What the room shows of a library map.
fn map_meta_of(m: &neobox_store::RoomMap) -> MapMeta {
    MapMeta {
        id: m.id,
        name: m.name.clone(),
        author: m.author.clone(),
        description: m.description.clone(),
        created: m.created,
        up: m.up,
        down: m.down,
    }
}

/// The system chat line for a new personal best.
fn personal_best_line(name: &str, ticks: i64) -> String {
    format!("{name} set a personal best: {:.2}s", ticks as f64 / RECORD_TICKS_PER_SECOND)
}

impl Room {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<RoomCmd>) {
        info!(room = %self.code, name = %self.name, "room created");
        // The first tick is a second out: an immediate tick would run before the creator's Join is handled and close the
        // room as empty (the loop ends on an empty player list after every branch).
        let mut stats = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(1), Duration::from_secs(1));
        stats.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        self.update_summary();
        loop {
            let deadline = self.game.as_ref().map(|g| g.next_tick);
            let start_at = self.starting;
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(c) => self.handle(c),
                    None => break,
                },
                _ = async { tokio::time::sleep_until(deadline.unwrap().into()).await }, if deadline.is_some() => {
                    self.run_ticks();
                }
                _ = async { tokio::time::sleep_until(start_at.unwrap().into()).await }, if start_at.is_some() => {
                    self.starting = None;
                    self.start_match();
                }
                _ = stats.tick() => {
                    self.expire_lost();
                    self.kick_idle();
                    self.quick_start();
                    self.maybe_count_play(false);
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
            p.send(Out::Text(json(&ServerMsg::Left)));
        }
        self.hub.rooms.lock().unwrap().remove(&self.code);
        self.hub.beat.notify_one();
        info!(room = %self.code, "room closed");
    }

    fn handle(&mut self, cmd: RoomCmd) {
        match cmd {
            RoomCmd::Join { conn, password, resume, reply } => {
                let r = self.join(conn, password, resume);
                let _ = reply.send(r);
            }
            RoomCmd::Leave { player, out } => {
                if self.is_live_as(player, &out) {
                    self.remove(player, "left");
                }
            }
            RoomCmd::Lost { player, out } => self.lost(player, &out),
            RoomCmd::Msg { player, msg, out } => {
                if self.is_live_as(player, &out) {
                    self.message(player, msg);
                }
            }
            RoomCmd::Frame { player, frame, out } => {
                if self.is_live_as(player, &out) {
                    self.frame(player, frame);
                }
            }
            RoomCmd::Admin(a) => self.admin(a),
            RoomCmd::Evidence { player, reply } => {
                let _ = reply.send(self.evidence(player));
            }
            RoomCmd::View { reply } => {
                let frame = self.game.as_ref().map(|g| {
                    let mut fb = neobox_wasm::frame::FrameBuilder::default();
                    let meta = neobox_wasm::frame::Meta { tick: g.m.tick, local: -1, ..Default::default() };
                    fb.build(&g.m.state, &g.m.state, 1.0, &g.m.start.settings, meta, &neobox_wasm::frame::Feed::default());
                    fb.words.iter().flat_map(|w| w.to_le_bytes()).collect()
                });
                let _ = reply.send(frame);
            }
            RoomCmd::XpGranted { player, award, result } => self.xp_granted(player, award, result),
            RoomCmd::MapCommandDone { player, done, refresh, result } => match result {
                Ok(()) => {
                    self.notice(player, done);
                    if refresh {
                        self.refresh_map_meta();
                    }
                }
                Err(e) => self.notice(player, &e),
            },
            RoomCmd::MapMetaLoaded { result } => {
                if let Ok(m) = result {
                    self.map_meta = Some(map_meta_of(&m));
                    self.broadcast_room();
                }
            }
            RoomCmd::LibraryMapLoaded { player, map, result } => self.library_map_loaded(player, map, result),
            RoomCmd::RecordSaved { name, ticks, result } => match result {
                Ok(true) => self.system_chat(&personal_best_line(&name, ticks)),
                Ok(false) => {}
                Err(e) => warn!(room = %self.code, "could not save a record: {e}"),
            },
            RoomCmd::Suggested { from, name, video, title } => {
                let m = json(&ServerMsg::Suggest { from, name, video, title });
                for p in &self.players {
                    p.send(Out::Text(m.clone()));
                }
            }
            RoomCmd::JukeboxTitle { video, title } => {
                if let Some(j) = self.jukebox.as_mut().filter(|j| j.video == video) {
                    j.title = title;
                    self.broadcast_jukebox();
                }
            }
        }
    }

    fn player(&self, id: u32) -> Option<&RPlayer> {
        self.players.iter().find(|p| p.id == id)
    }

    fn player_mut(&mut self, id: u32) -> Option<&mut RPlayer> {
        self.players.iter_mut().find(|p| p.id == id)
    }

    /// What a report keeps of this room: the reported player (if still here), the map and the recent chat.
    fn evidence(&self, player: Option<u32>) -> Evidence {
        let player = player.and_then(|id| self.player(id)).map(|p| ReportedPlayer {
            id: p.id as i64,
            name: p.name.clone(),
            account: p.account.as_ref().map(|a| a.id),
            ip: p.ip.to_string(),
        });
        let map = ReportedMap {
            id: self.map_meta.as_ref().map(|m| m.id),
            name: self.map_name.clone(),
            author: self.map_meta.as_ref().map(|m| m.author.clone()).unwrap_or_default(),
        };
        Evidence { room_code: self.code.clone(), room_name: self.name.clone(), player, map, chat: self.chat_log.iter().cloned().collect() }
    }

    /// Keep a chat line for the reports that may cite it.
    fn keep_chat(&mut self, name: &str, text: &str) {
        if self.chat_log.len() >= MAX_REPORT_CHAT {
            self.chat_log.pop_front();
        }
        self.chat_log.push_back(ReportChat { name: name.into(), text: text.into(), at: (now_ms() / 1000) as i64 });
    }

    fn is_host(&self, id: u32) -> bool {
        self.host == Some(id)
    }

    /// True if `id` is currently connected through the connection `out`.
    fn is_live_as(&self, id: u32, out: &mpsc::UnboundedSender<Out>) -> bool {
        self.player(id).and_then(|p| p.live()).is_some_and(|c| c.out.same_channel(out))
    }

    fn to(&self, id: u32, m: &ServerMsg) {
        if let Some(p) = self.player(id) {
            p.text(m);
        }
    }

    fn error(&self, id: u32, code: &str, message: &str) {
        self.to(id, &ServerMsg::Error { code: code.into(), message: message.into() });
    }

    /// A line only `id` sees.
    fn notice(&self, id: u32, text: &str) {
        self.to(id, &ServerMsg::Chat { from: None, name: String::new(), text: text.into() });
    }

    fn system_chat(&self, text: &str) {
        let m = json(&ServerMsg::Chat { from: None, name: String::new(), text: text.into() });
        for p in &self.players {
            p.send(Out::Text(m.clone()));
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

    fn join(&mut self, conn: ConnInfo, password: Option<String>, resume: Option<String>) -> JoinReply {
        if let Some(i) = resume.and_then(|t| self.players.iter().position(|p| p.token == t)) {
            return Ok(self.resume(i, conn));
        }
        let keys = conn_keys(&conn.ip, conn.account.as_ref());
        if self.bans.iter().any(|b| b.keys.iter().any(|k| keys.contains(k))) {
            return Err(("banned".into(), "You are banned from this room".into()));
        }
        // one seat per signed-in account: another connection of the same account takes the seat over
        if let Some(account) = conn.account.as_ref().map(|a| a.id) {
            if let Some(i) = self.players.iter().position(|p| p.account.as_ref().is_some_and(|a| a.id == account)) {
                return Ok(self.resume(i, conn));
            }
        }
        if let Some(pw) = &self.password {
            if !password.as_deref().is_some_and(|p| ct_eq(p, pw)) {
                return Err(("wrong_password".into(), "Wrong password".into()));
            }
        }
        if self.players.len() >= self.max_players as usize {
            return Err(("room_full".into(), "The room is full".into()));
        }
        let id = self.next_id;
        self.next_id += 1;
        let team = self.default_team();
        // late join: a running match takes the player in at the current tick
        let in_match = match self.game.as_mut() {
            Some(g) => {
                g.m.join(id, team as f64);
                true
            }
            None => false,
        };
        let token = new_token();
        info!(room = %self.code, player = id, name = %conn.name, ip = %conn.ip, "join");
        let xp = conn.xp;
        let taken: Vec<u32> = self.players.iter().map(|p| p.color).collect();
        let color = conn.color.unwrap_or_else(|| {
            DEFAULT_COLORS.iter().copied().find(|c| !taken.contains(c)).unwrap_or(DEFAULT_COLORS[id as usize % DEFAULT_COLORS.len()])
        });
        let name = conn.name.clone();
        self.players.push(RPlayer {
            id,
            name: conn.name.clone(),
            account: conn.account.clone(),
            xp,
            ip: conn.ip,
            token: token.clone(),
            link: Link::Live(conn),
            team,
            in_match,
            color,
            editing: false,
            active: Instant::now(),
            typing_at: None,
            ack: 0,
            last_sent: None,
            margin16: 0,
            margin_frame: 0,
            last_bytes: (0, 0),
            rate: (0, 0),
            record_seen: None,
            muted: self.mutes.iter().any(|m| m.iter().any(|k| keys.contains(k))),
        });
        // quick-play rooms have no host
        if self.host.is_none() && self.quick.is_none() {
            self.host = Some(id);
        }
        let i = self.players.len() - 1;
        self.catch_up(i);
        self.system_chat(&format!("{name} has joined the game"));
        self.broadcast_room();
        self.publish_players();
        self.quick_start();
        Ok((id, token))
    }

    /// Takes a held slot back on a new connection.
    fn resume(&mut self, i: usize, conn: ConnInfo) -> (u32, String) {
        if let Link::Live(old) = &self.players[i].link {
            // the replaced connection's later commands are ignored (see `is_live_as`)
            old.send(Out::Close(close::REPLACED));
        }
        let p = &mut self.players[i];
        p.ip = conn.ip;
        p.link = Link::Live(conn);
        let (id, token) = (p.id, p.token.clone());
        info!(room = %self.code, player = id, name = %p.name, "resumed");
        self.catch_up(i);
        self.broadcast_room();
        self.publish_players();
        (id, token)
    }

    /// Brings a joined or resumed player up to date: their id and token,
    /// the lobby state, and inside a running match a snapshot to continue from.
    fn catch_up(&mut self, i: usize) {
        let id = self.players[i].id;
        let joined = ServerMsg::Joined { you: id, token: self.players[i].token.clone() };
        let room = ServerMsg::Room { room: self.room_state() };
        if let Some(g) = self.game.as_mut() {
            // a reloaded page numbers its input changes from 1 again
            g.m.reset_input_seq(id);
        }
        let p = &mut self.players[i];
        p.send(Out::Text(json(&joined)));
        p.send(Out::Text(json(&room)));
        if let Some(g) = self.game.as_ref() {
            p.ack = g.m.tick;
            p.last_sent = None;
            p.send(Out::Text(json(&snapshot_msg(g, id, p.in_match))));
        }
    }

    /// The connection dropped: keep the slot (and its place in a running
    /// match, standing still) until it resumes or the grace period ends.
    fn lost(&mut self, id: u32, out: &mpsc::UnboundedSender<Out>) {
        if !self.is_live_as(id, out) {
            return;
        }
        let Some(p) = self.player_mut(id) else { return };
        p.link = Link::Lost(Instant::now());
        let in_match = p.in_match;
        info!(room = %self.code, player = id, "connection lost");
        if in_match {
            if let Some(g) = self.game.as_mut() {
                g.m.neutralize(id);
            }
        }
        self.broadcast_room();
    }

    /// Frees the slots of players who have not come back in time.
    fn expire_lost(&mut self) {
        let now = Instant::now();
        let gone: Vec<u32> = self
            .players
            .iter()
            .filter(|p| matches!(&p.link, Link::Lost(t) if now.duration_since(*t) > LOST_LIMIT))
            .map(|p| p.id)
            .collect();
        for id in gone {
            self.remove(id, "connection timed out");
        }
    }

    /// Removes a player for good (left, kicked, banned, timed out, idle).
    fn remove(&mut self, id: u32, why: &str) {
        let Some(i) = self.players.iter().position(|p| p.id == id) else { return };
        let p = self.players.remove(i);
        info!(room = %self.code, player = id, name = %p.name, reason = why, "leave");
        if p.in_match {
            if let Some(g) = self.game.as_mut() {
                g.m.leave(id);
            }
        }
        // kicks and bans announce themselves
        if why != "kicked" && why != "banned" {
            self.system_chat(&format!("{} has left the game", p.name));
        }
        if self.host == Some(id) {
            // prefer a connected player as the new host
            self.host = self
                .players
                .iter()
                .filter(|q| q.live().is_some())
                .map(|q| q.id)
                .min()
                .or_else(|| self.players.iter().map(|q| q.id).min());
            if let Some(name) = self.host.and_then(|h| self.player(h)).map(|q| q.name.clone()) {
                self.system_chat(&format!("{name} is now the host"));
            }
        }
        self.broadcast_room();
        self.publish_players();
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
                .map(|p| PlayerInfo {
                    id: p.id,
                    name: p.name.clone(),
                    team: p.team,
                    ping_ms: p.live().map_or(0, |c| c.stats.rtt()),
                    host: self.host == Some(p.id),
                    account: p.account.is_some(),
                    connected: p.live().is_some(),
                    level: p.xp.map_or(0, level_of),
                    color: p.color,
                    editing: p.editing,
                })
                .collect(),
            settings: self.settings.clone(),
            map_name: self.map_name.clone(),
            in_match: self.game.is_some(),
            tick_hz: self.tick_hz,
            locked: self.locked,
            bans: self.bans.iter().map(|b| b.name.clone()).collect(),
            quick: self.quick.clone(),
            starting: self.starting.is_some(),
            map: self.map_meta.clone(),
            jukebox: self.jukebox.as_ref().map(Jukebox::state),
        }
    }

    fn broadcast_jukebox(&self) {
        let m = json(&ServerMsg::Jukebox { jukebox: self.jukebox.as_ref().map(Jukebox::state) });
        for p in &self.players {
            p.send(Out::Text(m.clone()));
        }
    }

    fn broadcast_room(&self) {
        let m = json(&ServerMsg::Room { room: self.room_state() });
        for p in &self.players {
            p.send(Out::Text(m.clone()));
        }
    }

    /// Spends one chat token from each budget the player is throttled by (see [`ChatKey`]).
    /// False, spending nothing, when one of them is empty.
    fn take_chat_token(&mut self, id: u32) -> bool {
        let Some(p) = self.player(id) else { return false };
        let mut keys = vec![ChatKey::Player(id), ChatKey::Address(p.ip)];
        keys.extend(p.account.as_ref().map(|a| ChatKey::Account(a.id)));
        spend_chat(&mut self.chat_buckets, &keys, Instant::now())
    }

    /// The first player whose name starts `text`, and the rest of `text`.
    fn named_player(&self, text: &str) -> Option<(u32, String)> {
        let names: Vec<&str> = self.players.iter().map(|p| p.name.as_str()).collect();
        let (name, rest) = take_name(text, &names)?;
        let id = self.players.iter().find(|p| p.name == name)?.id;
        Some((id, rest))
    }

    /// `/command` chat lines. Each maps onto the client message the UI sends,
    /// so the permission checks are shared.
    fn command(&mut self, id: u32, cmd: &str) {
        let (word, rest) = cmd.split_once(' ').map_or((cmd, ""), |(w, r)| (w, r.trim()));
        let word = word.to_ascii_lowercase();
        let team_word = |w: &str| match w.to_ascii_lowercase().as_str() {
            "ffa" => Some(TEAM_FFA),
            "red" => Some(TEAM_RED),
            "blue" => Some(TEAM_BLUE),
            "spec" => Some(TEAM_SPECTATOR),
            _ => None,
        };
        let msg = match word.as_str() {
            "help" => return self.notice(id, HELP),
            "settings" => return self.notice(id, &self.settings.listing().join(", ")),
            "set" => match rest.split_once(' ') {
                Some((key, value)) => ClientMsg::SetSetting { key: key.into(), value: value.trim().into() },
                None => return self.notice(id, "Usage: /set <key> <value>"),
            },
            "reset" | "resetsettings" => ClientMsg::ResetSettings,
            "mode" => match rest.parse() {
                Ok(mode) => ClientMsg::SetMode { mode },
                Err(_) => return self.notice(id, "Usage: /mode <number>"),
            },
            "start" => ClientMsg::Start,
            "end" => ClientMsg::EndMatch,
            "lock" => ClientMsg::SetLock { locked: true },
            "unlock" => ClientMsg::SetLock { locked: false },
            "kick" | "ban" => match self.named_player(rest) {
                Some((player, _)) => ClientMsg::Kick { player, ban: word == "ban" },
                None => return self.notice(id, "No player with that name"),
            },
            "host" => match self.named_player(rest) {
                Some((player, _)) => ClientMsg::GiveHost { player },
                None => return self.notice(id, "No player with that name"),
            },
            "team" => {
                let Some((player, tail)) = self.named_player(rest) else {
                    return self.notice(id, "No player with that name");
                };
                match team_word(&tail) {
                    Some(team) => ClientMsg::MovePlayer { player, team },
                    None => return self.notice(id, "Usage: /team <name> <ffa|red|blue|spec>"),
                }
            }
            "join" => match team_word(rest) {
                Some(team) => ClientMsg::SetTeam { team },
                None => return self.notice(id, "Usage: /join <ffa|red|blue|spec>"),
            },
            "unban" => {
                let names: Vec<&str> = self.bans.iter().map(|b| b.name.as_str()).collect();
                match take_name(rest, &names) {
                    Some((name, _)) => ClientMsg::Unban { name },
                    None => return self.notice(id, "No banned player with that name"),
                }
            }
            "mute" | "unmute" => match self.named_player(rest) {
                Some((player, _)) => ClientMsg::Mute { player, muted: word == "mute" },
                None => return self.notice(id, "No player with that name"),
            },
            "upvote" | "downvote" | "fav" | "fave" | "unfav" | "unfave" => return self.map_command(id, &word),
            // clips are cut on the client from its own recording of the match
            "record" => return self.notice(id, "Type /record in a running match to send its last 15 seconds to the main menu"),
            _ => return self.notice(id, "Unknown command, try /help"),
        };
        self.message(id, msg);
    }

    /// `/upvote`, `/downvote`, `/fav`, `/unfav` on the room's library map.
    fn map_command(&mut self, id: u32, word: &str) {
        let Some(account) = self.player(id).and_then(|p| p.account.as_ref()).map(|a| a.id) else {
            return self.notice(id, "Sign in to vote for maps and keep favourites");
        };
        let Some(map) = self.map_meta.as_ref().map(|m| m.id) else {
            return self.notice(id, "This map is not in the map library");
        };
        let action = match word {
            "upvote" => MapAction::Up,
            "downvote" => MapAction::Down,
            "fav" | "fave" => MapAction::Fav,
            _ => MapAction::Unfav,
        };
        let done = match action {
            MapAction::Up => "You voted for this map",
            MapAction::Down => "You voted against this map",
            MapAction::Fav => "Map added to your favourites",
            MapAction::Unfav => "Map removed from your favourites",
        };
        let hub = self.hub.clone();
        let tx = self.tx.clone();
        let refresh = word.ends_with("vote");
        tokio::spawn(async move {
            let result = hub.backend.map_command(MapCommandBody { account, map, action }).await;
            let _ = tx.send(RoomCmd::MapCommandDone { player: id, done, refresh, result });
        });
    }

    /// Reloads the library entry of the current map (vote counts changed).
    fn refresh_map_meta(&mut self) {
        let Some(id) = self.map_meta.as_ref().map(|m| m.id) else { return };
        let hub = self.hub.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = hub.backend.room_map(id, None).await;
            let _ = tx.send(RoomCmd::MapMetaLoaded { result });
        });
    }

    fn message(&mut self, id: u32, msg: ClientMsg) {
        let host = self.is_host(id);
        let running = self.game.is_some();
        match msg {
            ClientMsg::Chat { text } => {
                let text: String = clean_text(&text).chars().take(MAX_CHAT_LEN).collect::<String>().trim().to_string();
                if text.is_empty() {
                    return;
                }
                // commands and chat lines spend one budget, across all of the player's
                // sockets: a flood of `/help` is throttled like a flood of chat
                if !self.take_chat_token(id) {
                    return self.error(id, "rate_limited", "You're doing that too much!");
                }
                if let Some(cmd) = text.strip_prefix('/') {
                    return self.command(id, cmd);
                }
                if self.player(id).is_some_and(|p| p.muted) {
                    return self.error(id, "muted", "The host has muted you");
                }
                let Some(p) = self.player_mut(id) else { return };
                p.active = Instant::now();
                let name = p.name.clone();
                // a line that is only a YouTube link suggests it for the jukebox
                if let Some(video) = youtube::video_id(&text) {
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        let title = youtube::title(&video).await.unwrap_or_else(|| video.clone());
                        let _ = tx.send(RoomCmd::Suggested { from: id, name, video, title });
                    });
                    return;
                }
                let text = emoji::replace_shortcodes(&text);
                self.keep_chat(&name, &text);
                let m = json(&ServerMsg::Chat { from: Some(id), name, text });
                for q in &self.players {
                    q.send(Out::Text(m.clone()));
                }
            }
            ClientMsg::SetTeam { team } => {
                if self.locked && !host {
                    return self.error(id, "teams_locked", "Teams are locked by the host");
                }
                if let Err(e) = self.move_to_team(id, team) {
                    return self.error(id, "bad_team", &e);
                }
            }
            ClientMsg::MovePlayer { player, team } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can move players");
                }
                if self.player(player).is_none() {
                    return;
                }
                if let Err(e) = self.move_to_team(player, team) {
                    return self.error(id, "bad_team", &e);
                }
            }
            ClientMsg::SetLock { locked } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can lock teams");
                }
                self.locked = locked;
                self.system_chat(if locked { "Teams are locked" } else { "Teams are unlocked" });
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
                        self.map_name = map_label(name.as_deref());
                        self.map_meta = None;
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
                    return self.error(id, "not_host", "Only the host can reset settings");
                }
                let mode = self.settings.game_mode;
                self.settings = GameSettings { game_mode: mode, ..GameSettings::default() };
                self.system_chat("Settings reset");
                self.broadcast_room();
            }
            ClientMsg::SetMode { mode } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can change the mode");
                }
                if !(0..=6).contains(&mode) {
                    return self.error(id, "bad_setting", "Unknown game mode");
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
                if running || self.starting.is_some() {
                    return;
                }
                // like the original: alone you start at once, together after a countdown
                if self.players.iter().filter(|p| p.team != TEAM_SPECTATOR).count() < 2 {
                    return self.start_match();
                }
                self.starting = Some(Instant::now() + START_DELAY);
                self.system_chat("Game starting!");
                self.broadcast_room();
            }
            ClientMsg::AbortStart => {
                if !host {
                    return self.error(id, "not_host", "Only the host can start");
                }
                if self.starting.take().is_some() {
                    self.broadcast_room();
                }
            }
            ClientMsg::SetLibraryMap { id: map } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can change the map");
                }
                if running {
                    return self.error(id, "in_match", "Wait for the match to end");
                }
                let viewer = self.player(id).and_then(|p| p.account.as_ref()).map(|a| a.id);
                let hub = self.hub.clone();
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    let result = hub.backend.room_map(map, viewer).await;
                    let _ = tx.send(RoomCmd::LibraryMapLoaded { player: id, map, result });
                });
            }
            ClientMsg::GetMap => {
                self.to(id, &ServerMsg::MapCode { code: self.map_code.clone(), name: self.map_name.clone() });
            }
            ClientMsg::SetColor { color } => {
                if let Some(p) = self.player_mut(id) {
                    p.color = color & 0xffffff;
                    self.broadcast_room();
                }
            }
            ClientMsg::Typing => {
                let Some(p) = self.player_mut(id) else { return };
                if p.muted {
                    return;
                }
                let now = Instant::now();
                if p.typing_at.is_some_and(|t| now.duration_since(t) < TYPING_GAP) {
                    return;
                }
                p.typing_at = Some(now);
                let m = json(&ServerMsg::Typing { player: id });
                for q in self.players.iter().filter(|q| q.id != id) {
                    q.send(Out::Text(m.clone()));
                }
            }
            ClientMsg::Editing { open } => {
                if let Some(p) = self.player_mut(id).filter(|p| p.editing != open) {
                    p.editing = open;
                    self.broadcast_room();
                }
            }
            ClientMsg::Jukebox { action, video } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can control the jukebox");
                }
                self.jukebox_action(id, &action, video);
            }
            ClientMsg::EndMatch => {
                if !host {
                    return self.error(id, "not_host", "Only the host can stop the match");
                }
                if self.game.is_some() {
                    let name = self.player(id).map_or_else(|| "The host".to_owned(), |p| p.name.clone());
                    self.system_chat(&format!("{name} ended the match. No experience was awarded."));
                    self.end_match("ended by the host");
                }
            }
            ClientMsg::Kick { player, ban } => {
                if !host || player == id {
                    return;
                }
                self.kick(player, ban);
            }
            ClientMsg::Mute { player, muted } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can mute players");
                }
                // a host may unmute themselves (a muted host keeps the seat); muting oneself is refused
                if player == id && muted {
                    return;
                }
                let Some(p) = self.player_mut(player) else { return };
                p.muted = muted;
                let keys = conn_keys(&p.ip, p.account.as_ref());
                let name = p.name.clone();
                self.mutes.retain(|m| !m.iter().any(|k| keys.contains(k)));
                if muted {
                    self.mutes.push(keys);
                }
                if muted {
                    self.notice(player, "The host muted you: your chat lines are not sent");
                    self.system_chat(&format!("{name} was muted"));
                } else {
                    self.notice(player, "The host unmuted you");
                    self.system_chat(&format!("{name} was unmuted"));
                }
            }
            ClientMsg::Unban { name } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can lift bans");
                }
                let before = self.bans.len();
                self.bans.retain(|b| !b.name.eq_ignore_ascii_case(&name));
                if self.bans.len() != before {
                    self.system_chat(&format!("{name} was unbanned"));
                    self.broadcast_room();
                }
            }
            ClientMsg::GiveHost { player } => {
                if !host {
                    return self.error(id, "not_host", "Only the host can give the host role");
                }
                if let Some(name) = self.player(player).map(|p| p.name.clone()) {
                    self.host = Some(player);
                    self.system_chat(&format!("{name} is now the host"));
                    self.broadcast_room();
                    self.publish_players();
                }
            }
            ClientMsg::Resync => {
                let Some(i) = self.players.iter().position(|p| p.id == id) else { return };
                let Some(g) = self.game.as_mut() else { return };
                let tick = g.m.tick;
                let snap = snapshot_msg(g, id, self.players[i].in_match);
                let p = &mut self.players[i];
                p.text(&snap);
                p.ack = tick;
                p.last_sent = None;
                warn!(room = %self.code, player = id, "resync requested");
            }
            ClientMsg::Hello { .. }
            | ClientMsg::ListRooms
            | ClientMsg::CreateRoom { .. }
            | ClientMsg::JoinRoom { .. }
            | ClientMsg::QuickPlay { .. }
            | ClientMsg::LeaveRoom
            | ClientMsg::RtcOffer { .. } => {}
        }
    }

    /// Host jukebox controls: play a video, pause, resume or stop.
    fn jukebox_action(&mut self, id: u32, action: &str, video: Option<String>) {
        match action {
            "play" => {
                let Some(video) = video.filter(|v| youtube::valid_id(v)) else {
                    return self.error(id, "bad_video", "That is not a YouTube video");
                };
                self.jukebox =
                    Some(Jukebox { video: video.clone(), title: video.clone(), playing: true, base: 0.0, since: Instant::now() });
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    if let Some(title) = youtube::title(&video).await {
                        let _ = tx.send(RoomCmd::JukeboxTitle { video, title });
                    }
                });
            }
            "pause" => {
                let Some(j) = self.jukebox.as_mut().filter(|j| j.playing) else { return };
                j.base = j.position();
                j.playing = false;
            }
            "resume" => {
                let Some(j) = self.jukebox.as_mut().filter(|j| !j.playing) else { return };
                j.since = Instant::now();
                j.playing = true;
            }
            "stop" => {
                if self.jukebox.take().is_none() {
                    return;
                }
            }
            _ => return self.error(id, "bad_message", "Unknown jukebox action"),
        }
        self.broadcast_jukebox();
    }

    /// Puts a player on a team, mid-match too. Errors name the rule broken.
    fn move_to_team(&mut self, id: u32, team: u8) -> Result<(), String> {
        if team > TEAM_BLUE {
            return Err("No such team".into());
        }
        let team_mode = self.settings.is_team_mode();
        match team {
            TEAM_FFA if team_mode => return Err("This mode uses red and blue teams".into()),
            TEAM_RED | TEAM_BLUE if !team_mode => return Err("Teams are only used in team modes".into()),
            _ => {}
        }
        let Some(i) = self.players.iter().position(|p| p.id == id) else { return Ok(()) };
        let p = &mut self.players[i];
        let was = p.team;
        p.team = team;
        if let Some(g) = self.game.as_mut() {
            if was != team {
                if p.in_match {
                    g.m.leave(id);
                }
                if team != TEAM_SPECTATOR {
                    g.m.join(id, team as f64);
                }
                p.in_match = team != TEAM_SPECTATOR;
                // the client learns its seat from a snapshot: `you` is set only while playing
                let snap = snapshot_msg(g, id, p.in_match);
                p.text(&snap);
                p.ack = g.m.tick;
                p.last_sent = None;
            }
        }
        self.broadcast_room();
        Ok(())
    }

    fn kick(&mut self, player: u32, ban: bool) {
        let Some(p) = self.player(player) else { return };
        let name = p.name.clone();
        let keys = conn_keys(&p.ip, p.account.as_ref());
        let reason = if ban { "You were banned" } else { "You were kicked" };
        p.send(Out::Text(json(&ServerMsg::Kicked { reason: reason.into() })));
        p.send(Out::Close(if ban { close::BANNED } else { close::KICKED }));
        if ban {
            self.bans.push(Ban { name: name.clone(), keys });
        }
        self.remove(player, if ban { "banned" } else { "kicked" });
        self.system_chat(&format!("{name} was {}", if ban { "banned" } else { "kicked" }));
    }

    fn start_match(&mut self) {
        self.starting = None;
        if self.finishing.is_some() {
            return;
        }
        if let Some(hz) = self.next_tick_hz.take() {
            self.tick_hz = hz;
        }
        let players: Vec<(u32, f64)> = self.players.iter().filter(|p| p.team != TEAM_SPECTATOR).map(|p| (p.id, p.team as f64)).collect();
        if players.is_empty() {
            // a quick-play room waits quietly for someone to stop spectating
            if self.quick.is_none() {
                self.system_chat("Nobody to play: everyone is spectating");
            }
            return self.broadcast_room();
        }
        // quick play plays its rotation in the room's order
        let maps: Vec<String> = if self.quick.is_some() {
            self.rotation.iter().map(|m| m.code.clone()).collect()
        } else {
            vec![self.map_code.clone()]
        };
        if maps.iter().all(|c| c.is_empty()) {
            return self.system_chat("No map selected");
        }
        let start = MatchStart {
            seed: rand::random::<u16>() as u32 + 1,
            start_tick: 0,
            tick_hz: self.tick_hz,
            players,
            settings: self.settings.clone(),
            maps,
            intro: true,
            rotation: self.quick.is_some(),
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
            p.margin_frame = 0;
            p.text(&ServerMsg::MatchStart { start: start.clone(), you: p.in_match.then_some(p.id) });
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
            tallies: award::Tallies::default(),
            qa: qa_events::EventLog::open(self.players.iter().filter(|p| p.team != TEAM_SPECTATOR).map(|p| (p.id, p.name.clone())).collect()),
            play_counted: false,
        });
        self.broadcast_room();
    }

    /// Count a library map play once per real match (after `PLAY_MIN_ELAPSED` or on natural completion),
    /// subject to a short per-map cooldown so reselecting maps or start/end spam cannot farm plays,
    /// while playing multiple real matches in the same room (with or without host changes) still counts.
    fn maybe_count_play(&mut self, natural_finish: bool) {
        let Some(g) = self.game.as_mut() else { return };
        if g.play_counted {
            return;
        }
        if !natural_finish && g.started.elapsed() < PLAY_MIN_ELAPSED {
            return;
        }
        let Some(map_id) = self.map_meta.as_ref().map(|m| m.id).filter(|&id| id > 0) else { return };
        if self.last_play.get(&map_id).is_some_and(|t| t.elapsed() < PLAY_COOLDOWN) {
            return;
        }
        g.play_counted = true;
        self.last_play.insert(map_id, Instant::now());
        let hub = self.hub.clone();
        tokio::spawn(async move {
            if let Err(e) = hub.backend.record_play(map_id).await {
                warn!(map = map_id, "could not count the play: {e}");
            }
        });
    }

    fn end_match(&mut self, reason: &str) {
        if reason == "game over" {
            self.maybe_count_play(true);
        }
        let Some(mut game) = self.game.take() else { return };
        if let Some(log) = game.qa.as_mut() {
            log.finish(&game.m.state, reason);
        }
        info!(room = %self.code, reason, "match end");
        // the end waits for in-flight awards, so each player hears its experience before the match ends
        self.finishing = Some(reason.into());
        self.send_match_end();
    }

    /// Tell everyone the match ended, once no award is still in flight.
    fn send_match_end(&mut self) {
        if self.pending_xp > 0 {
            return;
        }
        let Some(reason) = self.finishing.take() else { return };
        let m = json(&ServerMsg::MatchEnd { reason });
        for p in self.players.iter_mut() {
            p.in_match = false;
            p.send(Out::Text(m.clone()));
        }
        self.broadcast_room();
    }

    fn frame(&mut self, id: u32, frame: ClientFrame) {
        match frame {
            // pings are answered by the connection (conn.rs binary), never queued behind the room
            ClientFrame::Ping { .. } => {}
            ClientFrame::Input(f) => {
                let Some(g) = self.game.as_mut() else { return };
                let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { return };
                p.ack = p.ack.max(f.ack);
                let to_next = g.next_tick.saturating_duration_since(Instant::now()).as_secs_f64() * self.tick_hz;
                if !p.in_match {
                    // Spectators still need clock margin feedback so their TickClock tracks the server and interpolates smoothly.
                    let precise = (f.now as i64 - g.m.tick as i64) as f64 - (1.0 - to_next.clamp(0.0, 1.0));
                    p.margin16 = (precise * 16.0).round().clamp(-30000.0, 30000.0) as i32;
                    p.margin_frame = f.frame;
                    return;
                }
                if !f.changes.is_empty() {
                    p.active = Instant::now();
                }
                let receipt = g.m.submit(id, &f);
                // fraction of the current tick already elapsed counts against the margin
                let precise = receipt.margin as f64 - (1.0 - to_next.clamp(0.0, 1.0));
                p.margin16 = (precise * 16.0).round().clamp(-30000.0, 30000.0) as i32;
                p.margin_frame = f.frame;
                // peers learn each accepted change now rather than with the next batch
                for &(tick, mask) in &receipt.taken {
                    for q in self.players.iter().filter(|q| q.id != id && q.in_match) {
                        q.send(Out::Binary(ServerFrame::Hint { player: id, tick, mask }.encode()));
                    }
                }
            }
        }
    }

    /// Quick-play rooms play whenever someone is in them.
    fn quick_start(&mut self) {
        if self.quick.is_some() && self.game.is_none() && self.players.iter().any(|p| p.team != TEAM_SPECTATOR) {
            self.start_match();
        }
    }

    /// Quick play: removes players who changed no input and said nothing
    /// for [`IDLE_LIMIT`], so idle players do not hold slots.
    fn kick_idle(&mut self) {
        if self.quick.is_none() {
            return;
        }
        let idle: Vec<u32> =
            self.players.iter().filter(|p| p.live().is_some() && p.active.elapsed() > IDLE_LIMIT).map(|p| p.id).collect();
        for id in idle {
            if let Some(p) = self.player(id) {
                p.text(&ServerMsg::Kicked { reason: "You were removed from the room for being idle too long".into() });
                p.send(Out::Close(close::IDLE));
            }
            self.remove(id, "idle");
        }
    }

    /// Experience for a finished game: custom matches at their end, the
    /// quick-play rotation at the end of each game.
    fn award(&mut self, quick: bool) {
        let Some(g) = self.game.as_ref() else { return };
        let round = &g.m.state.round;
        let gs = &g.m.start.settings;
        let mut games = Vec::new();
        let awards: Vec<(u32, i32, u32)> = self
            .players
            .iter()
            .filter_map(|p| {
                let r = if quick { award::quick_award(round, gs.game_mode, p.id) } else { award::match_award(round, gs, p.id) };
                let (place, xp) = r?;
                if let Some(a) = &p.account {
                    if let Some(stats) = g.tallies.game(p.id, place) {
                        games.push((a.id, stats));
                    }
                }
                Some((p.id, place, xp))
            })
            .collect();
        for (account, stats) in games {
            let hub = self.hub.clone();
            tokio::spawn(async move {
                if let Err(e) = hub.backend.record_stats(account, stats).await {
                    warn!(account, error = %e, "could not record player stats");
                }
            });
        }
        if let Some(g) = self.game.as_mut() {
            g.tallies.reset();
        }
        for (id, placement, xp) in awards {
            let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { continue };
            match &p.account {
                Some(a) => {
                    let (hub, tx, account) = (self.hub.clone(), self.tx.clone(), a.id);
                    self.pending_xp += 1;
                    let pending = PendingAward { placement, quick };
                    tokio::spawn(async move {
                        let result = hub.backend.grant_xp(account, xp).await;
                        let _ = tx.send(RoomCmd::XpGranted { player: id, award: pending, result });
                    });
                }
                // guests keep their (capped) experience in their browser
                None => p.text(&ServerMsg::Xp(XpAward { placement, gained: xp, xp: None, level: 0, limit: None, quick })),
            }
        }
    }

    /// The store answered an account's award: record it, then end the match if nothing is left in flight.
    fn xp_granted(&mut self, id: u32, award: PendingAward, result: Result<XpGrant, String>) {
        self.pending_xp -= 1;
        self.record_xp(id, award, result);
        self.send_match_end();
    }

    /// Record an account's new XP and tell the player.
    fn record_xp(&mut self, id: u32, award: PendingAward, result: Result<XpGrant, String>) {
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { return };
        let grant = match result {
            Ok(g) => g,
            Err(e) => {
                warn!(room = %self.code, player = id, "could not grant experience: {e}");
                return;
            }
        };
        let levels_changed = p.xp.map(level_of) != Some(level_of(grant.total));
        p.xp = Some(grant.total);
        let msg = XpAward {
            placement: award.placement,
            gained: grant.granted,
            xp: Some(grant.total),
            level: level_of(grant.total),
            limit: grant.limit.map(|l| if l == neobox_store::XpLimit::Short { "short" } else { "long" }.to_string()),
            quick: award.quick,
        };
        p.text(&ServerMsg::Xp(msg));
        if levels_changed {
            self.broadcast_room();
        }
    }

    /// A library map the host asked for arrived: check the host may still change the map, then use it.
    fn library_map_loaded(&mut self, id: u32, _map: i64, result: Result<RoomMap, String>) {
        if !self.is_host(id) {
            return self.error(id, "not_host", "Only the host can change the map");
        }
        if self.game.is_some() {
            return self.error(id, "in_match", "Wait for the match to end");
        }
        let found = match result {
            Ok(m) => m,
            Err(e) => return self.error(id, "bad_map", &format!("Could not load the map: {e}")),
        };
        if let Err(e) = MapData::from_code(&found.code) {
            return self.error(id, "bad_map", &format!("Could not load the map: {e}"));
        }
        self.map_meta = Some(map_meta_of(&found));
        self.map_name = map_label(Some(found.name.as_str()));
        self.map_code = found.code;
        self.system_chat(&format!("Map changed to {}", self.map_name));
        self.broadcast_room();
    }

    /// Fastest Times: a finish that beats every time the room has announced for
    /// that player on this library map is a personal best. Signed-in players'
    /// bests are kept by the store, which says whether one is theirs; guests
    /// have nowhere to keep one, so the room announces it alone.
    fn check_records(&mut self) {
        let Some(map) = self.map_meta.as_ref().map(|m| m.id).filter(|&id| id > 0) else { return };
        let Some(g) = self.game.as_ref() else { return };
        if !g.m.start.settings.record_mode {
            return;
        }
        let finishes: Vec<(u32, i64)> =
            g.m.state.round.players.iter().filter(|(_, r)| r.co > 0.0).map(|(id, r)| (id, r.co as i64)).collect();
        let mut found = Vec::new();
        for (id, ticks) in finishes {
            let Some(p) = self.players.iter_mut().find(|p| p.id == id) else { continue };
            if p.record_seen.is_some_and(|(m, best)| m == map && best <= ticks) {
                continue;
            }
            p.record_seen = Some((map, ticks));
            found.push((p.name.clone(), p.account.as_ref().map(|a| a.id), ticks));
        }
        for (name, account, ticks) in found {
            match account {
                Some(account) => {
                    let (hub, tx) = (self.hub.clone(), self.tx.clone());
                    tokio::spawn(async move {
                        let result = hub.backend.save_record(RecordBody { account, map, ticks }).await;
                        let _ = tx.send(RoomCmd::RecordSaved { name, ticks, result });
                    });
                }
                None => self.system_chat(&personal_best_line(&name, ticks)),
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
            let before = g.qa.is_some().then(|| g.m.state.clone());
            let data = g.m.step();
            if let (Some(log), Some(prev)) = (g.qa.as_mut(), before) {
                log.record(g.m.tick, &prev, &g.m.state);
            }
            g.tallies.observe(&g.m.state.round, period.as_secs_f64());
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
            let quick_game_over = self.quick.is_some() && g.m.state.round.game_over == QUICK_AWARD_TICK;
            let rotation_index = g.m.state.round.io;
            self.check_records();
            self.send_batches(checksum);
            if too_heavy {
                warn!(room = %self.code, map = %self.map_name, "map too complex to simulate: match stopped");
                self.system_chat("This map is too complex to simulate, so the match was stopped.");
                self.end_match("map too complex");
                return;
            }
            if quick_game_over {
                self.award(true);
            }
            if outcome == Outcome::NewRound && !self.rotation.is_empty() {
                let m = &self.rotation[rotation_index as usize % self.rotation.len()];
                if m.name != self.map_name || m.code != self.map_code {
                    self.map_name = m.name.clone();
                    self.map_code = m.code.clone();
                    self.broadcast_room();
                }
            }
            if outcome == Outcome::MatchOver {
                self.award(false);
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
            // held slots get nothing until their connection resumes
            if p.live().is_none() {
                continue;
            }
            // over the unreliable data channel every unconfirmed tick is
            // resent (a few bytes each), so a lost packet costs nothing
            let udp = p.live().is_some_and(|c| c.stats.udp.load(Ordering::Relaxed));
            let from = match p.last_sent {
                Some(s) if !udp => (s + 1).max(p.ack),
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
            p.send(Out::Binary(ServerFrame::Batch { ticks, input_ack, margin16: p.margin16, margin_frame: p.margin_frame }.encode()));
            p.last_sent = Some(latest - 1);
            if let Some(h) = checksum {
                p.send(Out::Binary(ServerFrame::Checksum { tick: latest, hash: h }.encode()));
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
                    p.send(Out::Text(json(&ServerMsg::Kicked { reason: "Room closed by an administrator".into() })));
                }
                self.closed = true;
            }
            AdminCmd::Kick { player, ban } => self.kick(player, ban),
            AdminCmd::EndMatch => self.end_match("ended by an administrator"),
            AdminCmd::SetTickRate { hz } => {
                if valid_tick_hz(hz) {
                    if self.game.is_some() {
                        self.next_tick_hz = Some(hz);
                        self.system_chat(&format!("Tick rate set to {hz} Hz (applies from the next match)"));
                    } else {
                        self.tick_hz = hz;
                        for p in &self.players {
                            p.text(&ServerMsg::TickRate { tick_hz: hz });
                        }
                    }
                    self.broadcast_room();
                }
            }
            AdminCmd::Say { text } => self.system_chat(&format!("[admin] {}", text.chars().take(MAX_CHAT_LEN).collect::<String>())),
            AdminCmd::SetHost { player } => {
                if self.player(player).is_some() {
                    self.host = Some(player);
                    self.broadcast_room();
                    self.publish_players();
                }
            }
            AdminCmd::SetMaxPlayers { max } => {
                self.max_players = max.clamp(1, self.hub.cfg.max_players);
                self.broadcast_room();
            }
            AdminCmd::SetTeam { player, team } => {
                if let Err(e) = self.move_to_team(player, team) {
                    warn!(room = %self.code, player, "admin team change refused: {e}");
                }
            }
            AdminCmd::Unban { name } => {
                let before = self.bans.len();
                self.bans.retain(|b| !b.name.eq_ignore_ascii_case(&name));
                if self.bans.len() != before {
                    self.system_chat(&format!("{name} was unbanned"));
                    self.broadcast_room();
                }
            }
        }
    }

    fn update_summary(&mut self) {
        for p in self.players.iter_mut() {
            let (bi, bo) = p.live().map_or((0, 0), |c| {
                (c.stats.bytes_in.load(Ordering::Relaxed), c.stats.bytes_out.load(Ordering::Relaxed))
            });
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
        s.bans = self.bans.iter().map(|b| b.name.clone()).collect();
        s.quick = self.quick.clone();
        s.jukebox = self.jukebox.as_ref().map(|j| JukeboxInfo { video: j.video.clone(), title: j.title.clone() });
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
        drop(s);
        self.publish_players();
    }

    /// Copies the player list into the shared summary right away, so the
    /// room list, quick-play matching and friends' presence see joins and
    /// leaves before the next once-a-second refresh.
    fn publish_players(&self) {
        let mask = |id: u32| self.game.as_ref().map_or(0, |g| g.m.current_mask(id));
        let players = self
            .players
            .iter()
            .map(|p| PlayerSummary {
                id: p.id,
                name: p.name.clone(),
                team: p.team,
                host: self.host == Some(p.id),
                ping_ms: p.live().map_or(0, |c| c.stats.rtt()),
                ip: p.ip.to_string(),
                bytes_in_per_s: p.rate.0,
                bytes_out_per_s: p.rate.1,
                margin_ticks: p.margin16 as f64 / 16.0,
                transport: (if p.live().is_some_and(|c| c.stats.udp.load(Ordering::Relaxed)) { "udp" } else { "ws" }).to_string(),
                input_mask: mask(p.id),
                connected: p.live().is_some(),
                connected_s: p.live().map_or(0, |c| c.connected.elapsed().as_secs()),
                in_match: p.in_match,
                account: p.account.as_ref().map(|a| a.id),
            })
            .collect();
        let host_country = self.host.and_then(|h| self.players.iter().find(|p| p.id == h)).and_then(|p| self.hub.geo.country(p.ip));
        let mut s = self.summary.lock().unwrap();
        s.players = players;
        s.host_country = host_country;
    }
}

pub fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// The name of a map as others see it: invisible, bidi and angle-bracket characters removed, trimmed and at most
/// 60 characters. A name with nothing visible left reads as the default.
fn map_label(name: Option<&str>) -> String {
    let label: String = name.map(clean_label).unwrap_or_default().trim().chars().take(60).collect();
    if label.is_empty() { "Custom map".into() } else { label }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn::tests::start;
    use crate::hub::ConnStats;

    /// A connection from `ip`; the test reads what the room sends it through the receiver.
    fn conn(name: &str, ip: &str) -> (ConnInfo, mpsc::UnboundedReceiver<Out>) {
        let (out, rx) = mpsc::unbounded_channel();
        let info = ConnInfo {
            name: name.into(),
            out,
            stats: Arc::new(ConnStats::default()),
            ip: ip.parse::<IpAddr>().unwrap(),
            connected: Instant::now(),
            account: None,
            color: None,
            xp: None,
        };
        (info, rx)
    }

    fn new_room(hub: Arc<Hub>) -> RoomHandle {
        spawn(hub, "TEST01".into(), "test".into(), None, 8, false, RoomSetup::Custom { map: None, defaults: None })
    }

    async fn join(room: &RoomHandle, info: ConnInfo) -> u32 {
        let (reply, rx) = oneshot::channel();
        let _ = room.tx.send(RoomCmd::Join { conn: info, password: None, resume: None, reply });
        rx.await.unwrap().unwrap().0
    }

    fn say(room: &RoomHandle, player: u32, out: &mpsc::UnboundedSender<Out>, text: &str) {
        let msg = ClientMsg::Chat { text: text.into() };
        let _ = room.tx.send(RoomCmd::Msg { player, msg, out: out.clone() });
    }

    fn mute(room: &RoomHandle, host: u32, host_out: &mpsc::UnboundedSender<Out>, player: u32, muted: bool) {
        let msg = ClientMsg::Mute { player, muted };
        let _ = room.tx.send(RoomCmd::Msg { player: host, msg, out: host_out.clone() });
    }

    /// Waits until the room has handled every command sent before this call.
    async fn settle(room: &RoomHandle) {
        let (reply, rx) = oneshot::channel();
        let _ = room.tx.send(RoomCmd::View { reply });
        let _ = rx.await;
    }

    /// The text messages received so far.
    fn texts(rx: &mut mpsc::UnboundedReceiver<Out>) -> Vec<String> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|o| match o {
                Out::Text(t) => Some(t),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn map_names_are_cleaned_and_capped() {
        assert_eq!(map_label(Some("a\u{202E}bc")), "abc");
        assert_eq!(map_label(Some("<b>hi</b>")), "bhi/b");
        assert_eq!(map_label(Some("\u{3164}")), "Custom map");
        assert_eq!(map_label(None), "Custom map");
        assert_eq!(map_label(Some(&"x".repeat(80))).chars().count(), 60);
    }

    #[test]
    fn chat_budget_is_shared_by_player_address_and_account() {
        let mut buckets = HashMap::new();
        let now = Instant::now();
        let addr = ChatKey::Address("10.0.0.1".parse().unwrap());
        // two tabs of one player, and a second player from the same address
        let tab = [ChatKey::Player(1), addr];
        let other = [ChatKey::Player(2), addr];
        assert!(spend_chat(&mut buckets, &tab, now));
        assert!(spend_chat(&mut buckets, &tab, now));
        assert!(spend_chat(&mut buckets, &tab, now));
        assert!(!spend_chat(&mut buckets, &tab, now));
        assert!(!spend_chat(&mut buckets, &other, now));
        // one line per 3 seconds after the burst
        let later = now + Duration::from_secs(3);
        assert!(spend_chat(&mut buckets, &tab, later));
        assert!(!spend_chat(&mut buckets, &tab, later));
        // the account budget holds across addresses too
        let acct = [ChatKey::Player(3), ChatKey::Address("10.0.0.2".parse().unwrap()), ChatKey::Account(7)];
        let acct_b = [ChatKey::Player(4), ChatKey::Address("10.0.0.3".parse().unwrap()), ChatKey::Account(7)];
        let much_later = later + Duration::from_secs(30);
        assert!(spend_chat(&mut buckets, &acct, much_later));
        assert!(spend_chat(&mut buckets, &acct, much_later));
        assert!(spend_chat(&mut buckets, &acct, much_later));
        assert!(!spend_chat(&mut buckets, &acct_b, much_later));
    }

    #[tokio::test]
    async fn muted_player_can_use_commands_but_not_chat() {
        let (hub, _) = start().await;
        let room = new_room(hub);
        let (host, mut host_rx) = conn("Host", "10.0.0.1");
        let host_out = host.out.clone();
        let host_id = join(&room, host).await;
        let (guest, mut guest_rx) = conn("Guest", "10.0.0.2");
        let guest_out = guest.out.clone();
        let guest_id = join(&room, guest).await;
        mute(&room, host_id, &host_out, guest_id, true);
        say(&room, guest_id, &guest_out, "/help");
        say(&room, guest_id, &guest_out, "hello");
        settle(&room).await;
        let got = texts(&mut guest_rx);
        assert!(got.iter().any(|t| t.contains("Commands: /set <key>")), "{got:?}");
        assert!(got.iter().any(|t| t.contains("The host has muted you")), "{got:?}");
        assert!(!texts(&mut host_rx).iter().any(|t| t.contains("\"text\":\"hello\"")));
    }

    #[tokio::test]
    async fn mute_survives_leave_and_rejoin_until_lifted() {
        let (hub, _) = start().await;
        let room = new_room(hub);
        let (host, mut host_rx) = conn("Host", "10.0.0.1");
        let host_out = host.out.clone();
        let host_id = join(&room, host).await;
        let (guest, _guest_rx) = conn("Guest", "10.0.0.2");
        let guest_out = guest.out.clone();
        let guest_id = join(&room, guest).await;
        mute(&room, host_id, &host_out, guest_id, true);
        let _ = room.tx.send(RoomCmd::Leave { player: guest_id, out: guest_out });
        // a rejoin from the same address starts muted
        let (rejoin, mut rejoin_rx) = conn("Guest", "10.0.0.2");
        let rejoin_out = rejoin.out.clone();
        let rejoin_id = join(&room, rejoin).await;
        say(&room, rejoin_id, &rejoin_out, "first");
        settle(&room).await;
        assert!(texts(&mut rejoin_rx).iter().any(|t| t.contains("The host has muted you")));
        // lifting the mute is kept: the next rejoin chats
        mute(&room, host_id, &host_out, rejoin_id, false);
        let _ = room.tx.send(RoomCmd::Leave { player: rejoin_id, out: rejoin_out });
        let (again, mut again_rx) = conn("Guest", "10.0.0.2");
        let again_out = again.out.clone();
        let again_id = join(&room, again).await;
        say(&room, again_id, &again_out, "second");
        settle(&room).await;
        assert!(!texts(&mut again_rx).iter().any(|t| t.contains("The host has muted you")));
        assert!(texts(&mut host_rx).iter().any(|t| t.contains("\"text\":\"second\"")));
    }

    #[tokio::test]
    async fn muted_host_can_unmute_themselves() {
        let (hub, _) = start().await;
        let room = new_room(hub);
        let (host, _host_rx) = conn("Host", "10.0.0.1");
        let host_out = host.out.clone();
        let host_id = join(&room, host).await;
        let (guest, mut guest_rx) = conn("Guest", "10.0.0.2");
        let guest_out = guest.out.clone();
        let guest_id = join(&room, guest).await;
        mute(&room, host_id, &host_out, guest_id, true);
        // the muted guest takes the host seat; as host, they lift their own mute
        let msg = ClientMsg::GiveHost { player: guest_id };
        let _ = room.tx.send(RoomCmd::Msg { player: host_id, msg, out: host_out });
        mute(&room, guest_id, &guest_out, guest_id, false);
        say(&room, guest_id, &guest_out, "hi");
        settle(&room).await;
        assert!(texts(&mut guest_rx).iter().any(|t| t.contains("\"text\":\"hi\"")));
    }
}
