//! One WebSocket connection: identification, room routing, I/O.

use crate::geo::distance_km;
use crate::cluster::{self, Site};
use crate::hub::{close, AccountRef, Close, ConnInfo, ConnStats, Hub, Out, Presence, RoomHandle};
use crate::room::{json, RoomCmd};
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use futures_util::{SinkExt, StreamExt};
use neobox_net::*;
use neobox_store::FriendState;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info};

/// Largest accepted text message (bytes): map codes travel this way.
const MAX_TEXT: usize = crate::room::MAX_MAP_CODE + 4096;
const MAX_BINARY: usize = 4096;
/// Messages per second before a connection is dropped.
const MAX_MSG_RATE: u32 = 400;

/// One of an address's connection slots; released when dropped.
pub struct IpSlot {
    hub: Arc<Hub>,
    ip: IpAddr,
}

impl Drop for IpSlot {
    fn drop(&mut self) {
        let mut per_ip = self.hub.ip_conns.lock().unwrap();
        if let Some(n) = per_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                per_ip.remove(&self.ip);
            }
        }
    }
}

/// Claim one of `ip`'s slots, or `None` when it is at the cap. Called before
/// the WebSocket upgrade so an over-cap client gets an HTTP 429.
pub fn take_ip_slot(hub: &Arc<Hub>, ip: IpAddr) -> Option<IpSlot> {
    let mut per_ip = hub.ip_conns.lock().unwrap();
    if per_ip.get(&ip).copied().unwrap_or(0) >= hub.cfg.max_conns_per_ip {
        return None;
    }
    *per_ip.entry(ip).or_insert(0) += 1;
    Some(IpSlot { hub: hub.clone(), ip })
}

/// Serve one WebSocket. `account`: the signed-in account of the request's
/// session cookie, if any. `_slot` holds the address's slot until this returns.
pub async fn serve(hub: Arc<Hub>, socket: WebSocket, ip: IpAddr, _slot: IpSlot, account: Option<AccountRef>) {
    hub.conns.fetch_add(1, Ordering::Relaxed);
    let conn_id = hub.next_conn.fetch_add(1, Ordering::Relaxed);
    run(&hub, socket, ip, conn_id, account).await;
    hub.conns.fetch_sub(1, Ordering::Relaxed);
}

struct Session {
    hub: Arc<Hub>,
    info: Option<ConnInfo>,
    room: Option<(RoomHandle, u32)>,
    out: mpsc::UnboundedSender<Out>,
    stats: Arc<ConnStats>,
    ip: IpAddr,
    conn_id: u64,
    account: Option<AccountRef>,
    /// Keeps the signed-in account online while this socket is open.
    presence: Option<Presence>,
    /// data received on the WebRTC channel
    rtc_in: mpsc::UnboundedSender<Vec<u8>>,
}

impl Session {
    fn send(&self, m: &ServerMsg) {
        let t = json(m);
        self.stats.bytes_out.fetch_add(t.len() as u64, Ordering::Relaxed);
        let _ = self.out.send(Out::Text(t));
    }

    fn error(&self, code: &str, message: &str) {
        self.send(&ServerMsg::Error { code: code.into(), message: message.into() });
    }

    fn leave_room(&mut self) {
        if let Some((r, id)) = self.room.take() {
            let _ = r.tx.send(RoomCmd::Leave { player: id, out: self.out.clone() });
        }
    }

    /// The socket dropped: the room holds this player's slot for a reconnect.
    fn drop_room(&mut self) {
        if let Some((r, id)) = self.room.take() {
            let _ = r.tx.send(RoomCmd::Lost { player: id, out: self.out.clone() });
        }
    }

    async fn enter(&mut self, room: RoomHandle, password: Option<String>, resume: Option<String>) {
        let Some(info) = self.info.clone() else { return };
        self.leave_room();
        let (tx, rx) = oneshot::channel();
        if room.tx.send(RoomCmd::Join { conn: info, password, resume, reply: tx }).is_err() {
            return self.error("room_not_found", "Room not found");
        }
        match rx.await {
            // the room sends `joined` (with the resume token) itself
            Ok(Ok((id, _))) => self.room = Some((room, id)),
            Ok(Err((code, msg))) => self.error(&code, &msg),
            Err(_) => self.error("room_not_found", "Room not found"),
        }
    }

    async fn create_room(&mut self, name: String, password: Option<String>, max_players: u8, public: bool) {
        let rotation = crate::rotation::current(&self.hub).await;
        let setup = crate::room::RoomSetup::Custom { map: rotation.maps_of("custom").into_iter().next(), defaults: rotation.custom() };
        self.open_room(name, password, max_players, public, setup).await;
    }

    async fn open_room(&mut self, name: String, password: Option<String>, max_players: u8, public: bool, setup: crate::room::RoomSetup) {
        if self.hub.rooms.lock().unwrap().len() >= self.hub.cfg.max_rooms {
            return self.error("server_full", "Too many rooms right now, try again later");
        }
        let password = password.filter(|p| !p.is_empty());
        if password.as_ref().is_some_and(|p| p.chars().count() > crate::room::MAX_PASSWORD_LEN) {
            return self.error("bad_password", &format!("Passwords are at most {} characters", crate::room::MAX_PASSWORD_LEN));
        }
        let name: String = clean_label(&name).trim().chars().take(MAX_ROOM_NAME_LEN).collect();
        let name = if name.is_empty() { format!("{}'s game", self.info.as_ref().unwrap().name) } else { name };
        let code = self.hub.new_code();
        let room = crate::room::spawn(self.hub.clone(), code.clone(), name, password.clone(), max_players, public, setup);
        self.hub.rooms.lock().unwrap().insert(code, room.clone());
        // the creator knows the password
        self.enter(room, password, None).await;
        // tell the main server once the room has its host (players, host country)
        self.hub.beat.notify_one();
    }

    /// Names of this account's friends by account id (empty for guests).
    fn friend_names(&self) -> HashMap<i64, String> {
        let Some(a) = &self.account else { return HashMap::new() };
        let Some(store) = self.hub.store() else { return HashMap::new() };
        match store.friends(a.id) {
            Ok(list) => {
                list.into_iter().filter(|f| f.state == FriendState::Friend).map(|f| (f.account.id, f.account.name)).collect()
            }
            Err(e) => {
                debug!(conn = self.conn_id, "friends lookup failed: {e}");
                HashMap::new()
            }
        }
    }

    /// The viewer's coordinates, when geolocation knows them.
    fn viewer_coords(&self) -> Option<(f64, f64)> {
        self.hub.geo.lookup(self.ip).and_then(|v| v.coords)
    }

    /// Join the fullest open quick-play room of mode `queue` on any server,
    /// skipping the rooms in `exclude` (the oldest on a tie), or open a new
    /// one on the nearest server.
    async fn quick_play(&mut self, queue: Option<String>, exclude: Vec<String>) {
        let rotation = crate::rotation::current(&self.hub).await;
        let mode = match queue {
            Some(q) => rotation.mode(&q),
            None => rotation.modes().into_iter().next(),
        };
        let Some(mode) = mode else {
            return self.error("bad_queue", "Unknown quick-play mode");
        };
        // each room with the node that runs it (`None`: this server)
        let mut rooms: Vec<(crate::room::RoomSummary, Option<cluster::NodeInfo>)> =
            self.hub.summaries().into_iter().map(|r| (r, None)).collect();
        for node in cluster::live_nodes(&self.hub) {
            rooms.extend(node.rooms.iter().map(|r| (r.clone(), Some(node.clone()))));
        }
        let best = rooms
            .into_iter()
            .filter(|(r, _)| {
                r.quick.as_deref() == Some(mode.id.as_str())
                    && r.players.len() < r.max_players as usize
                    && !exclude.iter().any(|c| c.eq_ignore_ascii_case(&r.code))
            })
            .max_by_key(|(r, _)| (r.players.len(), std::cmp::Reverse(r.created_ms)));
        match best {
            Some((r, Some(node))) => {
                let then = ClientMsg::JoinRoom { room: r.code, password: None, resume: None };
                return self.send(&ServerMsg::Redirect { url: node.url, then: Box::new(then) });
            }
            Some((r, None)) => {
                if let Some(room) = self.hub.room(&r.code) {
                    return self.enter(room, None, None).await;
                }
            }
            None => {}
        }
        match cluster::nearest_site(&self.hub, self.viewer_coords()) {
            Site::Node(node) => {
                let then = ClientMsg::QuickPlay { queue: Some(mode.id), exclude };
                self.send(&ServerMsg::Redirect { url: node.url, then: Box::new(then) });
            }
            Site::Local => {
                let maps = rotation.maps_of(&mode.id);
                let (title, max) = (mode.meta.title.clone(), mode.meta.max_players.max(1));
                self.open_room(title, None, max, true, crate::room::RoomSetup::Quick { mode, maps }).await
            }
        }
    }

    async fn text(&mut self, text: &str) {
        let msg: ClientMsg = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(_) => return self.error("bad_message", "Malformed message"),
        };
        match msg {
            ClientMsg::Hello { version, name, color, ticket, build } => {
                if let Some(id) = &self.hub.cfg.build_id {
                    if build.as_deref() != Some(id.as_str()) {
                        self.error("outdated", "A new version of neobox is out. Reload to play.");
                        let _ = self.out.send(Out::Close(close::OUTDATED));
                        return;
                    }
                }
                let (account, xp) = match self.hello_account(ticket.as_deref()).await {
                    Ok(found) => found,
                    Err(()) => return self.error("bad_ticket", "Sign in again"),
                };
                self.account = account;
                self.presence = self.account.as_ref().map(|a| self.hub.presence(a.id));
                // signed in: the account name is the player name
                let name = match &self.account {
                    Some(a) => a.name.trim().to_string(),
                    None => name.trim().to_string(),
                };
                if version != PROTOCOL_VERSION {
                    return self.error("version", "Please reload the page: the game was updated");
                }
                if !valid_name(&name) {
                    return self.error("invalid_playername", "Names are 1-15 letters, digits, spaces or underscores");
                }
                self.info = Some(ConnInfo {
                    xp,
                    name: name.clone(),
                    out: self.out.clone(),
                    stats: self.stats.clone(),
                    ip: self.ip,
                    connected: Instant::now(),
                    account: self.account.clone(),
                    color: color.map(|c| c & 0xffffff),
                });
                debug!(conn = self.conn_id, %name, "hello");
                self.send(&ServerMsg::Welcome {
                    version: PROTOCOL_VERSION,
                    server: format!("neobox {}", env!("CARGO_PKG_VERSION")),
                    rtc: self.hub.rtc.is_some(),
                    region: self.hub.cfg.region.clone(),
                });
            }
            _ if self.info.is_none() => self.error("no_hello", "Say hello first"),
            ClientMsg::ListRooms => {
                let friends = self.friend_names();
                let coords = self.viewer_coords();
                let viewer = self.hub.geo.lookup(self.ip);
                let local_distance = coords.zip(self.hub.cfg.location).map(|(a, b)| distance_km(a, b));
                let local_country = self.hub.server_country();
                let mut found: Vec<(crate::room::RoomSummary, String, Option<String>, Option<u32>)> = self
                    .hub
                    .summaries()
                    .into_iter()
                    .map(|r| (r, self.hub.cfg.region.clone(), local_country.clone(), local_distance))
                    .collect();
                for node in cluster::live_nodes(&self.hub) {
                    let d = coords.zip(node.location).map(|(a, b)| distance_km(a, b));
                    let region = node.region;
                    let country = node.country;
                    found.extend(node.rooms.into_iter().map(|r| (r, region.clone(), country.clone(), d)));
                }
                let rooms = found
                    .into_iter()
                    .filter(|(r, _, _, _)| r.public)
                    .map(|(r, region, server_country, distance)| {
                        // Show the server's country beside its city name so flags never contradict the region
                        // (e.g. a host in Turkey on a Chicago server still shows the US flag next to Chicago).
                        let country = if region.is_empty() {
                            r.host_country.or(server_country)
                        } else {
                            server_country.or(r.host_country)
                        };
                        RoomInfo {
                            friends: r.players.iter().filter_map(|p| p.account.and_then(|a| friends.get(&a).cloned())).collect(),
                            code: r.code,
                            name: r.name,
                            players: r.players.len() as u8,
                            max_players: r.max_players,
                            password: r.password,
                            in_match: r.in_match,
                            map: r.map_name,
                            mode: r.game_mode,
                            quick: r.quick,
                            jukebox: r.jukebox,
                            region,
                            distance,
                            country,
                        }
                    })
                    .collect();
                self.send(&ServerMsg::Rooms { rooms, country: viewer.and_then(|v| v.country) });
            }
            ClientMsg::CreateRoom { name, password, max_players, public } => {
                match cluster::nearest_site(&self.hub, self.viewer_coords()) {
                    Site::Node(node) => {
                        let then = ClientMsg::CreateRoom { name, password, max_players, public };
                        self.send(&ServerMsg::Redirect { url: node.url, then: Box::new(then) });
                    }
                    Site::Local => self.create_room(name, password, max_players, public).await,
                }
            }
            ClientMsg::JoinRoom { room, password, resume } => match self.hub.room(&room) {
                Some(r) => self.enter(r, password, resume).await,
                None => match cluster::node_with_room(&self.hub, &room) {
                    Some(node) => {
                        let then = ClientMsg::JoinRoom { room, password, resume };
                        self.send(&ServerMsg::Redirect { url: node.url, then: Box::new(then) });
                    }
                    None if resume.as_deref().is_some_and(crate::room::is_stale_token) => {
                        self.error("server_restarted", "The server restarted, so that room is gone")
                    }
                    None => self.error("room_not_found", "Room not found"),
                },
            },
            ClientMsg::QuickPlay { queue, exclude } => self.quick_play(queue, exclude).await,
            ClientMsg::LeaveRoom => {
                self.leave_room();
                self.send(&ServerMsg::Left);
            }
            ClientMsg::RtcOffer { sdp } => {
                let Some(rtc) = &self.hub.rtc else { return self.error("rtc_unavailable", "WebRTC is disabled") };
                if sdp.len() > 16 * 1024 {
                    return self.error("bad_message", "Offer too large");
                }
                match rtc.offer(self.conn_id, sdp, self.stats.clone(), self.rtc_in.clone()).await {
                    Ok(sdp) => self.send(&ServerMsg::RtcAnswer { sdp }),
                    Err(e) => {
                        debug!(conn = self.conn_id, "rtc offer failed: {e}");
                        self.error("rtc_failed", "WebRTC negotiation failed");
                    }
                }
            }
            other => {
                // the colour also applies to rooms joined later on this connection
                if let (ClientMsg::SetColor { color }, Some(info)) = (&other, self.info.as_mut()) {
                    info.color = Some(color & 0xffffff);
                }
                match &self.room {
                    Some((r, id)) => {
                        let _ = r.tx.send(RoomCmd::Msg { player: *id, msg: other, out: self.out.clone() });
                    }
                    None => self.error("not_in_room", "Join a room first"),
                }
            }
        }
    }

    fn binary(&self, b: &[u8]) {
        let Ok(frame) = ClientFrame::decode(b) else { return };
        match frame {
            // answered here, never by the room actor: a busy room must not make a healthy link look silent
            ClientFrame::Ping { client_time } => {
                let pong = ServerFrame::Pong { client_time, server_tick: 0, tick_phase: 0.0 }.encode();
                let _ = self.out.send(Out::WsBinary(pong));
            }
            frame => {
                if let Some((r, id)) = &self.room {
                    let _ = r.tx.send(RoomCmd::Frame { player: *id, frame, out: self.out.clone() });
                }
            }
        }
    }

    /// Who a hello claims to be. On a game node the ticket names the
    /// signed-in account (a bad or expired ticket is refused; no ticket is a
    /// guest). On the main server the session cookie does, and XP comes from the store.
    async fn hello_account(&self, ticket: Option<&str>) -> Result<(Option<AccountRef>, Option<u64>), ()> {
        if self.hub.cfg.main_url.is_some() {
            let Some(t) = ticket else { return Ok((None, None)) };
            let (account, xp) = crate::ticket::verify(&self.hub.cfg.cluster_secret, t, crate::ticket::now()).ok_or(())?;
            return Ok((Some(account), Some(xp)));
        }
        let xp = match &self.account {
            Some(a) => self.hub.backend.account_xp(a.id).await.ok(),
            None => None,
        };
        Ok((self.account.clone(), xp))
    }
}

/// A client that sends nothing for this long, not even a pong to our ping, is dropped: its network is gone or it is frozen.
const SILENT_AFTER: Duration = Duration::from_secs(10);

async fn run(hub: &Arc<Hub>, socket: WebSocket, ip: IpAddr, conn_id: u64, account: Option<AccountRef>) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
    let (rtc_tx, mut rtc_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let stats = Arc::new(ConnStats::default());
    // friends see the account online while any of its sockets is open
    let presence = account.as_ref().map(|a| hub.presence(a.id));
    let mut s = Session { hub: hub.clone(), info: None, room: None, out: out_tx, stats: stats.clone(), ip, conn_id, account, presence, rtc_in: rtc_tx };
    let started = Instant::now();
    let writer_stats = stats.clone();
    let writer_hub = hub.clone();
    let mut writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                o = out_rx.recv() => {
                    let msg = match o {
                        Some(Out::Text(t)) => Message::Text(Utf8Bytes::from(t)),
                        Some(Out::Binary(b)) => match &writer_hub.rtc {
                            Some(rtc) if writer_stats.udp.load(Ordering::Relaxed) => {
                                rtc.send(conn_id, b);
                                continue;
                            }
                            _ => Message::Binary(b.into()),
                        },
                        Some(Out::WsBinary(b)) => Message::Binary(b.into()),
                        Some(Out::Close(c)) => {
                            let frame = CloseFrame { code: c.code, reason: Utf8Bytes::from_static(c.reason) };
                            let _ = sink.send(Message::Close(Some(frame))).await;
                            break;
                        }
                        None => {
                            let _ = sink.send(Message::Close(None)).await;
                            break;
                        }
                    };
                    if sink.send(msg).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    let t = started.elapsed().as_micros() as u64;
                    if sink.send(Message::Ping(t.to_le_bytes().to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut window = Instant::now();
    let mut last_seen = Instant::now();
    let mut idle = tokio::time::interval(Duration::from_secs(2));
    let mut count = 0u32;
    let mut stop = hub.shutdown.subscribe();
    // why the server closes this socket, if it does: sent as the close frame. subscribe() marks the current value as
    // seen, so a shutdown that began before this socket subscribed is read here, not awaited by changed().
    let mut closing: Option<Close> = if *stop.borrow_and_update() { Some(close::SHUTDOWN) } else { None };
    while closing.is_none() {
        let msg = tokio::select! {
            m = stream.next() => match m {
                Some(Ok(m)) => m,
                Some(Err(e)) => {
                    if e.to_string().contains("Space limit") {
                        closing = Some(close::TOO_BIG);
                    }
                    break;
                }
                None => break,
            },
            Some(b) = rtc_rx.recv() => Message::Binary(b.into()),
            _ = stop.changed() => {
                closing = Some(close::SHUTDOWN);
                break;
            }
            _ = idle.tick() => {
                if last_seen.elapsed() >= SILENT_AFTER {
                    closing = Some(close::SILENT);
                    break;
                }
                continue;
            }
        };
        last_seen = Instant::now();
        count += 1;
        if window.elapsed() >= Duration::from_secs(1) {
            window = Instant::now();
            count = 0;
        } else if count > MAX_MSG_RATE {
            info!(conn = conn_id, %ip, "message flood: disconnecting");
            closing = Some(close::FLOOD);
            break;
        }
        match msg {
            Message::Text(t) => {
                stats.bytes_in.fetch_add(t.len() as u64, Ordering::Relaxed);
                stats.msgs_in.fetch_add(1, Ordering::Relaxed);
                if t.len() > MAX_TEXT {
                    closing = Some(close::TOO_BIG);
                    break;
                }
                s.text(t.as_str()).await;
            }
            Message::Binary(b) => {
                stats.bytes_in.fetch_add(b.len() as u64, Ordering::Relaxed);
                stats.msgs_in.fetch_add(1, Ordering::Relaxed);
                if b.len() > MAX_BINARY {
                    closing = Some(close::TOO_BIG);
                    break;
                }
                s.binary(&b);
            }
            Message::Pong(p) => {
                if p.len() == 8 {
                    let sent = u64::from_le_bytes(p[..8].try_into().unwrap());
                    let now = started.elapsed().as_micros() as u64;
                    let rtt = now.saturating_sub(sent) / 1000;
                    let old = stats.rtt_ms.load(Ordering::Relaxed) as u64;
                    let smoothed = if old == 0 { rtt } else { (old * 3 + rtt) / 4 };
                    stats.rtt_ms.store(smoothed as u32, Ordering::Relaxed);
                }
            }
            Message::Ping(_) => {}
            Message::Close(_) => break,
        }
    }
    if let Some(rtc) = &hub.rtc {
        rtc.close(conn_id);
    }
    if let Some(c) = closing {
        // queued behind everything sent so far; the writer sends it and exits
        let _ = s.out.send(Out::Close(c));
    }
    s.drop_room();
    drop(s);
    if closing.is_some() {
        // keep reading until the writer has sent the close frame and the client has answered it: dropping the socket
        // with a pong still unread resets the connection, and the client can lose the close frame with it
        let drain = async { while stream.next().await.is_some() {} };
        let _ = tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(&mut writer, drain) }).await;
    }
    writer.abort();
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::hub::Config;
    use futures_util::StreamExt;
    use std::net::SocketAddr;
    use crate::room::RoomSummary;
    use std::sync::Mutex;
    use tokio_tungstenite::tungstenite::Message as ClientMsg;

    /// A hub with an empty store and the real `/ws` route on a free local port.
    pub(crate) async fn start() -> (Arc<Hub>, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = std::env::temp_dir().join(format!("neobox-conn-test-{}-{port}", std::process::id()));
        let mut cfg = Config::from_env();
        cfg.data = dir.join("neobox.db");
        cfg.max_conns_per_ip = 32;
        let store = crate::open_store(&cfg.data);
        let hub = Hub::new(cfg, Vec::new(), crate::rotation::Rotation::default(), None, Some(store));
        let app = axum::Router::new().route("/ws", axum::routing::get(crate::ws)).with_state(hub.clone());
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
        });
        (hub, format!("ws://127.0.0.1:{port}/ws"))
    }

    /// Reads until the server closes the socket; returns the close code and reason it sent.
    async fn read_close<S>(ws: &mut S) -> Option<(u16, String)>
    where
        S: futures_util::Stream<Item = Result<ClientMsg, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        // an overall deadline: the server pings every 2 s, so a per-frame timeout would never fire
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match ws.next().await {
                    Some(Ok(ClientMsg::Close(Some(f)))) => return Some((u16::from(f.code), f.reason.to_string())),
                    Some(Ok(ClientMsg::Close(None))) | Some(Err(_)) | None => return None,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await
        .expect("no close frame within 5 s")
    }

    #[tokio::test]
    async fn socket_accepted_during_shutdown_gets_the_shutdown_frame() {
        let (hub, url) = start().await;
        hub.shutdown.send_replace(true);
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert_eq!(read_close(&mut ws).await, Some((close::SHUTDOWN.code, close::SHUTDOWN.reason.to_string())));
    }

    #[tokio::test]
    async fn open_socket_gets_the_shutdown_frame_when_shutdown_begins() {
        let (hub, url) = start().await;
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        hub.shutdown.send_replace(true);
        assert_eq!(read_close(&mut ws).await, Some((close::SHUTDOWN.code, close::SHUTDOWN.reason.to_string())));
    }

    #[tokio::test]
    async fn liveness_pong_goes_out_on_the_websocket() {
        // a pong must never travel the unreliable WebRTC channel: the client reads it on the socket it pinged on
        let (hub, _) = start().await;
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
        let (rtc_tx, _rtc_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let s = Session {
            hub,
            info: None,
            room: None,
            out: out_tx,
            stats: Arc::new(ConnStats::default()),
            ip: "127.0.0.1".parse().unwrap(),
            conn_id: 1,
            account: None,
            presence: None,
            rtc_in: rtc_tx,
        };
        s.binary(&ClientFrame::Ping { client_time: 1.5 }.encode());
        match out_rx.try_recv() {
            Ok(Out::WsBinary(b)) => {
                assert_eq!(ServerFrame::decode(&b).unwrap(), ServerFrame::Pong { client_time: 1.5, server_tick: 0, tick_phase: 0.0 });
            }
            other => panic!("expected a WebSocket pong, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn liveness_pong_does_not_wait_for_a_busy_room() {
        // a room actor whose queue is never read: the pong still goes out at once, so a busy room cannot starve liveness
        let (hub, _) = start().await;
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
        let (rtc_tx, _rtc_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (room_tx, _room_rx) = mpsc::unbounded_channel::<RoomCmd>();
        let room = RoomHandle { tx: room_tx, summary: Arc::new(Mutex::new(RoomSummary::default())) };
        let s = Session {
            hub,
            info: None,
            room: Some((room, 1)),
            out: out_tx,
            stats: Arc::new(ConnStats::default()),
            ip: "127.0.0.1".parse().unwrap(),
            conn_id: 1,
            account: None,
            presence: None,
            rtc_in: rtc_tx,
        };
        s.binary(&ClientFrame::Ping { client_time: 2.5 }.encode());
        match out_rx.try_recv() {
            Ok(Out::WsBinary(b)) => {
                assert_eq!(ServerFrame::decode(&b).unwrap(), ServerFrame::Pong { client_time: 2.5, server_tick: 0, tick_phase: 0.0 });
            }
            other => panic!("expected a pong while the room is busy, got {other:?}"),
        }
    }
}
