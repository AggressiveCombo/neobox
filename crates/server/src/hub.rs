//! Shared server state: configuration, room registry, connection stats.

use crate::room::{RoomCmd, RoomSummary};
use crate::rtc::RtcHub;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::mpsc;

#[derive(Clone, Debug)]
pub struct Config {
    /// Address to listen on (put a TLS reverse proxy such as Caddy in front).
    pub bind: String,
    /// Built web client (`dist-server/client`, built from `client/dist`).
    pub static_dir: PathBuf,
    /// Built-in maps (`maps/*.json` compact map JSON or `*.txt` map codes).
    pub maps_dir: PathBuf,
    /// Admin password; the admin interface is disabled when empty.
    pub admin_password: String,
    pub max_rooms: usize,
    pub max_players: u8,
    pub max_conns_per_ip: usize,
    /// Trust `X-Forwarded-For` / `X-Forwarded-Proto` (when behind a proxy).
    pub trust_proxy: bool,
    pub default_tick_hz: f64,
    /// UDP address for WebRTC data channels; `None` disables them.
    pub rtc_bind: Option<SocketAddr>,
    /// Address browsers reach `rtc_bind` at (the server's public IP).
    pub rtc_public: Option<SocketAddr>,
}

impl Config {
    pub fn from_env() -> Config {
        let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        Config {
            bind: var("NEOBOX_BIND", "127.0.0.1:8080"),
            static_dir: var("NEOBOX_STATIC", "client").into(),
            maps_dir: var("NEOBOX_MAPS", "maps").into(),
            admin_password: var("NEOBOX_ADMIN_PASSWORD", ""),
            max_rooms: var("NEOBOX_MAX_ROOMS", "200").parse().unwrap_or(200),
            max_players: var("NEOBOX_MAX_PLAYERS", "32").parse().unwrap_or(32).clamp(1, 64),
            max_conns_per_ip: var("NEOBOX_MAX_CONNS_PER_IP", "8").parse().unwrap_or(8),
            trust_proxy: var("NEOBOX_TRUST_PROXY", "true") == "true",
            default_tick_hz: 30.0,
            rtc_bind: match var("NEOBOX_RTC_BIND", "0.0.0.0:3478").as_str() {
                "off" | "" => None,
                v => v.parse().ok(),
            },
            rtc_public: std::env::var("NEOBOX_RTC_PUBLIC").ok().and_then(|v| v.parse().ok()),
        }
    }
}

/// Message to a connection's writer.
#[derive(Debug)]
pub enum Out {
    Text(String),
    Binary(Vec<u8>),
    Close(String),
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
}

impl ConnInfo {
    pub fn send(&self, o: Out) {
        let n = match &o {
            Out::Text(t) => t.len(),
            Out::Binary(b) => b.len(),
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

pub struct Hub {
    pub cfg: Config,
    pub maps: Vec<BuiltinMap>,
    pub rooms: Mutex<HashMap<String, RoomHandle>>,
    pub next_conn: AtomicU64,
    pub started: Instant,
    pub conns: AtomicUsize,
    pub ip_conns: Mutex<HashMap<IpAddr, usize>>,
    pub admin_sessions: Mutex<HashMap<String, Instant>>,
    pub login_attempts: Mutex<HashMap<IpAddr, Vec<Instant>>>,
    pub rtc: Option<RtcHub>,
}

impl Hub {
    pub fn new(cfg: Config, maps: Vec<BuiltinMap>, rtc: Option<RtcHub>) -> Arc<Hub> {
        Arc::new(Hub {
            cfg,
            maps,
            rooms: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            started: Instant::now(),
            conns: AtomicUsize::new(0),
            ip_conns: Mutex::new(HashMap::new()),
            admin_sessions: Mutex::new(HashMap::new()),
            login_attempts: Mutex::new(HashMap::new()),
            rtc,
        })
    }

    pub fn room(&self, code: &str) -> Option<RoomHandle> {
        self.rooms.lock().unwrap().get(&code.to_ascii_uppercase()).cloned()
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
        const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let rooms = self.rooms.lock().unwrap();
        loop {
            let mut r = rand::rng();
            let code: String = (0..6).map(|_| CHARS[r.random_range(0..CHARS.len())] as char).collect();
            if !rooms.contains_key(&code) {
                return code;
            }
        }
    }
}
