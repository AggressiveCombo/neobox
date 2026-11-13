//! neobox browser module (see docs/CLIENT-API.md): owns the client match
//! session (prediction + rollback), the tick clock, input latching and the
//! per-frame render buffer.

pub mod frame;

use frame::{FrameBuilder, Meta, SoundOut};
use neobox_net::{ClientFrame, ClientSession, MatchStart, ServerFrame, TickClock};
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
    latch: u8,
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
        match ClientSession::new(start, local) {
            Ok(s) => {
                begin(a, s, now_ms);
                0
            }
            Err(e) => fail(a, e),
        }
    })
}

/// # Safety
/// The pointer/length pairs must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_match_snapshot(json: u32, json_len: u32, local: i32, tick: u32, snap: u32, snap_len: u32, now_ms: f64) -> i32 {
    let text = unsafe { bytes(json, json_len) };
    let snap = unsafe { bytes(snap, snap_len) };
    with(|a| {
        let start: MatchStart = match serde_json::from_slice(text) {
            Ok(s) => s,
            Err(e) => return fail(a, e),
        };
        let local = (local >= 0).then_some(local as u32);
        match ClientSession::from_snapshot(start, local, tick, snap) {
            Ok(s) => {
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
        a.latch |= mask & !a.last_mask;
        a.last_mask = mask;
        let (Some(s), Some(clock)) = (a.session.as_mut(), a.clock.as_mut()) else {
            a.frame.words.clear();
            return 0;
        };
        let tick_f = clock.update(dt);
        let target = tick_f.floor().max(0.0) as u32;
        let head = s.head();
        if target > head {
            // a key tapped and released between ticks still counts for one tick
            let tapped = a.latch & !mask;
            if tapped != 0 {
                s.local_input(head, mask | a.latch);
                s.local_input(head + 1, mask);
            } else {
                s.local_input(head, mask);
            }
            a.latch = 0;
        } else {
            s.local_input(head.max(target), mask | a.latch);
        }
        let rb_before = s.rollbacks;
        s.advance_to(target);
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
        // render one tick behind the clock: between head-1 and head
        let alpha = (tick_f - new_head as f64).clamp(0.0, 1.0);
        let meta = Meta {
            tick: new_head,
            local: s.local.map_or(-1, |l| l as i32),
            prediction: (new_head.saturating_sub(s.known)) as f32,
            rollbacks_per_s: a.rollback_rate,
        };
        a.frame.build(prev, cur, alpha, &s.start.settings, meta, &a.sounds);
        // send once per simulated tick (heartbeat + unacknowledged changes),
        // and immediately when the input changed
        let newest = s.last_input_seq();
        if new_head >= a.last_sent || newest != a.sent_seq {
            a.out = ClientFrame::Input(s.input_frame(new_head, MAX_RESEND)).encode();
            a.last_sent = a.last_sent.max(new_head + 1);
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
