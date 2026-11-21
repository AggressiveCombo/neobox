//! neobox browser module (see docs/CLIENT-API.md): owns the client match
//! session (prediction + rollback), the tick clock, input latching and the
//! per-frame render buffer. Besides online matches it records replays of
//! them, plays replays back, and runs offline local games (practice and
//! editor test-play) on the same simulation.

pub mod frame;

use frame::{Feed, FrameBuilder, Meta, PlayerColours};
use neobox_net::{ClientFrame, ClientSession, Desync, InputFrame, MatchStart, Replay, ReplayPlayer, ReplayRecorder, RttTracker, ServerFrame, ServerMatch, TickClock};
use neobox_sim::start::Outcome;
use neobox_sim::{GameSettings, MapData, State};
use neobox_sim::input::LEFT;
use std::cell::RefCell;

/// Match time (ms) whose rollback depths are left out: the tick clock is still settling.
const DEPTH_WARMUP_MS: f64 = 3000.0;

/// Feed silence (ms since the last server batch) after which prediction may run the outage
/// distance past the confirmed tick (see `ClientSession::set_feed_silent`).
const FEED_SILENT_MS: f64 = 50.0;

/// Most unacknowledged input changes sent per packet (the rest follow in
/// later packets, oldest first, so none is ever skipped).
const MAX_RESEND: usize = 32;

/// Most ticks a replay frame steps through to collect their events; a longer jump is a seek.
const REPLAY_FEED_TICKS: u32 = 60;

/// `nb_replay_frame` result when the seek needs keyframes that are not built yet (nothing changes then).
const REPLAY_PENDING: i32 = -2;

/// Prediction stalls since the warm-up ended: frames the cap held the local head back, and the
/// longest run of such frames in ms (from the frame gaps).
#[derive(Default)]
struct StallStats {
    frames: u32,
    runs: u32,
    in_run: bool,
    run_ms: f64,
    longest_ms: f64,
    total: u32,
}

#[derive(Default)]
struct App {
    session: Option<ClientSession>,
    clock: Option<TickClock>,
    frame: FrameBuilder,
    out: Vec<u8>,
    err: String,
    last_now: f64,
    /// match time of the last server batch (the feed's age sets prediction while it is silent)
    last_feed_ms: f64,
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
    /// events of the ticks reached since the last frame
    feed: Feed,
    /// round-trip estimate of the link, kept across matches
    rtt: RttTracker,
    /// match time whose rollback depths are not counted yet
    warm_ms: Option<f64>,
    rollback_window: (f64, u64),
    rollback_rate: f32,
    /// prediction cap for new sessions (0: the net crate's default)
    cap: u32,
    stall: StallStats,
    /// per-frame trace rows (see `nb_trace`), kept while tracing
    trace_on: bool,
    trace: Vec<f32>,
    /// recording of the current (or last) online match
    recorder: Option<ReplayRecorder>,
    /// replay being watched
    replay: Option<ReplayPlayer>,
    replay_feed_tick: u32,
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
    dummies: Vec<Dummy>,
}

/// A scripted player in an offline game (a training dummy): its input comes
/// from `mode` each tick instead of from the local player.
struct Dummy {
    id: u32,
    mode: DummyMode,
    /// the mask last submitted for it
    applied: u8,
}

#[derive(Clone, Copy)]
enum DummyMode {
    /// Stands still.
    Idle,
    /// Holds Left on even ticks and lets go on odd ones.
    LeftEven,
}

impl DummyMode {
    fn mask(self, tick: u32) -> u8 {
        match self {
            DummyMode::Idle => 0,
            DummyMode::LeftEven => {
                if tick % 2 == 0 {
                    LEFT
                } else {
                    0
                }
            }
        }
    }
}

/// The scripted players of a start JSON: `dummies: [{id, mode}]`, `mode`
/// being "idle" or "left_even". Absent: none.
fn parse_dummies(v: &serde_json::Value) -> Result<Vec<Dummy>, String> {
    let Some(list) = v.get("dummies") else { return Ok(Vec::new()) };
    let list = list.as_array().ok_or("dummies must be a list")?;
    list.iter()
        .map(|d| {
            let id = d["id"].as_u64().ok_or("dummy id must be a number")? as u32;
            let mode = match d["mode"].as_str() {
                Some("idle") => DummyMode::Idle,
                Some("left_even") => DummyMode::LeftEven,
                _ => return Err("dummy mode must be idle or left_even".to_string()),
            };
            Ok(Dummy { id, mode, applied: 0 })
        })
        .collect()
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
    let lead = (a.rtt.rtt().unwrap_or(0.0) / 2000.0) * hz + 2.0;
    a.clock = Some(TickClock::new(hz, tick, lead));
    a.warm_ms = Some(0.0);
    session.attach_feed();
    a.last_sent = 0;
    a.sent_seq = 0;
    a.last_now = now_ms;
    a.last_feed_ms = now_ms;
    a.latch = 0;
    a.input_tick = session.head();
    if a.cap > 0 {
        session.set_prediction_cap(a.cap);
    }
    a.stall = StallStats::default();
    a.trace.clear();
    a.session = Some(session);
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
/// `ptr`/`len` must describe readable memory. `now_ms` is the receipt time on
/// the same clock the pings are stamped with (`performance.now()`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_server_frame(ptr: u32, len: u32, now_ms: f64) -> i32 {
    let b = unsafe { bytes(ptr, len) };
    with(|a| {
        let Ok(f) = ServerFrame::decode(b) else { return fail(a, "bad server frame") };
        match f {
            ServerFrame::Batch { ticks, input_ack, margin16, margin_frame } => {
                a.last_feed_ms = now_ms;
                if let Some(s) = a.session.as_mut() {
                    let was = s.desync.is_some();
                    s.on_ticks(&ticks);
                    if let Some(r) = a.recorder.as_mut() {
                        r.push(&ticks);
                        r.capture(s.base, s.confirmed_state());
                    }
                    s.input_ack(input_ack);
                    if let Some(c) = a.clock.as_mut() {
                        c.on_margin(margin_frame, margin16 as f64 / 16.0);
                    }
                    return (!was && s.desync.is_some()) as i32;
                }
                0
            }
            ServerFrame::Hint { player, tick, mask } => {
                if let Some(s) = a.session.as_mut() {
                    s.on_hint(player, tick, mask);
                }
                0
            }
            ServerFrame::Checksum { tick, hash } => {
                if let Some(s) = a.session.as_mut() {
                    let was = s.desync.is_some();
                    s.on_checksum(tick, hash);
                    return (!was && s.desync.is_some()) as i32;
                }
                0
            }
            ServerFrame::Pong { client_time, .. } => {
                let rtt = (now_ms - client_time).max(0.0);
                a.rtt.sample(rtt);
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_ping(now_ms: f64) -> u32 {
    with(|a| {
        a.out = ClientFrame::Ping { client_time: now_ms }.encode();
        a.out.len() as u32
    })
}

/// Netcode stats of the current session, written to the out buffer as four
/// little-endian u32: desync kind (0 none, 1 gap, 2 hash), the expected tick
/// (gap) or mismatch tick (hash), the tick received (gap), and the p95
/// rollback depth in ticks. Returns the byte count, 0 without a session.
#[unsafe(no_mangle)]
pub extern "C" fn nb_net_stats() -> i32 {
    with(|a| {
        let Some(s) = a.session.as_ref() else { return 0 };
        let (kind, x, y) = match s.desync {
            None => (0, 0, 0),
            Some(Desync::Gap { expected, got }) => (1, expected, got),
            Some(Desync::Hash { tick }) => (2, tick, 0),
        };
        a.out.clear();
        for w in [kind, x, y, s.rollback_depth_pct(95)] {
            a.out.extend_from_slice(&w.to_le_bytes());
        }
        a.out.len() as i32
    })
}

/// Rollback depth histogram of the current session: little-endian u64 counts, bin i for depth i ticks
/// (the last bin holds deeper rollbacks). Returns the byte count, 0 without a session.
#[unsafe(no_mangle)]
pub extern "C" fn nb_rollback_hist() -> i32 {
    with(|a| {
        let Some(s) = a.session.as_ref() else { return 0 };
        a.out.clear();
        for &n in s.rollback_hist() {
            a.out.extend_from_slice(&n.to_le_bytes());
        }
        a.out.len() as i32
    })
}

/// Client state hashes: per logged confirmed tick (every `CLIENT_HASH_INTERVAL`), the tick as a
/// little-endian u32 then its hash as a little-endian u64. Returns the byte count, 0 without a session.
#[unsafe(no_mangle)]
pub extern "C" fn nb_hash_log() -> i32 {
    with(|a| {
        let Some(s) = a.session.as_ref() else { return 0 };
        a.out.clear();
        for &(t, h) in s.client_hashes() {
            a.out.extend_from_slice(&t.to_le_bytes());
            a.out.extend_from_slice(&h.to_le_bytes());
        }
        a.out.len() as i32
    })
}

/// Sets the prediction cap (ticks) of the current session and of the ones that follow; 0 keeps the net crate's default.
#[unsafe(no_mangle)]
pub extern "C" fn nb_set_cap(cap: u32) {
    with(|a| {
        a.cap = cap;
        if let Some(s) = a.session.as_mut() {
            if cap > 0 {
                s.set_prediction_cap(cap);
            }
        }
    })
}

/// Local-player correction histogram since the warm-up: bin i counts remote rollbacks that moved the
/// local player by i/2 to (i+1)/2 world units; the last bin holds 32 units and more. Little-endian u64s.
/// Returns the byte count, 0 without a session.
#[unsafe(no_mangle)]
pub extern "C" fn nb_corr_hist() -> i32 {
    with(|a| {
        let Some(s) = a.session.as_ref() else { return 0 };
        a.out.clear();
        for &n in s.correction_hist() {
            a.out.extend_from_slice(&n.to_le_bytes());
        }
        a.out.len() as i32
    })
}

/// Prediction stalls since the warm-up and the clock's counters, as little-endian u32s: stall frames,
/// stall runs, longest run (ms), frames counted, margins counted, stale margins, stale margins more than
/// 8 ticks off target, clock corrections, gap resets; then the largest local correction (f32 world units).
/// Returns the byte count, 0 without a session.
#[unsafe(no_mangle)]
pub extern "C" fn nb_stall_stats() -> i32 {
    with(|a| {
        let (Some(s), Some(c)) = (a.session.as_ref(), a.clock.as_ref()) else { return 0 };
        let cs = c.stats();
        let st = &a.stall;
        let words = [st.frames, st.runs, st.longest_ms.round() as u32, st.total, cs.margins as u32, cs.stale as u32, cs.stale_big as u32, cs.corrections as u32, cs.gap_resets as u32];
        a.out.clear();
        for w in words {
            a.out.extend_from_slice(&w.to_le_bytes());
        }
        a.out.extend_from_slice(&(s.correction_max() as f32).to_le_bytes());
        a.out.len() as i32
    })
}

/// Starts (non-zero) or stops per-frame tracing; starting clears the trace.
#[unsafe(no_mangle)]
pub extern "C" fn nb_set_trace(on: u32) {
    with(|a| {
        a.trace_on = on != 0;
        a.trace.clear();
    })
}

/// Player colours the frames are drawn with: `len` bytes of little-endian words (see `PlayerColours::from_words`).
/// # Safety
/// `ptr` must come from `nb_alloc` with at least `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_set_colours(ptr: u32, len: u32) -> i32 {
    if len % 4 != 0 {
        return with(|a| fail(a, "player colours are not whole words"));
    }
    let raw = unsafe { bytes(ptr, len) };
    let words: Vec<u32> = raw.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    with(|a| match PlayerColours::from_words(&words) {
        Some(colours) => {
            a.frame.set_colours(colours);
            0
        }
        None => fail(a, "malformed player colours"),
    })
}

/// Trace rows since the last call, 8 little-endian f32 per frame: frame dt (ms), target lead (ticks,
/// fractional tick minus the confirmed tick), prediction (head minus confirmed), clock margin, target
/// margin, stalled (0/1), rollbacks in the frame, depth of the latest rollback. Returns the byte count.
#[unsafe(no_mangle)]
pub extern "C" fn nb_trace() -> i32 {
    with(|a| {
        a.out.clear();
        for w in a.trace.drain(..) {
            a.out.extend_from_slice(&w.to_le_bytes());
        }
        a.out.len() as i32
    })
}

/// Resets the stall and clock counters for the play window (the trace and the depth counters keep theirs).
#[unsafe(no_mangle)]
pub extern "C" fn nb_reset_stall() {
    with(|a| {
        a.stall = StallStats::default();
        if let Some(c) = a.clock.as_mut() {
            c.reset_stats();
        }
    })
}

/// Round-trip time estimate in milliseconds; -1 until the first pong.
#[unsafe(no_mangle)]
pub extern "C" fn nb_rtt() -> f64 {
    with(|a| a.rtt.rtt().unwrap_or(-1.0))
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_frame(now_ms: f64, mask: u32) -> u32 {
    with(|a| {
        let mask = mask as u8;
        // the raw gap: a negative or huge one is a clock step, which the clock resyncs on
        let dt = (now_ms - a.last_now) / 1000.0;
        a.last_now = now_ms;
        let pressed = mask & !a.last_mask;
        a.last_mask = mask;
        let (Some(s), Some(clock)) = (a.session.as_mut(), a.clock.as_mut()) else {
            a.frame.words.clear();
            return 0;
        };
        if let Some(w) = a.warm_ms.as_mut() {
            *w += dt.max(0.0) * 1000.0;
            if *w >= DEPTH_WARMUP_MS {
                a.warm_ms = None;
                s.reset_depth_stats();
                clock.reset_stats();
                a.stall = StallStats::default();
            }
        }
        let tick_f = clock.update(dt, s.known as f64);
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
        let feed_age = now_ms - a.last_feed_ms;
        // silent feed, or a clock lead the cap would hold back (the feed late, not silent)
        let lead = tick_f - s.known as f64;
        s.set_feed_silent(feed_age > FEED_SILENT_MS || lead > s.prediction_cap() as f64);
        let stalled = s.advance_to(target + 1);
        if a.warm_ms.is_none() {
            let st = &mut a.stall;
            st.total += 1;
            if stalled {
                st.frames += 1;
                if !st.in_run {
                    st.in_run = true;
                    st.runs += 1;
                    st.run_ms = 0.0;
                }
                st.run_ms += dt.max(0.0) * 1000.0;
                st.longest_ms = st.longest_ms.max(st.run_ms);
            } else {
                st.in_run = false;
            }
        }
        // rollbacks per second (for the stats overlay)
        a.rollback_window.0 += dt;
        a.rollback_window.1 += s.rollbacks - rb_before;
        if a.rollback_window.0 >= 1.0 {
            a.rollback_rate = (a.rollback_window.1 as f64 / a.rollback_window.0) as f32;
            a.rollback_window = (0.0, 0);
        }
        if a.trace_on {
            a.trace.extend_from_slice(&[
                (dt * 1000.0) as f32,
                (tick_f - s.known as f64) as f32,
                s.head().saturating_sub(s.known) as f32,
                clock.margin as f32,
                clock.target_margin as f32,
                stalled as u8 as f32,
                (s.rollbacks - rb_before) as f32,
                s.last_depth as f32,
                feed_age as f32,
            ]);
        }
        // events of the ticks newly reached since the last frame. Confirmed ticks give the event
        // log (kills, bat hits: the same on every client, each fed once); predicted ticks give
        // what the player sees and hears at once (sounds, bat hit visuals), which a rollback may undo
        a.feed.clear();
        let new_head = s.head();
        s.drain_confirmed(|tick, prev, cur| a.feed.add_confirmed(tick, prev, cur));
        s.drain_predicted(|tick, prev, cur| a.feed.add_predicted(tick, prev, cur));
        a.feed.forget_before(s.base);
        let (prev, cur) = s.latest_pair();
        // between the last finished tick and the one in progress
        let alpha = (tick_f - (new_head as f64 - 1.0)).clamp(0.0, 1.0);
        let meta = Meta {
            tick: new_head,
            local: s.local.map_or(-1, |l| l as i32),
            prediction: (new_head.saturating_sub(s.known)) as f32,
            rollbacks_per_s: a.rollback_rate,
            tick_hz: s.start.tick_hz,
        };
        a.frame.build(prev, cur, alpha, &s.start.settings, meta, &a.feed);
        // send once per tick (heartbeat + unacknowledged changes) and
        // immediately when the input changed; the heartbeat names the tick in
        // progress, the one new inputs are stamped with
        let newest = s.last_input_seq();
        if target >= a.last_sent || newest != a.sent_seq {
            a.out = ClientFrame::Input(s.input_frame(target, MAX_RESEND, clock.next_frame())).encode();
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
        a.frame.build(&state, &state, 1.0, &gs, Meta { local: -1, ..Meta::default() }, &Feed::default());
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
/// `names`/`len` must describe readable memory.
///
/// The last `max_secs` (at least `min_secs`) of the recording of the current
/// or last online match, as a clip: replay JSON that starts from a state
/// snapshot, at `nb_out_ptr()`. Returns its length, or 0 when the recording
/// is too short or empty. `names`: as in [`nb_replay_export`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_replay_clip(names: u32, len: u32, max_secs: f64, min_secs: f64) -> i32 {
    let text = unsafe { bytes(names, len) };
    with(|a| {
        let names: Vec<(u32, String)> = match serde_json::from_slice(text) {
            Ok(n) => n,
            Err(e) => return fail(a, e),
        };
        let Some(r) = a.recorder.as_ref() else { return 0 };
        let hz = r.start().tick_hz;
        if r.is_empty() || (r.len() as f64) < min_secs * hz {
            return 0;
        }
        let max_ticks = (max_secs * hz).round() as u32;
        match neobox_net::clip(&r.finish(names), max_ticks) {
            Ok(c) => {
                a.out = c.to_json().into_bytes();
                a.out.len() as i32
            }
            Err(e) => fail(a, e),
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
        a.replay_feed_tick = player.tick();
        a.replay = Some(player);
        a.out.len() as i32
    })
}

/// Build the frame of the loaded replay at fractional tick `tick_f`,
/// following player `follow` (-1: none). Returns the tick shown, or REPLAY_PENDING
/// when the seek needs checkpoints or keyframes not built yet (nothing changes then; see
/// `nb_replay_build_keyframes`). Seeking anywhere is allowed;
/// events (sounds, kills, hits) are collected while playback moves forward by at most
/// REPLAY_FEED_TICKS ticks; seeks collect none.
#[unsafe(no_mangle)]
pub extern "C" fn nb_replay_frame(tick_f: f64, follow: i32) -> i32 {
    with(|a| {
        let Some(p) = a.replay.as_mut() else { return fail(a, "no replay loaded") };
        let first = p.first_tick() as f64;
        let last = p.end_tick() as f64;
        let t = tick_f.clamp(first, last);
        let base = t.floor() as u32;
        // show the step from `base` to `base + 1` (the last state at the end)
        let target = (base + 1).min(p.end_tick());
        let feed = target > a.replay_feed_tick && target - a.replay_feed_tick <= REPLAY_FEED_TICKS;
        if !feed && p.seek_waits(target) {
            return REPLAY_PENDING;
        }
        a.feed.clear();
        if feed {
            while p.tick() < target && p.step() {
                let (prev, cur) = p.states();
                a.feed.add(p.tick(), prev, cur);
            }
        } else {
            p.seek(target);
        }
        let alpha = if p.tick() == base + 1 { t - base as f64 } else { 1.0 };
        a.replay_feed_tick = p.tick();
        let (prev, cur) = p.states();
        let meta = Meta { tick: p.tick(), local: follow, tick_hz: p.replay.start.tick_hz, ..Meta::default() };
        a.frame.build(prev, cur, alpha, p.settings(), meta, &a.feed);
        base as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_replay_close() {
    with(|a| a.replay = None)
}

/// Simulate up to `max_ticks` more ticks of the loaded replay into its seek keyframes, checking its
/// checkpoints as they pass (idle-time work so seeks step at most one interval). Returns bit 0 when the
/// whole replay is built and checked, and bit 1 when a checkpoint failed its check (the seek data is dropped).
#[unsafe(no_mangle)]
pub extern "C" fn nb_replay_build_keyframes(max_ticks: u32) -> i32 {
    with(|a| {
        let Some(p) = a.replay.as_mut() else { return fail(a, "no replay loaded") };
        let done = p.build_keyframes(max_ticks);
        (done as i32) | ((p.checkpoints_failed() as i32) << 1)
    })
}

// ------------------------------------------------------------------ local games

/// # Safety
/// `json`/`len` must describe readable memory.
///
/// Start an offline game from a `MatchStart` (JSON); `player` is the local
/// player's id (one of `start.players`). A `map` object in the JSON is the
/// map itself (used instead of `maps` codes), parsed once with no
/// encode/decode round trip.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nb_local_start(json: u32, len: u32, player: u32) -> i32 {
    let text = unsafe { bytes(json, len) };
    with(|a| {
        let mut root: serde_json::Value = match serde_json::from_slice(text) {
            Ok(v) => v,
            Err(e) => return fail(a, e),
        };
        let dummies = match parse_dummies(&root) {
            Ok(d) => d,
            Err(e) => return fail(a, e),
        };
        let map = root.as_object_mut().and_then(|o| o.remove("map"));
        let start: MatchStart = match serde_json::from_value(root) {
            Ok(s) => s,
            Err(e) => return fail(a, e),
        };
        let m = match map {
            Some(map) => MapData::from_json(&map)
                .map(|md| ServerMatch::with_maps(start, vec![State::from_map(&md)]))
                .map_err(|e| e.to_string()),
            None => ServerMatch::new(start).map_err(|e| e.to_string()),
        };
        match m {
            Ok(m) => {
                a.local = Some(LocalGame { prev: m.state.clone(), m, player, acc: 0.0, seq: 0, latch: 0, last_mask: 0, applied: 0, dummies });
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
        a.feed.clear();
        while g.acc >= 1.0 {
            g.acc -= 1.0;
            // a key tapped between two ticks still counts for one tick
            let effective = mask | g.latch;
            g.latch = 0;
            let at = g.m.tick;
            for d in g.dummies.iter_mut() {
                let mask = d.mode.mask(at);
                if mask != d.applied {
                    let seq = g.m.input_ack(d.id) + 1;
                    g.m.submit(d.id, &InputFrame { ack: 0, now: at, frame: 0, changes: vec![(seq, at, mask)] });
                    d.applied = mask;
                }
            }
            if effective != g.applied {
                g.seq += 1;
                let tick = g.m.tick;
                g.m.submit(g.player, &InputFrame { ack: 0, now: tick, frame: 0, changes: vec![(g.seq, tick, effective)] });
                g.applied = effective;
            }
            g.prev = g.m.state.clone();
            g.m.step();
            a.feed.add(g.m.tick, &g.prev, &g.m.state);
        }
        let meta = Meta { tick: g.m.tick, local: g.player as i32, tick_hz: g.m.start.tick_hz, ..Meta::default() };
        a.frame.build(&g.prev, &g.m.state, g.acc, &g.m.start.settings, meta, &a.feed);
        (g.m.last_outcome == Outcome::MatchOver) as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn nb_local_end() {
    with(|a| a.local = None)
}
