//! Match timelines.
//!
//! The server owns the authoritative input timeline: it stamps every input
//! change with the tick at which it takes effect (never in the server's
//! past), simulates, and broadcasts each tick's confirmed changes. Clients
//! predict ahead with their own inputs and the last known inputs of others,
//! and roll back when a confirmation differs from what they predicted.

use crate::protocol::{InputFrame, MatchStart, TickData, TickEvent};
use neobox_sim::start::Outcome;
use neobox_sim::{advance, match_start, Events, GameSettings, MapData, Sim, State};
use std::collections::VecDeque;

/// Longest client prediction ahead of the last confirmed tick (ticks).
pub const MAX_PREDICTION: u32 = 45;
/// Ticks between server state checksums.
pub const CHECKSUM_INTERVAL: u32 = 30;

#[derive(Debug)]
pub enum MatchError {
    Map(neobox_sim::MapError),
    NoMaps,
    Snapshot,
}

impl std::fmt::Display for MatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MatchError::Map(e) => write!(f, "{e}"),
            MatchError::NoMaps => write!(f, "no map"),
            MatchError::Snapshot => write!(f, "invalid snapshot"),
        }
    }
}
impl std::error::Error for MatchError {}

/// Left and right held together cancel out (the original gives left
/// priority; see DEVIATIONS.md N7). Applied by the server to the
/// authoritative timeline and by clients to their predictions.
pub fn sanitize_input(mask: u8) -> u8 {
    if mask & 3 == 3 { mask & !3 } else { mask }
}

/// Per-player input changes, ascending by tick.
#[derive(Clone, Debug, Default)]
pub struct InputLog {
    players: Vec<Vec<(u32, u8)>>,
}

impl InputLog {
    pub fn mask_at(&self, player: u32, tick: u32) -> u8 {
        let Some(c) = self.players.get(player as usize) else { return 0 };
        match c.binary_search_by_key(&tick, |e| e.0) {
            Ok(i) => c[i].1,
            Err(0) => 0,
            Err(i) => c[i - 1].1,
        }
    }
    pub fn latest(&self, player: u32) -> Option<(u32, u8)> {
        self.players.get(player as usize).and_then(|c| c.last().copied())
    }
    /// Record a change (replaces a change at the same tick).
    pub fn record(&mut self, player: u32, tick: u32, mask: u8) {
        let p = player as usize;
        if self.players.len() <= p {
            self.players.resize_with(p + 1, Vec::new);
        }
        let c = &mut self.players[p];
        match c.binary_search_by_key(&tick, |e| e.0) {
            Ok(i) => c[i].1 = mask,
            Err(i) => c.insert(i, (tick, mask)),
        }
    }
    /// Drop history before `tick` (keeping the change in effect at `tick`).
    pub fn prune(&mut self, tick: u32) {
        for c in &mut self.players {
            let keep = match c.binary_search_by_key(&tick, |e| e.0) {
                Ok(i) => i,
                Err(i) => i.saturating_sub(1),
            };
            if keep > 0 {
                c.drain(..keep);
            }
        }
    }
    pub fn masks_at(&self, tick: u32, out: &mut Vec<u8>) {
        out.clear();
        out.resize(self.players.len(), 0);
        for (p, o) in out.iter_mut().enumerate() {
            *o = self.mask_at(p as u32, tick);
        }
    }
    /// Drop `player`'s changes after `tick`.
    pub fn cut_after(&mut self, player: u32, tick: u32) {
        if let Some(c) = self.players.get_mut(player as usize) {
            let keep = c.partition_point(|e| e.0 <= tick);
            c.truncate(keep);
        }
    }
    /// Non-zero masks in effect at `tick` (player, mask).
    pub fn held_at(&self, tick: u32) -> Vec<(u32, u8)> {
        (0..self.players.len() as u32).map(|p| (p, self.mask_at(p, tick))).filter(|e| e.1 != 0).collect()
    }
}

pub(crate) fn to_events(evs: &[TickEvent]) -> Option<Events> {
    if evs.is_empty() {
        return None;
    }
    let mut e = Events::default();
    for ev in evs {
        match ev {
            TickEvent::Leave(p) => e.removed.push(*p),
            TickEvent::Join(p, t) => e.joined.push((*p, *t)),
        }
    }
    Some(e)
}

/// Lobby states for a match's rotation playlist.
pub fn load_maps(start: &MatchStart) -> Result<Vec<State>, MatchError> {
    if start.maps.is_empty() {
        return Err(MatchError::NoMaps);
    }
    start.maps.iter().map(|c| MapData::from_code(c).map(|m| State::from_map(&m)).map_err(MatchError::Map)).collect()
}

/// FNV-1a over the compact binary encoding of a state.
pub fn checksum(state: &State) -> u64 {
    let bytes = postcard::to_allocvec(state).unwrap_or_default();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Compressed binary snapshot of a state.
pub fn encode_state(state: &State) -> Vec<u8> {
    let raw = postcard::to_allocvec(state).unwrap_or_default();
    miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6)
}

pub fn decode_state(b: &[u8]) -> Result<State, MatchError> {
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(b, 64 << 20).map_err(|_| MatchError::Snapshot)?;
    postcard::from_bytes(&raw).map_err(|_| MatchError::Snapshot)
}

// ------------------------------------------------------------------ server

/// Authoritative match on the server.
pub struct ServerMatch {
    pub start: MatchStart,
    sim: Sim,
    gs: GameSettings,
    maps: Vec<State>,
    /// tick of `state` (= the next tick to simulate)
    pub tick: u32,
    pub state: State,
    inputs: InputLog,
    current: TickData,
    /// newest input change sequence number processed, per player
    input_seqs: Vec<u32>,
    masks: Vec<u8>,
    pub last_outcome: Outcome,
}

/// Result of processing a client input frame.
#[derive(Clone, Copy, Debug)]
pub struct InputReceipt {
    /// Ticks early (positive) or late (negative) the client's heartbeat
    /// arrived.
    pub margin: i64,
}

impl ServerMatch {
    pub fn new(start: MatchStart) -> Result<ServerMatch, MatchError> {
        let maps = load_maps(&start)?;
        let gs = start.settings.clone();
        let state = match_start(&maps[0], start.seed, &start.players, &gs, start.intro, start.rotation);
        Ok(ServerMatch {
            tick: start.start_tick,
            current: TickData { tick: start.start_tick, ..TickData::default() },
            start,
            sim: Sim::new(),
            gs,
            maps,
            state,
            inputs: InputLog::default(),
            input_seqs: Vec::new(),
            masks: Vec::new(),
            last_outcome: Outcome::Running,
        })
    }

    /// Process an input frame of `player`. Changes already processed are
    /// skipped; new ones take effect at the tick the client asked for, or
    /// at the current tick if that has passed (never rewriting the past).
    /// Every change lasts at least one tick, even when several arrive late
    /// together, so a quick tap is never lost.
    pub fn submit(&mut self, player: u32, frame: &InputFrame) -> InputReceipt {
        let p = player as usize;
        if self.input_seqs.len() <= p {
            self.input_seqs.resize(p + 1, 0);
        }
        // inputs stamped further ahead than any client predicts are clamped
        let horizon = self.tick + MAX_PREDICTION * 2;
        for &(seq, tick, mask) in &frame.changes {
            if seq <= self.input_seqs[p] {
                continue;
            }
            self.input_seqs[p] = seq;
            let mask = sanitize_input(mask);
            let latest = self.inputs.latest(player);
            if latest.map_or(0, |l| l.1) == mask {
                continue;
            }
            let at = tick.min(horizon).max(self.tick).max(latest.map_or(0, |l| l.0 + 1));
            self.inputs.record(player, at, mask);
        }
        InputReceipt { margin: frame.now as i64 - self.tick as i64 }
    }

    /// Newest input change sequence number processed for `player`.
    pub fn input_ack(&self, player: u32) -> u32 {
        self.input_seqs.get(player as usize).copied().unwrap_or(0)
    }

    /// A player joins at the current tick.
    pub fn join(&mut self, player: u32, team: f64) {
        self.current.events.push(TickEvent::Join(player, team));
    }

    /// A player leaves at the current tick.
    pub fn leave(&mut self, player: u32) {
        self.current.events.push(TickEvent::Leave(player));
        self.neutralize(player);
    }

    /// From the current tick on, `player` presses nothing (a lost connection
    /// whose slot is held for a reconnect); inputs already stamped for later
    /// ticks are dropped.
    pub fn neutralize(&mut self, player: u32) {
        self.inputs.record(player, self.tick, 0);
        self.inputs.cut_after(player, self.tick);
    }

    /// A player's new connection numbers its input changes from scratch.
    pub fn reset_input_seq(&mut self, player: u32) {
        if let Some(s) = self.input_seqs.get_mut(player as usize) {
            *s = 0;
        }
    }

    /// Simulate the current tick. Returns the confirmed data of that tick.
    pub fn step(&mut self) -> TickData {
        let mut data = std::mem::take(&mut self.current);
        data.tick = self.tick;
        for (p, log) in self.inputs.players.iter().enumerate() {
            if let Ok(i) = log.binary_search_by_key(&self.tick, |e| e.0) {
                data.changes.push((p as u32, log[i].1));
            }
        }
        self.inputs.masks_at(self.tick, &mut self.masks);
        let events = to_events(&data.events);
        let (next, outcome) = advance(&mut self.sim, &self.state, &self.masks, events.as_ref(), &self.gs, &self.maps);
        self.state = next;
        self.last_outcome = outcome;
        self.tick += 1;
        self.current = TickData { tick: self.tick, ..TickData::default() };
        if self.tick % 64 == 0 {
            self.inputs.prune(self.tick.saturating_sub(1));
        }
        data
    }

    /// The last tick hit the physics limits (see [`Sim::overloaded`]).
    pub fn overloaded(&self) -> bool {
        self.sim.overloaded()
    }

    pub fn checksum(&self) -> u64 {
        checksum(&self.state)
    }

    /// Compressed state at `self.tick`. Send it with [`ServerMatch::held_masks`]:
    /// the state does not say which keys players are holding.
    pub fn snapshot(&self) -> Vec<u8> {
        encode_state(&self.state)
    }

    /// Input masks in effect just before the current tick (player, mask);
    /// changes from the current tick on travel in batches.
    pub fn held_masks(&self) -> Vec<(u32, u8)> {
        if self.tick == 0 { Vec::new() } else { self.inputs.held_at(self.tick - 1) }
    }

    /// Current input mask of every player (for the admin view).
    pub fn current_mask(&self, player: u32) -> u8 {
        self.inputs.mask_at(player, self.tick)
    }
}

// ------------------------------------------------------------------ client

/// Client-side prediction with rollback.
///
/// `known`: inputs and events of every tick below it are confirmed.
/// `states[i]` is the state at tick `base + i`; `states[0]` is final
/// (`base <= known`), later states may be predictions.
pub struct ClientSession {
    pub start: MatchStart,
    sim: Sim,
    gs: GameSettings,
    maps: Vec<State>,
    pub local: Option<u32>,
    pub base: u32,
    pub known: u32,
    inputs: InputLog,
    events: VecDeque<(u32, Vec<TickEvent>)>,
    /// local input changes (sequence number, tick, mask), ascending; kept
    /// until acknowledged and confirmed
    pending: Vec<(u32, u32, u8)>,
    next_seq: u32,
    acked_seq: u32,
    states: VecDeque<State>,
    /// inputs and "had events" used to compute `states[i + 1]`
    used: VecDeque<(Vec<u8>, bool)>,
    /// earliest tick whose step must be recomputed
    dirty: Option<u32>,
    /// server checksums awaiting comparison
    server_hashes: VecDeque<(u32, u64)>,
    pub desynced: bool,
    pub outcome: Outcome,
    scratch: Vec<u8>,
    /// recycled `used` input vectors (no allocation per simulated tick)
    spare: Vec<Vec<u8>>,
    pub rollbacks: u64,
    pub resimulated: u64,
}

impl ClientSession {
    pub fn new(start: MatchStart, local: Option<u32>) -> Result<ClientSession, MatchError> {
        let maps = load_maps(&start)?;
        let gs = start.settings.clone();
        let state = match_start(&maps[0], start.seed, &start.players, &gs, start.intro, start.rotation);
        let tick = start.start_tick;
        Ok(Self::with_state(start, local, maps, gs, state, tick))
    }

    /// Join a running match from a snapshot of the state at `tick` and the
    /// masks players held then ([`ServerMatch::held_masks`]).
    pub fn from_snapshot(start: MatchStart, local: Option<u32>, tick: u32, snapshot: &[u8], held: &[(u32, u8)]) -> Result<ClientSession, MatchError> {
        let maps = load_maps(&start)?;
        let gs = start.settings.clone();
        let state = decode_state(snapshot)?;
        let mut s = Self::with_state(start, local, maps, gs, state, tick);
        for &(p, m) in held {
            s.inputs.record(p, tick.saturating_sub(1), m);
        }
        Ok(s)
    }

    fn with_state(start: MatchStart, local: Option<u32>, maps: Vec<State>, gs: GameSettings, state: State, tick: u32) -> ClientSession {
        let mut states = VecDeque::with_capacity(64);
        states.push_back(state);
        ClientSession {
            start,
            sim: Sim::new(),
            gs,
            maps,
            local,
            base: tick,
            known: tick,
            inputs: InputLog::default(),
            events: VecDeque::new(),
            pending: Vec::new(),
            next_seq: 1,
            acked_seq: 0,
            states,
            used: VecDeque::with_capacity(64),
            dirty: None,
            server_hashes: VecDeque::new(),
            desynced: false,
            outcome: Outcome::Running,
            scratch: Vec::new(),
            spare: Vec::new(),
            rollbacks: 0,
            resimulated: 0,
        }
    }

    /// Tick of the newest simulated state.
    pub fn head(&self) -> u32 {
        self.base + self.states.len() as u32 - 1
    }

    pub fn state(&self) -> &State {
        self.states.back().expect("state")
    }

    /// The newest final state (at tick `base`, inputs confirmed).
    pub fn confirmed_state(&self) -> &State {
        &self.states[0]
    }

    /// The newest state and the one before it (for interpolation).
    pub fn latest_pair(&self) -> (&State, &State) {
        let n = self.states.len();
        let cur = &self.states[n - 1];
        let prev = if n >= 2 { &self.states[n - 2] } else { cur };
        (prev, cur)
    }

    /// Record the local player's input for `tick` (only changes matter).
    pub fn local_input(&mut self, tick: u32, mask: u8) {
        let mask = sanitize_input(mask);
        let Some(l) = self.local else { return };
        if self.local_mask_at(l, tick) == mask {
            return;
        }
        self.pending.retain(|p| p.1 < tick);
        self.pending.push((self.next_seq, tick, mask));
        self.next_seq += 1;
        if tick <= self.head() {
            self.mark_dirty(tick);
        }
    }

    /// Sequence number of the newest local input change (0 = none yet).
    pub fn last_input_seq(&self) -> u32 {
        self.next_seq - 1
    }

    /// Continue numbering input changes after an earlier session's (only
    /// before the first change; numbers must never repeat on a connection).
    pub fn continue_input_seq(&mut self, next: u32) {
        if self.pending.is_empty() {
            self.next_seq = self.next_seq.max(next);
            self.acked_seq = self.next_seq - 1;
        }
    }

    /// Input frame carrying the oldest `max` unacknowledged changes, sent
    /// with the current tick `now` as heartbeat.
    pub fn input_frame(&self, now: u32, max: usize) -> InputFrame {
        let first = self.pending.partition_point(|p| p.0 <= self.acked_seq);
        let end = (first + max).min(self.pending.len());
        InputFrame { ack: self.known, now, changes: self.pending[first..end].to_vec() }
    }

    /// The server processed our input changes up to sequence number `seq`.
    pub fn input_ack(&mut self, seq: u32) {
        self.acked_seq = self.acked_seq.max(seq.min(self.next_seq - 1));
        self.drop_settled_inputs();
    }

    /// Forget changes the server has processed once their tick is confirmed
    /// (the confirmed log then holds them, possibly at a later tick).
    fn drop_settled_inputs(&mut self) {
        let (acked, known) = (self.acked_seq, self.known);
        self.pending.retain(|p| p.0 > acked || p.1 >= known);
    }

    fn mark_dirty(&mut self, tick: u32) {
        let t = tick.max(self.base);
        self.dirty = Some(self.dirty.map_or(t, |d| d.min(t)));
    }

    /// The local player's input in effect at `tick` (confirmed or pending).
    pub fn local_mask_at(&self, player: u32, tick: u32) -> u8 {
        if tick < self.known {
            return self.inputs.mask_at(player, tick);
        }
        let mut mask = self.inputs.mask_at(player, tick);
        for &(_, t, m) in &self.pending {
            if t.max(self.known) <= tick {
                mask = m;
            }
        }
        mask
    }

    fn inputs_for(&self, tick: u32, out: &mut Vec<u8>) {
        if tick < self.known {
            self.inputs.masks_at(tick, out);
        } else if self.known == self.start.start_tick {
            self.inputs.masks_at(tick, out);
            out.iter_mut().for_each(|m| *m = 0);
        } else {
            // others keep their last known input
            self.inputs.masks_at(self.known - 1, out);
        }
        if let Some(l) = self.local {
            let l = l as usize;
            if out.len() <= l {
                out.resize(l + 1, 0);
            }
            out[l] = self.local_mask_at(l as u32, tick);
        }
    }

    fn events_at(&self, tick: u32) -> Option<Events> {
        if tick >= self.known {
            return None;
        }
        self.events.iter().find(|e| e.0 == tick).and_then(|e| to_events(&e.1))
    }

    /// Apply confirmed ticks (in order; already-known ticks are ignored).
    pub fn on_ticks(&mut self, ticks: &[TickData]) {
        for t in ticks {
            if t.tick < self.known {
                continue;
            }
            if t.tick > self.known {
                // a gap means lost data: ask for a snapshot
                self.desynced = true;
                return;
            }
            for &(p, m) in &t.changes {
                self.inputs.record(p, t.tick, m);
            }
            if !t.events.is_empty() {
                self.events.push_back((t.tick, t.events.clone()));
            }
            self.known = t.tick + 1;
            // did the prediction for this tick use the right inputs?
            let i = (t.tick - self.base) as usize;
            if let Some((u, had)) = self.used.get(i) {
                let mut actual = std::mem::take(&mut self.scratch);
                self.inputs.masks_at(t.tick, &mut actual);
                let n = u.len().max(actual.len());
                let differs = (0..n).any(|k| u.get(k).copied().unwrap_or(0) != actual.get(k).copied().unwrap_or(0))
                    || *had != !t.events.is_empty();
                self.scratch = actual;
                if differs {
                    self.mark_dirty(t.tick);
                }
            }
        }
        self.drop_settled_inputs();
        self.settle();
    }

    /// Resimulate if needed, then drop states no longer needed (keeping the
    /// newest final state as the rollback base).
    fn settle(&mut self) {
        self.resimulate();
        while self.head() < self.known {
            self.step_one();
        }
        while self.base < self.known && self.states.len() > 1 {
            self.states.pop_front();
            if let Some((v, _)) = self.used.pop_front() {
                self.spare.push(v);
            }
            self.base += 1;
            self.check_hash();
        }
        while self.events.front().is_some_and(|e| e.0 < self.base) {
            self.events.pop_front();
        }
        if self.base % 64 == 0 {
            self.inputs.prune(self.base.saturating_sub(1));
        }
    }

    /// Server checksum of its state at `tick`.
    pub fn on_checksum(&mut self, tick: u32, hash: u64) {
        self.server_hashes.push_back((tick, hash));
        self.check_hash();
    }

    fn check_hash(&mut self) {
        while let Some(&(t, h)) = self.server_hashes.front() {
            if t > self.base {
                break;
            }
            self.server_hashes.pop_front();
            if t == self.base && checksum(&self.states[0]) != h {
                self.desynced = true;
            }
        }
    }

    fn step_one(&mut self) {
        let tick = self.head();
        let mut masks = std::mem::take(&mut self.scratch);
        self.inputs_for(tick, &mut masks);
        let evs = self.events_at(tick);
        let had = evs.is_some();
        let prev = self.states.back().expect("state");
        let (next, outcome) = advance(&mut self.sim, prev, &masks, evs.as_ref(), &self.gs, &self.maps);
        self.outcome = outcome;
        self.states.push_back(next);
        let mut used = self.spare.pop().unwrap_or_default();
        used.clear();
        used.extend_from_slice(&masks);
        self.used.push_back((used, had));
        self.scratch = masks;
    }

    /// Recompute every state after the dirty tick, up to the current head.
    fn resimulate(&mut self) {
        let Some(d) = self.dirty.take() else { return };
        let head = self.head();
        if d >= head {
            return;
        }
        self.rollbacks += 1;
        let keep = (d - self.base) as usize + 1;
        self.states.truncate(keep);
        while self.used.len() > keep - 1 {
            if let Some((v, _)) = self.used.pop_back() {
                self.spare.push(v);
            }
        }
        while self.head() < head {
            self.step_one();
            self.resimulated += 1;
        }
    }

    /// Predict forward to `target` (bounded by the prediction window).
    pub fn advance_to(&mut self, target: u32) {
        self.resimulate();
        let limit = self.known + MAX_PREDICTION;
        while self.head() < target.min(limit) {
            self.step_one();
        }
    }
}

/// Local tick clock that keeps the client's inputs arriving slightly ahead
/// of the server (`margin`), speeding up or slowing down smoothly.
#[derive(Clone, Debug)]
pub struct TickClock {
    pub hz: f64,
    /// fractional tick
    pub tick: f64,
    /// target arrival margin in ticks
    pub target_margin: f64,
    margin: f64,
    have_margin: bool,
}

impl TickClock {
    pub fn new(hz: f64, start_tick: f64, lead: f64) -> TickClock {
        TickClock { hz, tick: start_tick + lead, target_margin: 1.5, margin: 0.0, have_margin: false }
    }

    /// Feedback from the server: how early our newest input arrived.
    pub fn on_margin(&mut self, margin_ticks: f64) {
        if !self.have_margin {
            self.margin = margin_ticks;
            self.have_margin = true;
            // large errors are corrected immediately
            if (margin_ticks - self.target_margin).abs() > 8.0 {
                self.tick += self.target_margin - margin_ticks;
                self.have_margin = false;
            }
        } else {
            self.margin += (margin_ticks - self.margin) * 0.1;
            if (margin_ticks - self.target_margin).abs() > 15.0 {
                self.tick += self.target_margin - margin_ticks;
                self.margin = self.target_margin;
            }
        }
    }

    /// Advance by `dt` seconds; returns the current fractional tick.
    pub fn update(&mut self, dt: f64) -> f64 {
        let err = if self.have_margin { self.target_margin - self.margin } else { 0.0 };
        let rate = 1.0 + (err * 0.02).clamp(-0.06, 0.06);
        self.tick += dt.clamp(0.0, 0.25) * self.hz * rate;
        self.tick
    }
}
