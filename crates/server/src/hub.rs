//! Shared server state: configuration, room registry, connection stats.

use crate::room::{RoomCmd, RoomSummary};
use crate::rtc::RtcHub;
use std::collections::HashMap;
use std::hash::Hash;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use neobox_store::Store;
use crate::backend::{Backend, Remote};
use tokio::sync::mpsc;

#[derive(Clone, Debug)]
pub struct Config {
    /// Address to listen on (put a TLS reverse proxy such as Caddy in front).
    pub bind: String,
    /// Built web client (`dist-server/client`, built from `client/dist`).
    pub static_dir: PathBuf,
    /// Built-in maps (`maps/*.json` compact map JSON or `*.txt` map codes).
    pub maps_dir: PathBuf,
    /// SQLite file for accounts, friends, the map library and preferences; its directory is created.
    pub data: PathBuf,
    /// Admin password; the admin interface is disabled when empty.
    pub admin_password: String,
    pub max_rooms: usize,
    pub max_players: u8,
    pub max_conns_per_ip: usize,
    /// Honour `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto`, but only
    /// from a peer that is a trusted proxy (see `trusted_proxies`). Off by default.
    pub trust_proxy: bool,
    /// Peers whose forwarded headers are believed when `trust_proxy` is on, besides
    /// loopback (`NEOBOX_TRUSTED_PROXIES`, comma separated IPs).
    pub trusted_proxies: Vec<IpAddr>,
    pub default_tick_hz: f64,
    /// UDP address for WebRTC data channels; `None` disables them.
    pub rtc_bind: Option<SocketAddr>,
    /// Address browsers reach `rtc_bind` at (the server's public IP).
    pub rtc_public: Option<SocketAddr>,
    /// MaxMind-format city database for distances and flags (`NEOBOX_GEOIP`); `None`: off.
    pub geoip: Option<PathBuf>,
    /// This server's region name shown in the room list (`NEOBOX_REGION`; empty: single server).
    pub region: String,
    /// This server's latitude and longitude (`NEOBOX_LOCATION`, `"lat,lon"`).
    pub location: Option<(f64, f64)>,
    /// Base URL browsers reach this server at (`NEOBOX_PUBLIC_URL`, e.g. `https://eu.example.org`).
    pub public_url: String,
    /// Base URL of the main server (`NEOBOX_MAIN`). Set only on regional game
    /// nodes; without it this server is the main server.
    pub main_url: Option<String>,
    /// Shared secret of the main server and its game nodes (`NEOBOX_CLUSTER_SECRET`;
    /// empty on the main server: no nodes accepted).
    pub cluster_secret: String,
    /// Origins besides this server's own that may use its game socket and API
    /// (`NEOBOX_ALLOWED_ORIGINS`, comma separated). The public and main URLs are always included.
    pub allowed_origins: Vec<String>,
}

/// Origins that may open the game socket and post to this server: the
/// configured list plus the public and main URLs (lowercase, no trailing slash).
fn allowed_origins(list: &str, public_url: &str, main_url: Option<&str>) -> Vec<String> {
    list.split(',')
        .chain([public_url, main_url.unwrap_or("")])
        .map(|o| o.trim().trim_end_matches('/').to_ascii_lowercase())
        .filter(|o| !o.is_empty())
        .collect()
}

/// The proxy addresses listed in `NEOBOX_TRUSTED_PROXIES`. Entries that are not IP addresses are logged and skipped.
fn trusted_proxies(list: &str) -> Vec<IpAddr> {
    list.split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .filter_map(|e| match e.parse() {
            Ok(ip) => Some(ip),
            Err(_) => {
                tracing::warn!("NEOBOX_TRUSTED_PROXIES entry {e} is not an IP address; ignored");
                None
            }
        })
        .collect()
}

impl Config {
    pub fn from_env() -> Config {
        let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let public_url = var("NEOBOX_PUBLIC_URL", "").trim().trim_end_matches('/').to_string();
        let main_url = std::env::var("NEOBOX_MAIN").ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty());
        let allowed_origins = allowed_origins(&var("NEOBOX_ALLOWED_ORIGINS", ""), &public_url, main_url.as_deref());
        Config {
            bind: var("NEOBOX_BIND", "127.0.0.1:8080"),
            static_dir: var("NEOBOX_STATIC", "client").into(),
            maps_dir: var("NEOBOX_MAPS", "maps").into(),
            data: var("NEOBOX_DATA", "data/neobox.db").into(),
            admin_password: var("NEOBOX_ADMIN_PASSWORD", ""),
            max_rooms: var("NEOBOX_MAX_ROOMS", "200").parse().unwrap_or(200),
            max_players: var("NEOBOX_MAX_PLAYERS", "32").parse().unwrap_or(32).clamp(1, 64),
            max_conns_per_ip: var("NEOBOX_MAX_CONNS_PER_IP", "8").parse().unwrap_or(8),
            trust_proxy: var("NEOBOX_TRUST_PROXY", "false") == "true",
            trusted_proxies: trusted_proxies(&var("NEOBOX_TRUSTED_PROXIES", "")),
            default_tick_hz: 30.0,
            rtc_bind: match var("NEOBOX_RTC_BIND", "0.0.0.0:3478").as_str() {
                "off" | "" => None,
                v => match v.parse() {
                    Ok(addr) => Some(addr),
                    Err(_) => {
                        tracing::warn!("NEOBOX_RTC_BIND={v} is not ip:port; WebRTC is off");
                        None
                    }
                },
            },
            rtc_public: std::env::var("NEOBOX_RTC_PUBLIC").ok().and_then(|v| match v.parse() {
                Ok(addr) => Some(addr),
                Err(_) => {
                    tracing::warn!("NEOBOX_RTC_PUBLIC={v} is not ip:port; the public address is detected");
                    None
                }
            }),
            geoip: std::env::var("NEOBOX_GEOIP").ok().filter(|v| !v.is_empty()).map(PathBuf::from),
            region: var("NEOBOX_REGION", "").trim().to_string(),
            location: std::env::var("NEOBOX_LOCATION").ok().and_then(|v| crate::geo::parse_location(&v)),
            public_url,
            main_url,
            cluster_secret: var("NEOBOX_CLUSTER_SECRET", ""),
            allowed_origins,
        }
    }
}

/// Message to a connection's writer.
#[derive(Debug)]
pub enum Out {
    Text(String),
    /// A binary frame that may go over the WebRTC data channel when the client has one.
    Binary(Vec<u8>),
    /// A binary frame that always goes over the WebSocket: liveness answers, which the client
    /// reads on the socket it pinged on, so they must not travel the unreliable channel.
    WsBinary(Vec<u8>),
    Close(Close),
}

/// How a connection is closed: a WebSocket close code and the reason the
/// client reads (machine-readable; the client picks its message from it).
#[derive(Debug, Clone, Copy)]
pub struct Close {
    pub code: u16,
    pub reason: &'static str,
}

pub mod close {
    use super::Close;
    use axum::extract::ws::close_code;
    /// Another socket took over this player's seat.
    pub const REPLACED: Close = Close { code: close_code::POLICY, reason: "replaced" };
    /// Removed by the room's host (kick) or a ban.
    pub const KICKED: Close = Close { code: close_code::POLICY, reason: "kicked" };
    pub const BANNED: Close = Close { code: close_code::POLICY, reason: "banned" };
    /// Sat idle past the room's limit.
    pub const IDLE: Close = Close { code: close_code::POLICY, reason: "idle" };
    /// Sent too many messages per second.
    pub const FLOOD: Close = Close { code: close_code::POLICY, reason: "flood" };
    /// Sent nothing for too long, not even a pong: the network is gone or the client is frozen.
    pub const SILENT: Close = Close { code: close_code::POLICY, reason: "silent" };
    /// A message exceeded the size limit.
    pub const TOO_BIG: Close = Close { code: close_code::SIZE, reason: "too_big" };
    /// The server is restarting.
    pub const SHUTDOWN: Close = Close { code: close_code::AWAY, reason: "shutdown" };
}

/// Live per-connection statistics.
#[derive(Default, Debug)]
pub struct ConnStats {
    pub bytes_in: AtomicU64,
    pub bytes_out: AtomicU64,
    pub msgs_in: AtomicU64,
    pub msgs_out: AtomicU64,
    pub rtt_ms: AtomicU32,
    /// Binary frames travel over the WebRTC data channel.
    pub udp: AtomicBool,
}

impl ConnStats {
    pub fn rtt(&self) -> u32 {
        self.rtt_ms.load(Ordering::Relaxed)
    }
}

/// Everything a room needs to talk to a connection.
#[derive(Clone, Debug)]
pub struct ConnInfo {
    pub name: String,
    pub out: mpsc::UnboundedSender<Out>,
    pub stats: Arc<ConnStats>,
    pub ip: IpAddr,
    pub connected: Instant,
    /// The signed-in account of this connection (`None` for guests).
    pub account: Option<AccountRef>,
    /// Appearance colour the player chose (`None`: the room assigns one).
    pub color: Option<u32>,
    /// The account's XP as the ticket or main server gave it (`None`: guest or unknown).
    pub xp: Option<u64>,
}

/// A signed-in account as rooms see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountRef {
    pub id: i64,
    /// Account name (also the player name while signed in).
    pub name: String,
}

impl ConnInfo {
    pub fn send(&self, o: Out) {
        let n = match &o {
            Out::Text(t) => t.len(),
            Out::Binary(b) | Out::WsBinary(b) => b.len(),
            Out::Close(_) => 0,
        };
        self.stats.bytes_out.fetch_add(n as u64, Ordering::Relaxed);
        self.stats.msgs_out.fetch_add(1, Ordering::Relaxed);
        let _ = self.out.send(o);
    }
}

#[derive(Clone)]
pub struct RoomHandle {
    pub tx: mpsc::UnboundedSender<RoomCmd>,
    pub summary: Arc<Mutex<RoomSummary>>,
}

/// A built-in map shipped with the server.
#[derive(Clone, Debug)]
pub struct BuiltinMap {
    pub name: String,
    pub code: String,
}

/// Characters of a room code (see `Hub::new_code`).
pub const ROOM_CODE_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub struct Hub {
    pub cfg: Config,
    pub maps: Vec<BuiltinMap>,
    pub rooms: Mutex<HashMap<String, RoomHandle>>,
    pub next_conn: AtomicU64,
    pub started: Instant,
    pub conns: AtomicUsize,
    pub ip_conns: Mutex<HashMap<IpAddr, usize>>,
    pub admin_sessions: Mutex<HashMap<String, Instant>>,
    /// Admin sign-in attempts per IP.
    pub admin_login: Limiter<IpAddr>,
    /// Account sign-in and registration attempts per IP.
    pub account_login: Limiter<IpAddr>,
    /// Map uploads per account.
    pub uploads: Limiter<i64>,
    /// Report submissions per address.
    pub reports: Limiter<IpAddr>,
    /// Signed-in accounts with an open WebSocket, with the number of sockets.
    pub online: Mutex<HashMap<i64, usize>>,
    /// Regional game nodes that beat at this (main) server, by public URL.
    pub nodes: Mutex<HashMap<String, crate::cluster::NodeInfo>>,
    /// Wakes the heartbeat early: a room was created or closed.
    pub beat: tokio::sync::Notify,
    pub backend: Backend,
    pub rtc: Option<RtcHub>,
    pub geo: crate::geo::Geo,
    /// Fixed quick-play rotation (`maps/rotation/maps2.json`).
    pub rotation: crate::rotation::Rotation,
    /// The full rotation as last built (see `rotation::current`).
    pub rotation_cache: tokio::sync::Mutex<Option<(Instant, Arc<crate::rotation::Rotation>)>>,
    /// Set to true when the server shuts down: each connection sends a close frame.
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

impl Hub {
    pub fn new(
        cfg: Config,
        maps: Vec<BuiltinMap>,
        rotation: crate::rotation::Rotation,
        rtc: Option<RtcHub>,
        store: Option<Store>,
    ) -> Arc<Hub> {
        let cfg_geoip = cfg.geoip.clone();
        let backend = match (&cfg.main_url, store) {
            (Some(main), _) => Backend::Remote(Remote::new(main.clone(), cfg.cluster_secret.clone())),
            (None, Some(store)) => Backend::Local(Arc::new(store)),
            (None, None) => panic!("the main server needs a store"),
        };
        Arc::new(Hub {
            cfg,
            maps,
            rooms: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            started: Instant::now(),
            conns: AtomicUsize::new(0),
            ip_conns: Mutex::new(HashMap::new()),
            admin_sessions: Mutex::new(HashMap::new()),
            admin_login: Limiter::new(5, Duration::from_secs(60)),
            account_login: Limiter::new(5, Duration::from_secs(60)),
            uploads: Limiter::new(10, Duration::from_secs(3600)),
            reports: Limiter::new(10, Duration::from_secs(3600)),
            online: Mutex::new(HashMap::new()),
            nodes: Mutex::new(HashMap::new()),
            beat: tokio::sync::Notify::new(),
            backend,
            rtc,
            geo: crate::geo::Geo::open(cfg_geoip),
            rotation,
            rotation_cache: tokio::sync::Mutex::new(None),
            shutdown: tokio::sync::watch::channel(false).0,
        })
    }

    pub fn room(&self, code: &str) -> Option<RoomHandle> {
        self.rooms.lock().unwrap().get(&code.to_ascii_uppercase()).cloned()
    }

    pub fn store(&self) -> Option<&Arc<Store>> {
        self.backend.store()
    }

    pub fn summaries(&self) -> Vec<RoomSummary> {
        let rooms: Vec<RoomHandle> = self.rooms.lock().unwrap().values().cloned().collect();
        let mut v: Vec<RoomSummary> = rooms.iter().map(|r| r.summary.lock().unwrap().clone()).collect();
        v.sort_by(|a, b| a.created_ms.cmp(&b.created_ms));
        v
    }

    /// A fresh 6-character room code.
    pub fn new_code(&self) -> String {
        use rand::Rng;
        let rooms = self.rooms.lock().unwrap();
        loop {
            let mut r = rand::rng();
            let code: String = (0..6).map(|_| ROOM_CODE_CHARS[r.random_range(0..ROOM_CODE_CHARS.len())] as char).collect();
            if !rooms.contains_key(&code) && !self.nodes.lock().unwrap().values().any(|n| n.rooms.iter().any(|r| r.code == code)) {
                return code;
            }
        }
    }

    /// Mark an account online while the returned guard lives.
    pub fn presence(self: &Arc<Self>, id: i64) -> Presence {
        *self.online.lock().unwrap().entry(id).or_insert(0) += 1;
        Presence { hub: self.clone(), id }
    }

    pub fn is_online(&self, id: i64) -> bool {
        self.online.lock().unwrap().contains_key(&id)
    }
}

/// Keeps an account online while one of its WebSockets is open.
pub struct Presence {
    hub: Arc<Hub>,
    id: i64,
}

impl Drop for Presence {
    fn drop(&mut self) {
        let mut online = self.hub.online.lock().unwrap();
        if let Some(n) = online.get_mut(&self.id) {
            *n -= 1;
            if *n == 0 {
                online.remove(&self.id);
            }
        }
    }
}

/// Sliding-window attempt counter: at most `max` attempts per key in `window`.
pub struct Limiter<K> {
    window: Duration,
    max: usize,
    hits: Mutex<HashMap<K, Vec<Instant>>>,
}

impl<K: Hash + Eq> Limiter<K> {
    pub fn new(max: usize, window: Duration) -> Limiter<K> {
        Limiter { window, max, hits: Mutex::new(HashMap::new()) }
    }

    /// Record an attempt. False when the key is already at its limit (the
    /// refused attempt is not recorded).
    pub fn allow(&self, key: K) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap();
        let list = hits.entry(key).or_default();
        list.retain(|t| now.duration_since(*t) < self.window);
        if list.len() >= self.max {
            return false;
        }
        list.push(now);
        true
    }

    /// Forget keys with no attempt inside the window.
    pub fn prune(&self) {
        let now = Instant::now();
        self.hits.lock().unwrap().retain(|_, list| {
            list.retain(|t| now.duration_since(*t) < self.window);
            !list.is_empty()
        });
    }
}
