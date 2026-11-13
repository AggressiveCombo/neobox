//! WebRTC data channels: the low-latency game transport.
//!
//! Browsers cannot send raw UDP, but a WebRTC data channel configured as
//! unordered with no retransmissions behaves like UDP: a lost packet never
//! delays the ones behind it (TCP/WebSocket stalls every later packet until
//! the lost one is resent). The game protocol is built for this: clients
//! resend unacknowledged input changes and the server resends every tick the
//! client has not confirmed, so loss costs no extra round trip.
//!
//! The WebSocket stays the signalling and fallback path: the client sends an
//! SDP offer over it, the server answers, and binary game frames switch to
//! the data channel once it opens (and back if it closes).
//!
//! All peers share one UDP port, driven by one task (the server is ICE-lite
//! with a single host candidate: the public address).

use crate::hub::ConnStats;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use str0m::channel::ChannelId;
use str0m::change::SdpOffer;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info};

/// Peers whose channel has not opened by then are dropped.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Largest datagram accepted.
const MAX_DATAGRAM: usize = 2048;

enum Cmd {
    Offer { conn_id: u64, sdp: String, stats: Arc<ConnStats>, inbound: mpsc::UnboundedSender<Vec<u8>>, reply: oneshot::Sender<Result<String, String>> },
    Send { conn_id: u64, data: Vec<u8> },
    Close { conn_id: u64 },
}

/// Handle to the WebRTC task.
pub struct RtcHub {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl RtcHub {
    /// Bind `bind` (UDP) and advertise `public` as the address browsers
    /// connect to.
    pub async fn start(bind: SocketAddr, public: SocketAddr) -> std::io::Result<RtcHub> {
        str0m::crypto::from_feature_flags().install_process_default();
        let socket = UdpSocket::bind(bind).await?;
        info!(%bind, %public, "WebRTC transport listening (UDP)");
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(socket, public, rx));
        Ok(RtcHub { tx })
    }

    /// Answer a client's offer. Data from the channel goes to `inbound`;
    /// `stats.udp` tells whether the channel is open.
    pub async fn offer(&self, conn_id: u64, sdp: String, stats: Arc<ConnStats>, inbound: mpsc::UnboundedSender<Vec<u8>>) -> Result<String, String> {
        let (reply, rx) = oneshot::channel();
        self.tx.send(Cmd::Offer { conn_id, sdp, stats, inbound, reply }).map_err(|_| "rtc stopped".to_string())?;
        rx.await.map_err(|_| "rtc stopped".to_string())?
    }

    pub fn send(&self, conn_id: u64, data: Vec<u8>) {
        let _ = self.tx.send(Cmd::Send { conn_id, data });
    }

    pub fn close(&self, conn_id: u64) {
        let _ = self.tx.send(Cmd::Close { conn_id });
    }
}

struct Peer {
    conn_id: u64,
    rtc: Rtc,
    channel: Option<ChannelId>,
    stats: Arc<ConnStats>,
    inbound: mpsc::UnboundedSender<Vec<u8>>,
    created: Instant,
}

impl Peer {
    /// Flush output; returns when the peer next needs a timeout input.
    fn drive(&mut self, socket: &UdpSocket) -> Instant {
        loop {
            if !self.rtc.is_alive() {
                return Instant::now();
            }
            match self.rtc.poll_output() {
                Ok(Output::Timeout(t)) => return t,
                Ok(Output::Transmit(t)) => {
                    // UDP sends only fail when the kernel buffer is full: drop
                    // (the protocol tolerates loss)
                    let _ = socket.try_send_to(&t.contents, t.destination);
                }
                Ok(Output::Event(e)) => self.event(e),
                Err(e) => {
                    debug!(conn = self.conn_id, "rtc error: {e:?}");
                    self.rtc.disconnect();
                }
            }
        }
    }

    fn event(&mut self, e: Event) {
        match e {
            Event::ChannelOpen(id, _) => {
                self.channel = Some(id);
                self.stats.udp.store(true, Ordering::Relaxed);
                debug!(conn = self.conn_id, "data channel open");
            }
            Event::ChannelData(d) => {
                if d.binary && d.data.len() <= MAX_DATAGRAM {
                    self.stats.bytes_in.fetch_add(d.data.len() as u64, Ordering::Relaxed);
                    self.stats.msgs_in.fetch_add(1, Ordering::Relaxed);
                    let _ = self.inbound.send(d.data);
                }
            }
            Event::ChannelClose(_) => {
                self.channel = None;
                self.stats.udp.store(false, Ordering::Relaxed);
            }
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => self.rtc.disconnect(),
            _ => {}
        }
    }

    fn send(&mut self, data: &[u8]) {
        if let Some(mut ch) = self.channel.and_then(|id| self.rtc.channel(id)) {
            let _ = ch.write(true, data);
        }
    }

    fn alive(&self) -> bool {
        self.rtc.is_alive() && (self.channel.is_some() || self.created.elapsed() < CONNECT_TIMEOUT)
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.stats.udp.store(false, Ordering::Relaxed);
    }
}

fn accept(public: SocketAddr, sdp: &str) -> Result<(Rtc, String), String> {
    let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| format!("bad offer: {e}"))?;
    let mut rtc = Rtc::builder().set_ice_lite(true).build(Instant::now());
    let candidate = Candidate::host(public, "udp").map_err(|e| format!("bad candidate: {e}"))?;
    rtc.add_local_candidate(candidate);
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| format!("offer rejected: {e}"))?;
    Ok((rtc, answer.to_sdp_string()))
}

async fn run(socket: UdpSocket, public: SocketAddr, mut rx: mpsc::UnboundedReceiver<Cmd>) {
    let mut peers: Vec<Peer> = Vec::new();
    let mut buf = vec![0u8; MAX_DATAGRAM];
    loop {
        let mut wake = Instant::now() + Duration::from_millis(500);
        for p in &mut peers {
            wake = wake.min(p.drive(&socket));
        }
        peers.retain(Peer::alive);
        tokio::select! {
            r = socket.recv_from(&mut buf) => {
                let Ok((n, source)) = r else { continue };
                let Ok(contents) = buf[..n].try_into() else { continue };
                // str0m pairs packets with the local candidate by destination; the
                // socket may be bound to 0.0.0.0 or sit behind NAT, so name the
                // advertised address
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: public, contents });
                if let Some(p) = peers.iter_mut().find(|p| p.rtc.accepts(&input)) {
                    if let Err(e) = p.rtc.handle_input(input) {
                        debug!(conn = p.conn_id, "rtc input: {e:?}");
                        p.rtc.disconnect();
                    }
                }
            }
            c = rx.recv() => match c {
                None => return,
                Some(Cmd::Offer { conn_id, sdp, stats, inbound, reply }) => {
                    peers.retain(|p| p.conn_id != conn_id);
                    let r = accept(public, &sdp).map(|(rtc, answer)| {
                        peers.push(Peer { conn_id, rtc, channel: None, stats, inbound, created: Instant::now() });
                        answer
                    });
                    let _ = reply.send(r);
                }
                Some(Cmd::Send { conn_id, data }) => {
                    if let Some(p) = peers.iter_mut().find(|p| p.conn_id == conn_id) {
                        p.send(&data);
                    }
                }
                Some(Cmd::Close { conn_id }) => peers.retain(|p| p.conn_id != conn_id),
            },
            _ = tokio::time::sleep_until(wake.into()) => {}
        }
        let now = Instant::now();
        for p in &mut peers {
            if p.rtc.is_alive() && p.rtc.handle_input(Input::Timeout(now)).is_err() {
                p.rtc.disconnect();
            }
        }
    }
}
