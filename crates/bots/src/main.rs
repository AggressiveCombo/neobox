//! Headless neobox players for load and soak tests.
//!
//! ```sh
//! neobox-bots ws://127.0.0.1:8080/ws 32 120
//! ```
//!
//! Connects `players` bots (default 8) to one new room, starts a match
//! (again whenever one ends) and plays with random inputs for `seconds`
//! (default 60), running the same prediction/rollback session as the
//! browser. Prints per-bot statistics summed over all matches and exits
//! non-zero if any bot desynchronised or lost its connection.
//!
//! All bots connect from one address: start the server with
//! `NEOBOX_MAX_CONNS_PER_IP` of at least `players`.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use neobox_net::*;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Default)]
struct Report {
    name: String,
    ticks: u32,
    rollbacks: u64,
    resimulated: u64,
    resyncs: u32,
    rtt_ms: f64,
    max_prediction: u32,
    matches: u32,
    error: Option<String>,
}

/// Adds a finished (or replaced) session's statistics; `base` is the tick it started from.
fn fold(report: &mut Report, session: Option<ClientSession>, base: u32) {
    if let Some(s) = session {
        report.ticks += s.known.saturating_sub(base);
        report.rollbacks += s.rollbacks;
        report.resimulated += s.resimulated;
    }
}

async fn bot(url: String, index: usize, room: mpsc::UnboundedSender<String>, mut room_code: Option<mpsc::UnboundedReceiver<String>>, players: usize, seconds: u64) -> Report {
    let name = format!("bot{index}");
    let mut report = Report { name: name.clone(), ..Report::default() };
    if let Err(e) = play(&url, index, &name, room, room_code.take(), players, seconds, &mut report).await {
        report.error = Some(e);
    }
    report
}

#[allow(clippy::too_many_arguments)]
async fn play(
    url: &str,
    index: usize,
    name: &str,
    room_tx: mpsc::UnboundedSender<String>,
    room_rx: Option<mpsc::UnboundedReceiver<String>>,
    players: usize,
    seconds: u64,
    report: &mut Report,
) -> Result<(), String> {
    let (ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| format!("connect: {e}"))?;
    let (mut tx, mut rx) = ws.split();
    let send_json = |m: &ClientMsg| Message::Text(serde_json::to_string(m).unwrap().into());
    tx.send(send_json(&ClientMsg::Hello { version: PROTOCOL_VERSION, name: name.to_string(), color: None, ticket: None })).await.map_err(|e| e.to_string())?;
    let host = index == 0;
    if host {
        tx.send(send_json(&ClientMsg::CreateRoom { name: "bots".into(), password: None, max_players: players as u8, public: false }))
            .await
            .map_err(|e| e.to_string())?;
    } else {
        let mut rx_code = room_rx.ok_or("no room channel")?;
        let code = rx_code.recv().await.ok_or("no room code")?;
        tx.send(send_json(&ClientMsg::JoinRoom { room: code, password: None, resume: None })).await.map_err(|e| e.to_string())?;
    }

    let mut session: Option<ClientSession> = None;
    let mut session_base = 0u32;
    let mut clock: Option<TickClock> = None;
    let mut started = false;
    let mut rng = 0x9e3779b97f4a7c15u64 ^ (index as u64 + 1) * 0x2545f4914f6cdd1d;
    let mut mask = 0u8;
    let mut last = Instant::now();
    let mut last_ping = Instant::now();
    let begin = Instant::now();
    let deadline = begin + Duration::from_secs(seconds + 20);
    let mut frame = tokio::time::interval(Duration::from_millis(16));
    let mut last_sent_tick = 0u32;
    let mut sent_seq = 0u32;
    let mut rtt = 0.0f64;

    while Instant::now() < deadline {
        tokio::select! {
            m = rx.next() => {
                let Some(Ok(m)) = m else { return Err("connection closed".into()) };
                match m {
                    Message::Text(t) => {
                        let Ok(msg) = serde_json::from_str::<ServerMsg>(&t) else { continue };
                        match msg {
                            ServerMsg::Room { room } => {
                                if host && !started {
                                    let _ = room_tx.send(room.code.clone());
                                    if room.players.len() >= players {
                                        started = true;
                                        tx.send(send_json(&ClientMsg::Start)).await.map_err(|e| e.to_string())?;
                                    }
                                }
                            }
                            ServerMsg::MatchStart { start, you } => {
                                let hz = start.tick_hz;
                                let s = ClientSession::new(start, you).map_err(|e| e.to_string())?;
                                clock = Some(TickClock::new(hz, s.head() as f64, rtt / 2000.0 * hz + 2.0));
                                fold(report, session.replace(s), session_base);
                                session_base = session.as_ref().map_or(0, |s| s.known);
                                last = Instant::now();
                            }
                            ServerMsg::Snapshot { start, tick, state, you, held } => {
                                let bytes = base64::engine::general_purpose::STANDARD.decode(state).map_err(|e| e.to_string())?;
                                let hz = start.tick_hz;
                                let mut s = ClientSession::from_snapshot(start, you, tick, &bytes, &held).map_err(|e| e.to_string())?;
                                if let Some(old) = &session {
                                    s.continue_input_seq(old.last_input_seq() + 1);
                                }
                                clock = Some(TickClock::new(hz, s.head() as f64, rtt / 2000.0 * hz + 2.0));
                                fold(report, session.replace(s), session_base);
                                session_base = tick;
                                report.resyncs += 1;
                            }
                            ServerMsg::MatchEnd { .. } => {
                                fold(report, session.take(), session_base);
                                clock = None;
                                report.matches += 1;
                                // the host keeps the room playing for the whole soak
                                if host && begin.elapsed() < Duration::from_secs(seconds) {
                                    tx.send(send_json(&ClientMsg::Start)).await.map_err(|e| e.to_string())?;
                                }
                            }
                            ServerMsg::Error { code, message } => return Err(format!("{code}: {message}")),
                            ServerMsg::Kicked { reason } => return Err(format!("kicked: {reason}")),
                            _ => {}
                        }
                    }
                    Message::Binary(b) => match ServerFrame::decode(&b) {
                        Ok(ServerFrame::Batch { ticks, input_ack, margin16, margin_frame }) => {
                            if let (Some(s), Some(c)) = (session.as_mut(), clock.as_mut()) {
                                s.on_ticks(&ticks);
                                s.input_ack(input_ack);
                                c.on_margin(margin_frame, margin16 as f64 / 16.0);
                                if s.desync.is_some() {
                                    s.desync = None;
                                    tx.send(send_json(&ClientMsg::Resync)).await.map_err(|e| e.to_string())?;
                                }
                            }
                        }
                        Ok(ServerFrame::Checksum { tick, hash }) => {
                            if let Some(s) = session.as_mut() {
                                s.on_checksum(tick, hash);
                            }
                        }
                        Ok(ServerFrame::Hint { .. }) => {}
                        Ok(ServerFrame::Pong { client_time, .. }) => {
                            let now = begin.elapsed().as_secs_f64() * 1000.0;
                            let sample = now - client_time;
                            rtt = if rtt == 0.0 { sample } else { rtt * 0.8 + sample * 0.2 };
                        }
                        Err(_) => return Err("bad server frame".into()),
                    },
                    _ => {}
                }
            }
            _ = frame.tick() => {
                let now = Instant::now();
                let dt = (now - last).as_secs_f64();
                last = now;
                if last_ping.elapsed() >= Duration::from_secs(1) {
                    last_ping = now;
                    let t = begin.elapsed().as_secs_f64() * 1000.0;
                    tx.send(Message::Binary(ClientFrame::Ping { client_time: t }.encode().into())).await.map_err(|e| e.to_string())?;
                }
                if begin.elapsed() > Duration::from_secs(seconds) {
                    break;
                }
                let (Some(s), Some(c)) = (session.as_mut(), clock.as_mut()) else { continue };
                let target = c.update(dt, s.known as f64).floor().max(0.0) as u32;
                // change input every ~10 frames
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                if rng % 10 == 0 {
                    mask = (rng >> 8) as u8;
                }
                let head = s.head();
                s.local_input(head.max(target), mask);
                s.advance_to(target);
                report.max_prediction = report.max_prediction.max(s.head().saturating_sub(s.known));
                let new_head = s.head();
                if new_head >= last_sent_tick || s.last_input_seq() != sent_seq {
                    let bytes = ClientFrame::Input(s.input_frame(new_head, 32, c.next_frame())).encode();
                    tx.send(Message::Binary(bytes.into())).await.map_err(|e| e.to_string())?;
                    last_sent_tick = new_head + 1;
                    sent_seq = s.last_input_seq();
                }
            }
        }
    }
    fold(report, session.take(), session_base);
    report.rtt_ms = rtt;
    let _ = tx.send(Message::Close(None)).await;
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let url = args.get(1).cloned().unwrap_or_else(|| "ws://127.0.0.1:8080/ws".into());
    let players: usize = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(8).clamp(1, MAX_ROOM_PLAYERS as usize);
    let seconds: u64 = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(60);

    // the host bot publishes the room code to the others
    let (code_tx, mut code_rx) = mpsc::unbounded_channel::<String>();
    let mut joiners = Vec::new();
    for _ in 1..players {
        let (tx, rx) = mpsc::unbounded_channel();
        joiners.push((tx, Some(rx)));
    }
    let fanout = tokio::spawn({
        let senders: Vec<_> = joiners.iter().map(|j| j.0.clone()).collect();
        async move {
            if let Some(code) = code_rx.recv().await {
                for s in senders {
                    let _ = s.send(code.clone());
                }
            }
        }
    });
    let mut tasks = vec![tokio::spawn(bot(url.clone(), 0, code_tx, None, players, seconds))];
    for (i, (_, rx)) in joiners.iter_mut().enumerate() {
        let (dummy, _) = mpsc::unbounded_channel();
        tasks.push(tokio::spawn(bot(url.clone(), i + 1, dummy, rx.take(), players, seconds)));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut failed = 0;
    println!("{:<6} {:>7} {:>7} {:>9} {:>11} {:>7} {:>7} {:>8}", "bot", "matches", "ticks", "rollbacks", "resimulated", "resyncs", "rtt ms", "max pred");
    for t in tasks {
        let r = t.await.expect("bot task");
        println!(
            "{:<6} {:>7} {:>7} {:>9} {:>11} {:>7} {:>7.1} {:>8}{}",
            r.name,
            r.matches,
            r.ticks,
            r.rollbacks,
            r.resimulated,
            r.resyncs,
            r.rtt_ms,
            r.max_prediction,
            r.error.as_ref().map(|e| format!("  ERROR {e}")).unwrap_or_default()
        );
        if r.error.is_some() || r.resyncs > 0 {
            failed += 1;
        }
    }
    fanout.abort();
    if failed > 0 {
        eprintln!("{failed} bot(s) failed or desynchronised");
        std::process::exit(1);
    }
}
