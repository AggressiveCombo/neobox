//! neobox browser module (see docs/CLIENT-API.md): owns the client match
//! session (prediction + rollback), the tick clock, input latching and the
//! per-frame render buffer. Besides online matches it records replays of
//! them, plays replays back, and runs offline local games (practice and
//! editor test-play) on the same simulation.

pub mod frame;

use frame::{FrameBuilder, Meta, SoundOut};
use neobox_net::{ClientFrame, ClientSession, InputFrame, MatchStart, Replay, ReplayPlayer, ReplayRecorder, ServerFrame, ServerMatch, TickClock};
use neobox_sim::start::Outcome;
use neobox_sim::{GameSettings, MapData, State};
use std::cell::RefCell;

/// Most unacknowledged input changes sent per packet (the rest follow in
/// later packets, oldest first, so none is ever skipped).
const MAX_RESEND: usize = 32;

#[derive(Default)]
struct App {
    session: Option<ClientSession>,
    clock: Option<TickClock>,
    frame: FrameBuilder,
    out: Vec<u8>,
    err: String,
    last_now: f64,
    last_mask: u8,
    /// keys pressed during the tick in progress (a tap shorter than a tick
    /// still counts for that tick)
    latch: u8,
    /// the tick in progress: the one the local input currently applies to
    input_tick: u32,
    last_sent: u32,
    sent_seq: u32,
    /// first input sequence number of the next session
    next_seq: u32,
    sound_tick: u32,
    sounds: Vec<SoundOut>,
    rtt_ms: f64,
    rtt_jitter: f64,
    rollback_window: (f64, u64),
    rollback_rate: f32,
    /// recording of the current (or last) online match
    recorder: Option<ReplayRecorder>,
    /// replay being watched
    replay: Option<ReplayPlayer>,
    replay_sound_tick: u32,
    /// offline local game
    local: Option<LocalGame>,
}

/// An offline game: the authoritative match runs right here, with the
/// local player's input applied directly.
struct LocalGame {
    m: ServerMatch,
    prev: State,
    player: u32,
    /// fraction of the next tick elapsed
    acc: f64,
    seq: u32,
    /// keys pressed since the last simulated tick
    latch: u8,
    last_mask: u8,
    applied: u8,
}

thread_local! {
    static APP: RefCell<App> = RefCell::new(App::default());
}

fn with<R>(f: impl FnOnce(&mut App) -> R) -> R {
    APP.with(|a| f(&mut a.borrow_mut()))
}

/// # Safety
/// `ptr` must come from `nb_alloc` with at least `len` bytes.
unsafe fn bytes<'a>(ptr: u32, len: u32) -> &'a [u8] {
    if len == 0 {
        return &[];
    }
    unsafe { std::slice::from_raw_parts(ptr as usize as *const u8, len as usize) }
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_alloc(len: u32) -> u32 {
    let mut v = vec![0u8; len.max(1) as usize];
    let p = v.as_mut_ptr() as usize as u32;
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must be a pair returned by `nb_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_free(ptr: u32, len: u32) {
    if ptr != 0 {
        unsafe { drop(Vec::from_raw_parts(ptr as usize as *mut u8, len.max(1) as usize, len.max(1) as usize)) };
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_error_ptr() -> u32 {
    with(|a| a.err.as_ptr() as usize as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_error_len() -> u32 {
    with(|a| a.err.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_out_ptr() -> u32 {
    with(|a| a.out.as_ptr() as usize as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_frame_ptr() -> u32 {
    with(|a| a.frame.words.as_ptr() as usize as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_frame_len() -> u32 {
    with(|a| (a.frame.words.len() * 4) as u32)
}

fn fail(a: &mut App, msg: impl ToString) -> i32 {
    a.err = msg.to_string();
    -1
}

fn begin(a: &mut App, mut session: ClientSession, now_ms: f64) {
    // sequence numbers keep increasing for the whole connection, so input
    // still in flight from a replaced session can never shadow new input
    if let Some(old) = a.session.take() {
        a.next_seq = old.last_input_seq() + 1;
    }
    session.continue_input_seq(a.next_seq);
    let hz = session.start.tick_hz;
    let tick = session.head() as f64;
    // start ahead of the server by half a round trip plus a small margin
    let lead = (a.rtt_ms / 2000.0) * hz + 2.0;
    let mut clock = TickClock::new(hz, tick, lead);
    clock.target_margin = target_margin(a.rtt_jitter, hz);
    a.clock = Some(clock);
    a.sound_tick = session.head();
    a.last_sent = 0;
    a.sent_seq = 0;
    a.last_now = now_ms;
    a.latch = 0;
    a.input_tick = session.head();
    a.session = Some(session);
}

fn target_margin(jitter_ms: f64, hz: f64) -> f64 {
    (1.0 + 2.0 * jitter_ms / 1000.0 * hz).clamp(1.0, 6.0)
}

/// # Safety
/// `json`/`json_len` must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_match_start(json: u32, json_len: u32, local: i32, now_ms: f64) -> i32 {
    let text = unsafe { bytes(json, json_len) };
    with(|a| {
        let start: MatchStart = match serde_json::from_slice(text) {
            Ok(s) => s,
            Err(e) => return fail(a, e),
        };
        let local = (local >= 0).then_some(local as u32);
        match ClientSession::new(start.clone(), local) {
            Ok(s) => {
                a.recorder = Some(ReplayRecorder::new(start, None));
                begin(a, s, now_ms);
                0
            }
            Err(e) => fail(a, e),
        }
    })
}

/// # Safety
/// The pointer/length pairs must describe readable memory. `held` is the
/// snapshot message's `held` array as JSON (`[[player, mask], ...]`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_match_snapshot(json: u32, json_len: u32, held: u32, held_len: u32, local: i32, tick: u32, snap: u32, snap_len: u32, now_ms: f64) -> i32 {
    let text = unsafe { bytes(json, json_len) };
    let held = unsafe { bytes(held, held_len) };
    let snap = unsafe { bytes(snap, snap_len) };
    with(|a| {
        let start: MatchStart = match serde_json::from_slice(text) {
            Ok(s) => s,
            Err(e) => return fail(a, e),
        };
        let held: Vec<(u32, u8)> = match serde_json::from_slice(held) {
            Ok(h) => h,
            Err(e) => return fail(a, e),
        };
        let local = (local >= 0).then_some(local as u32);
        match ClientSession::from_snapshot(start.clone(), local, tick, snap, &held) {
            Ok(s) => {
                // a resync snapshot within the recorded match keeps the
                // recording (confirmed ticks continue); otherwise it starts here
                let keep = a.recorder.as_ref().is_some_and(|r| *r.start() == start && r.next_tick() >= tick);
                if !keep {
                    a.recorder = Some(ReplayRecorder::new(start, Some((tick, snap.to_vec(), held))));
                }
                begin(a, s, now_ms);
                0
            }
            Err(e) => fail(a, e),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_match_end() {
    with(|a| {
        if let Some(s) = a.session.take() {
            a.next_seq = s.last_input_seq() + 1;
        }
        a.clock = None;
    })
}

/// # Safety
/// `ptr`/`len` must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_server_frame(ptr: u32, len: u32) -> i32 {
    let b = unsafe { bytes(ptr, len) };
    with(|a| {
        let Ok(f) = ServerFrame::decode(b) else { return fail(a, "bad server frame") };
        match f {
            ServerFrame::Batch { ticks, input_ack, margin16 } => {
                if let Some(s) = a.session.as_mut() {
                    s.on_ticks(&ticks);
                    if let Some(r) = a.recorder.as_mut() {
                        r.push(&ticks);
                    }
                    s.input_ack(input_ack);
                    if let Some(c) = a.clock.as_mut() {
                        c.on_margin(margin16 as f64 / 16.0);
                    }
                    return s.desynced as i32;
                }
                0
            }
            ServerFrame::Checksum { tick, hash } => {
                if let Some(s) = a.session.as_mut() {
                    s.on_checksum(tick, hash);
                    return s.desynced as i32;
                }
                0
            }
            ServerFrame::Pong { client_time, .. } => {
                let rtt = (a.last_now - client_time).max(0.0);
                if a.rtt_ms == 0.0 {
                    a.rtt_ms = rtt;
                } else {
                    a.rtt_jitter += ((rtt - a.rtt_ms).abs() - a.rtt_jitter) * 0.2;
                    a.rtt_ms += (rtt - a.rtt_ms) * 0.2;
                }
                if let (Some(c), Some(s)) = (a.clock.as_mut(), a.session.as_ref()) {
                    c.target_margin = target_margin(a.rtt_jitter, s.start.tick_hz);
                }
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_ping(now_ms: f64) -> u32 {
    with(|a| {
        a.last_now = a.last_now.max(now_ms);
        a.out = ClientFrame::Ping { client_time: now_ms }.encode();
        a.out.len() as u32
    })
}

/// Round-trip time estimate in milliseconds.
#[unsafe(no_mangle)]
pub extern "C" fn nb_rtt() -> f64 {
    with(|a| a.rtt_ms)
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_frame(now_ms: f64, mask: u32) -> u32 {
    with(|a| {
        let mask = mask as u8;
        let dt = ((now_ms - a.last_now) / 1000.0).max(0.0);
        a.last_now = now_ms;
        let pressed = mask & !a.last_mask;
        a.last_mask = mask;
        let (Some(s), Some(clock)) = (a.session.as_mut(), a.clock.as_mut()) else {
            a.frame.words.clear();
            return 0;
        };
        let tick_f = clock.update(dt);
        let target = tick_f.floor().max(0.0) as u32;
        // The input applies to the tick in progress (`target`), whose result
        // (state target+1) is predicted right away and is what the frame
        // interpolates towards: a key press moves the player in the same
        // display frame instead of one tick later. Rollback redoes that one
        // tick when the input changes mid-tick.
        if target > a.input_tick {
            // the finished tick kept its taps; they end with it
            if a.latch & !mask != 0 {
                s.local_input(a.input_tick + 1, mask);
            }
            a.latch = 0;
            a.input_tick = target;
        }
        a.latch |= pressed;
        s.local_input(target, mask | a.latch);
        let rb_before = s.rollbacks;
        s.advance_to(target + 1);
        // rollbacks per second (for the stats overlay)
        a.rollback_window.0 += dt;
        a.rollback_window.1 += s.rollbacks - rb_before;
        if a.rollback_window.0 >= 1.0 {
            a.rollback_rate = (a.rollback_window.1 as f64 / a.rollback_window.0) as f32;
            a.rollback_window = (0.0, 0);
        }
        // sounds of newly reached ticks
        a.sounds.clear();
        let new_head = s.head();
        if new_head > a.sound_tick {
            let (prev, cur) = s.latest_pair();
            frame::new_sounds(prev, cur, &mut a.sounds);
            a.sound_tick = new_head;
        }
        let (prev, cur) = s.latest_pair();
        // between the last finished tick and the one in progress
        let alpha = (tick_f - (new_head as f64 - 1.0)).clamp(0.0, 1.0);
        let meta = Meta {
            tick: new_head,
            local: s.local.map_or(-1, |l| l as i32),
            prediction: (new_head.saturating_sub(s.known)) as f32,
            rollbacks_per_s: a.rollback_rate,
        };
        a.frame.build(prev, cur, alpha, &s.start.settings, meta, &a.sounds);
        // send once per tick (heartbeat + unacknowledged changes) and
        // immediately when the input changed; the heartbeat names the tick in
        // progress, the one new inputs are stamped with
        let newest = s.last_input_seq();
        if target >= a.last_sent || newest != a.sent_seq {
            a.out = ClientFrame::Input(s.input_frame(target, MAX_RESEND)).encode();
            a.last_sent = a.last_sent.max(target + 1);
            a.sent_seq = newest;
            return a.out.len() as u32;
        }
        0
    })
}

/// # Safety
/// `code`/`len` must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_map_preview(code: u32, len: u32) -> i32 {
    let text = unsafe { bytes(code, len) };
    with(|a| {
        let Ok(code) = std::str::from_utf8(text) else { return fail(a, "map code is not text") };
        let map = match MapData::from_code(code.trim()) {
            Ok(m) => m,
            Err(e) => return fail(a, e),
        };
        let state = State::from_map(&map);
        let gs = GameSettings::default();
        a.frame.build(&state, &state, 1.0, &gs, Meta { local: -1, ..Meta::default() }, &[]);
        0
    })
}

/// # Safety
/// `json`/`len` must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_map_encode(json: u32, len: u32) -> i32 {
    let text = unsafe { bytes(json, len) };
    with(|a| {
        let v: serde_json::Value = match serde_json::from_slice(text) {
            Ok(v) => v,
            Err(e) => return fail(a, e),
        };
        match MapData::from_json(&v) {
            Ok(m) => {
                a.out = m.to_code().into_bytes();
                a.out.len() as i32
            }
            Err(e) => fail(a, e),
        }
    })
}

/// # Safety
/// `code`/`len` must describe readable memory.
///
/// Hitbox map code → the map's compact JSON (what the editor edits). The
/// text is at `nb_out_ptr()`, its length returned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_map_decode(code: u32, len: u32) -> i32 {
    let text = unsafe { bytes(code, len) };
    with(|a| {
        let Ok(code) = std::str::from_utf8(text) else { return fail(a, "map code is not text") };
        match MapData::from_code(code.trim()) {
            Ok(m) => {
                a.out = m.to_json().to_string().into_bytes();
                a.out.len() as i32
            }
            Err(e) => fail(a, e),
        }
    })
}

// ------------------------------------------------------------------ replays

/// # Safety
/// `names`/`len` must describe readable memory.
///
/// The recording of the current or last online match as replay JSON at
/// `nb_out_ptr()` (length returned; 0 when nothing was recorded). `names`:
/// JSON `[[player id, name], ...]` stored for display.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_replay_export(names: u32, len: u32) -> i32 {
    let text = unsafe { bytes(names, len) };
    with(|a| {
        let names: Vec<(u32, String)> = match serde_json::from_slice(text) {
            Ok(n) => n,
            Err(e) => return fail(a, e),
        };
        match &a.recorder {
            Some(r) if !r.is_empty() => {
                a.out = r.finish(names).to_json().into_bytes();
                a.out.len() as i32
            }
            _ => 0,
        }
    })
}

/// # Safety
/// `json`/`len` must describe readable memory.
///
/// Load a replay (its JSON, already decompressed) for watching. Summary JSON
/// `{"first","end","hz","names","players"}` at `nb_out_ptr()`, length returned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_replay_load(json: u32, len: u32) -> i32 {
    let text = unsafe { bytes(json, len) };
    with(|a| {
        let replay = match Replay::from_json(text) {
            Ok(r) => r,
            Err(e) => return fail(a, e),
        };
        let player = match ReplayPlayer::new(replay) {
            Ok(p) => p,
            Err(e) => return fail(a, e),
        };
        let info = serde_json::json!({
            "first": player.first_tick(),
            "end": player.end_tick(),
            "hz": player.replay.start.tick_hz,
            "names": player.replay.names,
            "players": player.replay.start.players,
        });
        a.out = info.to_string().into_bytes();
        a.replay_sound_tick = player.tick();
        a.replay = Some(player);
        a.out.len() as i32
    })
}

/// Build the frame of the loaded replay at fractional tick `tick_f`,
/// following player `follow` (-1: none). Seeking anywhere is allowed;
/// sounds play only when playback moves forward one tick at a time.
#[unsafe(no_mangle)]
pub extern "C" fn nb_replay_frame(tick_f: f64, follow: i32) -> i32 {
    with(|a| {
        let Some(p) = a.replay.as_mut() else { return fail(a, "no replay loaded") };
        let first = p.first_tick() as f64;
        let last = p.end_tick() as f64;
        let t = tick_f.clamp(first, last);
        let base = t.floor() as u32;
        // show the step from `base` to `base + 1` (the last state at the end)
        p.seek((base + 1).min(p.end_tick()));
        let alpha = if p.tick() == base + 1 { t - base as f64 } else { 1.0 };
        a.sounds.clear();
        if p.tick() == a.replay_sound_tick + 1 {
            let (prev, cur) = p.states();
            frame::new_sounds(prev, cur, &mut a.sounds);
        }
        a.replay_sound_tick = p.tick();
        let (prev, cur) = p.states();
        let meta = Meta { tick: p.tick(), local: follow, ..Meta::default() };
        a.frame.build(prev, cur, alpha, p.settings(), meta, &a.sounds);
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_replay_close() {
    with(|a| a.replay = None)
}

// ------------------------------------------------------------------ local games

/// # Safety
/// `json`/`len` must describe readable memory.
///
/// Start an offline game from a `MatchStart` (JSON); `player` is the local
/// player's id (one of `start.players`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_local_start(json: u32, len: u32, player: u32) -> i32 {
    let text = unsafe { bytes(json, len) };
    with(|a| {
        let start: MatchStart = match serde_json::from_slice(text) {
            Ok(s) => s,
            Err(e) => return fail(a, e),
        };
        match ServerMatch::new(start) {
            Ok(m) => {
                a.local = Some(LocalGame { prev: m.state.clone(), m, player, acc: 0.0, seq: 0, latch: 0, last_mask: 0, applied: 0 });
                0
            }
            Err(e) => fail(a, e),
        }
    })
}

/// Advance the offline game by the time since the previous call (`dt_ms`,
/// capped at 5 ticks), apply the local input mask, build the frame.
/// Returns 0 while the game runs, 1 once it is over.
#[unsafe(no_mangle)]
pub extern "C" fn nb_local_frame(dt_ms: f64, mask: u32) -> i32 {
    with(|a| {
        let Some(g) = a.local.as_mut() else { return fail(a, "no local game") };
        let mask = mask as u8;
        g.latch |= mask & !g.last_mask;
        g.last_mask = mask;
        let hz = g.m.start.tick_hz;
        g.acc = (g.acc + dt_ms.max(0.0) / 1000.0 * hz).min(5.0);
        a.sounds.clear();
        while g.acc >= 1.0 {
            g.acc -= 1.0;
            // a key tapped between two ticks still counts for one tick
            let effective = mask | g.latch;
            g.latch = 0;
            if effective != g.applied {
                g.seq += 1;
                let tick = g.m.tick;
                g.m.submit(g.player, &InputFrame { ack: 0, now: tick, changes: vec![(g.seq, tick, effective)] });
                g.applied = effective;
            }
            g.prev = g.m.state.clone();
            g.m.step();
            frame::new_sounds(&g.prev, &g.m.state, &mut a.sounds);
        }
        let meta = Meta { tick: g.m.tick, local: g.player as i32, ..Meta::default() };
        a.frame.build(&g.prev, &g.m.state, g.acc, &g.m.start.settings, meta, &a.sounds);
        (g.m.last_outcome == Outcome::MatchOver) as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_local_end() {
    with(|a| a.local = None)
}
