//! One WebSocket connection: identification, room routing, I/O.

use crate::hub::{ConnInfo, ConnStats, Hub, Out, RoomHandle};
use crate::room::{json, RoomCmd};
use axum::extract::ws::{close_code, CloseFrame, Message, Utf8Bytes, WebSocket};
use futures_util::{SinkExt, StreamExt};
use neobox_net::*;
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

pub async fn serve(hub: Arc<Hub>, mut socket: WebSocket, ip: IpAddr) {
    let admitted = {
        let mut per_ip = hub.ip_conns.lock().unwrap();
        let n = per_ip.entry(ip).or_insert(0);
        let admitted = *n < hub.cfg.max_conns_per_ip;
        if admitted {
            *n += 1;
        }
        admitted
    };
    if !admitted {
        info!(%ip, "too many connections from this address");
        let frame = CloseFrame { code: close_code::POLICY, reason: Utf8Bytes::from_static("Too many connections from your network") };
        let _ = socket.send(Message::Close(Some(frame))).await;
        return;
    }
    hub.conns.fetch_add(1, Ordering::Relaxed);
    let conn_id = hub.next_conn.fetch_add(1, Ordering::Relaxed);
    run(&hub, socket, ip, conn_id).await;
    hub.conns.fetch_sub(1, Ordering::Relaxed);
    let mut per_ip = hub.ip_conns.lock().unwrap();
    if let Some(n) = per_ip.get_mut(&ip) {
        *n -= 1;
        if *n == 0 {
            per_ip.remove(&ip);
        }
    }
}

struct Session {
    hub: Arc<Hub>,
    info: Option<ConnInfo>,
    room: Option<(RoomHandle, u32)>,
    out: mpsc::UnboundedSender<Out>,
    stats: Arc<ConnStats>,
    ip: IpAddr,
    conn_id: u64,
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
            let _ = r.tx.send(RoomCmd::Leave { player: id });
        }
    }

    async fn enter(&mut self, room: RoomHandle, password: Option<String>) {
        let Some(info) = self.info.clone() else { return };
        self.leave_room();
        let (tx, rx) = oneshot::channel();
        if room.tx.send(RoomCmd::Join { conn: info, password, reply: tx }).is_err() {
            return self.error("room_not_found", "Room not found");
        }
        match rx.await {
            Ok(Ok(id)) => self.room = Some((room, id)),
            Ok(Err((code, msg))) => self.error(&code, &msg),
            Err(_) => self.error("room_not_found", "Room not found"),
        }
    }

    async fn text(&mut self, text: &str) {
        let msg: ClientMsg = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(_) => return self.error("bad_message", "Malformed message"),
        };
        match msg {
            ClientMsg::Hello { version, name } => {
                let name = name.trim().to_string();
                if version != PROTOCOL_VERSION {
                    return self.error("version", "Please reload the page: the game was updated");
                }
                if !valid_name(&name) {
                    return self.error("invalid_playername", "Names are 1-15 letters, digits, spaces or underscores");
                }
                self.info = Some(ConnInfo {
                    name: name.clone(),
                    out: self.out.clone(),
                    stats: self.stats.clone(),
                    ip: self.ip,
                    connected: Instant::now(),
                });
                debug!(conn = self.conn_id, %name, "hello");
                self.send(&ServerMsg::Welcome {
                    version: PROTOCOL_VERSION,
                    server: format!("neobox {}", env!("CARGO_PKG_VERSION")),
                    rtc: self.hub.rtc.is_some(),
                });
            }
            _ if self.info.is_none() => self.error("no_hello", "Say hello first"),
            ClientMsg::ListRooms => {
                let rooms = self
                    .hub
                    .summaries()
                    .into_iter()
                    .filter(|r| r.public)
                    .map(|r| RoomInfo {
                        code: r.code,
                        name: r.name,
                        players: r.players.len() as u8,
                        max_players: r.max_players,
                        password: r.password,
                        in_match: r.in_match,
                        map: r.map_name,
                    })
                    .collect();
                self.send(&ServerMsg::Rooms { rooms });
            }
            ClientMsg::CreateRoom { name, password, max_players, public } => {
                if self.hub.rooms.lock().unwrap().len() >= self.hub.cfg.max_rooms {
                    return self.error("server_full", "Too many rooms right now, try again later");
                }
                let name: String = name.trim().chars().take(MAX_ROOM_NAME_LEN).collect();
                let name = if name.is_empty() { format!("{}'s game", self.info.as_ref().unwrap().name) } else { name };
                let code = self.hub.new_code();
                let room = crate::room::spawn(self.hub.clone(), code.clone(), name, password, max_players, public);
                self.hub.rooms.lock().unwrap().insert(code, room.clone());
                self.enter(room, None).await;
            }
            ClientMsg::JoinRoom { room, password } => match self.hub.room(&room) {
                Some(r) => self.enter(r, password).await,
                None => self.error("room_not_found", "Room not found"),
            },
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
            other => match &self.room {
                Some((r, id)) => {
                    let _ = r.tx.send(RoomCmd::Msg { player: *id, msg: other });
                }
                None => self.error("not_in_room", "Join a room first"),
            },
        }
    }

    fn binary(&self, b: &[u8]) {
        let Ok(frame) = ClientFrame::decode(b) else { return };
        if let Some((r, id)) = &self.room {
            let _ = r.tx.send(RoomCmd::Frame { player: *id, frame });
        } else if let ClientFrame::Ping { client_time } = frame {
            let pong = ServerFrame::Pong { client_time, server_tick: 0, tick_phase: 0.0 }.encode();
            let _ = self.out.send(Out::Binary(pong));
        }
    }
}

async fn run(hub: &Arc<Hub>, socket: WebSocket, ip: IpAddr, conn_id: u64) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
    let (rtc_tx, mut rtc_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let stats = Arc::new(ConnStats::default());
    let mut s = Session { hub: hub.clone(), info: None, room: None, out: out_tx, stats: stats.clone(), ip, conn_id, rtc_in: rtc_tx };
    let started = Instant::now();
    let writer_stats = stats.clone();
    let writer_hub = hub.clone();
    let writer = tokio::spawn(async move {
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
                        Some(Out::Close(reason)) => {
                            let frame = CloseFrame { code: close_code::POLICY, reason: Utf8Bytes::from(reason) };
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
    let mut count = 0u32;
    loop {
        let msg = tokio::select! {
            m = stream.next() => match m {
                Some(Ok(m)) => m,
                _ => break,
            },
            Some(b) = rtc_rx.recv() => Message::Binary(b.into()),
        };
        count += 1;
        if window.elapsed() >= Duration::from_secs(1) {
            window = Instant::now();
            count = 0;
        } else if count > MAX_MSG_RATE {
            info!(conn = conn_id, %ip, "message flood: disconnecting");
            break;
        }
        match msg {
            Message::Text(t) => {
                stats.bytes_in.fetch_add(t.len() as u64, Ordering::Relaxed);
                stats.msgs_in.fetch_add(1, Ordering::Relaxed);
                if t.len() > MAX_TEXT {
                    break;
                }
                s.text(t.as_str()).await;
            }
            Message::Binary(b) => {
                stats.bytes_in.fetch_add(b.len() as u64, Ordering::Relaxed);
                stats.msgs_in.fetch_add(1, Ordering::Relaxed);
                if b.len() > MAX_BINARY {
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
    s.leave_room();
    drop(s);
    writer.abort();
}
