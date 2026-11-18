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
use std::collections::{BTreeMap, VecDeque};

/// Longest client prediction ahead of the last confirmed tick (ticks).
pub const MAX_PREDICTION: u32 = 45;

/// Most ticks predicted past the server's confirmed tick. A feed stall stops
/// prediction here, so a rollback after it is at most this deep.
pub const PREDICTION_CAP: u32 = 20;

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
#[derive(Clone, Debug)]
pub struct InputReceipt {
    /// Ticks early (positive) or late (negative) the client's heartbeat
    /// arrived.
    pub margin: i64,
    /// Changes taken, as (tick, mask), for forwarding to the other players ahead of their batches.
    pub taken: Vec<(u32, u8)>,
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
        let mut taken = Vec::new();
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
            taken.push((at, mask));
        }
        InputReceipt { margin: frame.now as i64 - self.tick as i64, taken }
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

/// Why a client session needs a snapshot from the server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desync {
    /// a batch starts at `got` while the next tick needed is `expected`
    Gap { expected: u32, got: u32 },
    /// the server's checksum of `tick` differs from the local state
    Hash { tick: u32 },
}

/// Rollback depths are counted exactly up to this many ticks; deeper ones share the last bin.
const DEPTH_BINS: usize = 64;

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
    /// Per player, the changes the server forwarded ahead of their batches, ascending by tick.
    /// They are predicted until the batch of their tick confirms them.
    hints: Vec<Vec<(u32, u8)>>,
    next_seq: u32,
    acked_seq: u32,
    states: VecDeque<State>,
    /// inputs and "had events" used to compute `states[i + 1]`
    used: VecDeque<(Vec<u8>, bool)>,
    /// earliest tick whose step must be recomputed
    dirty: Option<u32>,
    /// server checksums awaiting comparison
    server_hashes: VecDeque<(u32, u64)>,
    /// the first reason this session lost sync (it needs a snapshot after this)
    pub desync: Option<Desync>,
    /// rollbacks by depth in ticks; the last bin holds `DEPTH_BINS` and deeper
    depth_hist: [u64; DEPTH_BINS + 1],
    pub outcome: Outcome,
    scratch: Vec<u8>,
    /// recycled `used` input vectors (no allocation per simulated tick)
    spare: Vec<Vec<u8>>,
    pub rollbacks: u64,
    pub resimulated: u64,
    /// drain positions of the live frame's feed; `None` until attached (nothing is pruned before it drains)
    feed: Option<FeedCursor>,
}

/// The live frame's drain positions: the confirmed and the predicted ticks already fed.
#[derive(Clone, Copy, Debug)]
struct FeedCursor {
    confirmed: u32,
    predicted: u32,
}

/// Keys of the presentation records already fed, per tick. A rollback rewinds the predicted feed
/// to the first recomputed tick, so records of those ticks come round again; the consumer passes
/// each record through [`FedKeys::first`] and only new ones go out.
#[derive(Clone, Debug)]
pub struct FedKeys<K> {
    ticks: BTreeMap<u32, Vec<K>>,
}

impl<K> Default for FedKeys<K> {
    fn default() -> Self {
        FedKeys { ticks: BTreeMap::new() }
    }
}

impl<K: PartialEq> FedKeys<K> {
    /// True the first time `key` is seen for `tick` (and records it).
    pub fn first(&mut self, tick: u32, key: K) -> bool {
        let keys = self.ticks.entry(tick).or_default();
        if keys.contains(&key) {
            return false;
        }
        keys.push(key);
        true
    }

    /// Forget the ticks before `tick` (rollbacks never reach below the session's base).
    pub fn forget_before(&mut self, tick: u32) {
        self.ticks = self.ticks.split_off(&tick);
    }
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
            hints: Vec::new(),
            next_seq: 1,
            acked_seq: 0,
            states,
            used: VecDeque::with_capacity(64),
            dirty: None,
            server_hashes: VecDeque::new(),
            desync: None,
            depth_hist: [0; DEPTH_BINS + 1],
            outcome: Outcome::Running,
            scratch: Vec::new(),
            spare: Vec::new(),
            rollbacks: 0,
            resimulated: 0,
            feed: None,
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

    /// The (tick, previous, current) of the ticks in `(from, to]` still held, oldest first.
    pub fn pairs_between(&self, from: u32, to: u32) -> impl Iterator<Item = (u32, &State, &State)> {
        let first = from.saturating_add(1).max(self.base + 1);
        let last = to.min(self.head());
        let (lo, hi) = if last >= first { ((first - self.base) as usize, (last - self.base) as usize + 1) } else { (0, 0) };
        let (base, states) = (self.base, &self.states);
        (lo..hi).map(move |i| (base + i as u32, &states[i - 1], &states[i]))
    }

    /// Start the live feed: states are kept until drained.
    pub fn attach_feed(&mut self) {
        self.feed = Some(FeedCursor { confirmed: self.base, predicted: self.base });
    }

    /// Feed the pairs of the confirmed ticks not drained yet. Confirmed states never change again,
    /// so their events agree on every client.
    pub fn drain_confirmed(&mut self, mut f: impl FnMut(u32, &State, &State)) {
        let Some(c) = self.feed else { return };
        let to = self.known;
        for (t, p, q) in self.pairs_between(c.confirmed, to) {
            f(t, p, q);
        }
        if let Some(c) = self.feed.as_mut() {
            c.confirmed = to;
        }
    }

    /// Feed the pairs of the predicted ticks not drained yet. Presentation only: a rollback may undo them,
    /// and then the recomputed ticks are fed again (the consumer keeps what it has fed, see [`FedKeys`]).
    pub fn drain_predicted(&mut self, mut f: impl FnMut(u32, &State, &State)) {
        let Some(c) = self.feed else { return };
        let to = self.head();
        for (t, p, q) in self.pairs_between(c.predicted, to) {
            f(t, p, q);
        }
        if let Some(c) = self.feed.as_mut() {
            c.predicted = to;
        }
    }

    /// States at or above this tick are kept for the live feed.
    fn feed_floor(&self) -> u32 {
        self.feed.map_or(u32::MAX, |c| c.confirmed.min(c.predicted))
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
        if tick >= self.known {
            self.apply_hints(tick, out);
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
                self.set_desync(Desync::Gap { expected: self.known, got: t.tick });
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
                let differs = !Self::same_masks(u, &actual) || *had != !t.events.is_empty();
                self.scratch = actual;
                if differs {
                    self.mark_dirty(t.tick);
                }
            }
        }
        self.drop_settled_inputs();
        self.drop_settled_hints();
        self.settle();
    }

    /// A remote player's change the server accepted but has not confirmed yet, sent on arrival
    /// ahead of the batch of its tick. It is predicted from now on and the batch confirms it; a
    /// change that disagrees with a prediction already made rolls back at its tick.
    pub fn on_hint(&mut self, player: u32, tick: u32, mask: u8) {
        if self.local == Some(player) || tick < self.known {
            return;
        }
        let p = player as usize;
        if self.hints.len() <= p {
            self.hints.resize_with(p + 1, Vec::new);
        }
        let log = &mut self.hints[p];
        match log.binary_search_by_key(&tick, |e| e.0) {
            Ok(i) => log[i].1 = mask,
            Err(i) => log.insert(i, (tick, mask)),
        }
        if tick < self.head() {
            let mut masks = std::mem::take(&mut self.scratch);
            self.inputs_for(tick, &mut masks);
            let differs = self.used.get((tick - self.base) as usize).is_some_and(|(u, _)| !Self::same_masks(u, &masks));
            self.scratch = masks;
            if differs {
                self.mark_dirty(tick);
                self.resimulate();
            }
        }
    }

    /// Overlay the forwarded changes that take effect by `tick` onto `out`.
    fn apply_hints(&self, tick: u32, out: &mut Vec<u8>) {
        for (p, log) in self.hints.iter().enumerate() {
            let i = log.partition_point(|e| e.0 <= tick);
            if i > 0 {
                if out.len() <= p {
                    out.resize(p + 1, 0);
                }
                out[p] = log[i - 1].1;
            }
        }
    }

    /// Forget forwarded changes that the confirmed batches have passed.
    fn drop_settled_hints(&mut self) {
        let known = self.known;
        for log in &mut self.hints {
            log.retain(|e| e.0 >= known);
        }
    }

    /// Equal masks, where a missing player counts as 0.
    fn same_masks(a: &[u8], b: &[u8]) -> bool {
        let n = a.len().max(b.len());
        (0..n).all(|k| a.get(k).copied().unwrap_or(0) == b.get(k).copied().unwrap_or(0))
    }

    /// Resimulate if needed, then drop states no longer needed (keeping the
    /// newest final state as the rollback base).
    fn settle(&mut self) {
        self.resimulate();
        while self.head() < self.known {
            self.step_one();
        }
        while self.base < self.known && self.base < self.feed_floor() && self.states.len() > 1 {
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

    fn set_desync(&mut self, d: Desync) {
        self.desync.get_or_insert(d);
    }

    /// Nearest-rank percentile `pct` of the rollback depths counted since the last
    /// [`Self::reset_depth_stats`] (0 if none).
    pub fn rollback_depth_pct(&self, pct: u32) -> u32 {
        let n: u64 = self.depth_hist.iter().sum();
        if n == 0 {
            return 0;
        }
        let rank = (n * pct as u64).div_ceil(100).max(1);
        let mut seen = 0;
        for (depth, &count) in self.depth_hist.iter().enumerate() {
            seen += count;
            if seen >= rank {
                return depth as u32;
            }
        }
        DEPTH_BINS as u32
    }

    /// Start counting rollback depths afresh (the stats skip the match's warm-up).
    pub fn reset_depth_stats(&mut self) {
        self.depth_hist = [0; DEPTH_BINS + 1];
    }

    fn check_hash(&mut self) {
        while let Some(&(t, h)) = self.server_hashes.front() {
            if t > self.base {
                break;
            }
            self.server_hashes.pop_front();
            if t == self.base && checksum(&self.states[0]) != h {
                self.set_desync(Desync::Hash { tick: t });
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
        self.depth_hist[((head - d) as usize).min(DEPTH_BINS)] += 1;
        if let Some(c) = self.feed.as_mut() {
            c.predicted = c.predicted.min(d);
        }
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
        let limit = self.known + PREDICTION_CAP;
        while self.head() < target.min(limit) {
            self.step_one();
        }
    }
}

/// Local tick clock: keeps our inputs arriving at the server a few ticks ahead
/// of when it needs them, speeding up or slowing down smoothly.
///
/// The target lead is sized from the spread of the arrival margins the server
/// reports: a spread is what makes an input late. Round-trip samples are not
/// used, because they include the client's own scheduling delay.
#[derive(Clone, Debug)]
pub struct TickClock {
    pub hz: f64,
    /// fractional tick
    pub tick: f64,
    /// target arrival margin in ticks
    target_margin: f64,
    /// smoothed arrival margin in ticks
    margin: f64,
    have_margin: bool,
    spread: Spread,
}

impl TickClock {
    pub fn new(hz: f64, start_tick: f64, lead: f64) -> TickClock {
        TickClock { hz, tick: start_tick + lead, target_margin: 1.5, margin: 0.0, have_margin: false, spread: Spread::default() }
    }

    /// Feedback from the server: how early our newest input arrived. The target
    /// lead is one tick plus twice the spread of the recent margins, clamped to
    /// one to six ticks.
    pub fn on_margin(&mut self, margin_ticks: f64) {
        self.spread.push(margin_ticks);
        self.target_margin = (1.0 + 2.0 * self.spread.get()).clamp(1.0, 6.0);
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

    /// Longest believable gap between two frames, in seconds.
    const MAX_GAP_S: f64 = 0.5;

    /// Advance by `dt` seconds; returns the current fractional tick. A gap that
    /// cannot be a frame (negative, or longer than `MAX_GAP_S`) means the local
    /// clock stepped: the clock resyncs at once to the server's `confirmed` tick
    /// plus the target lead, instead of running ahead or behind for seconds.
    pub fn update(&mut self, dt: f64, confirmed: f64) -> f64 {
        if !(0.0..=Self::MAX_GAP_S).contains(&dt) {
            self.tick = confirmed + self.target_margin;
            self.margin = self.target_margin;
            self.have_margin = false;
            return self.tick;
        }
        let err = if self.have_margin { self.target_margin - self.margin } else { 0.0 };
        let rate = 1.0 + (err * 0.02).clamp(-0.06, 0.06);
        self.tick += dt.clamp(0.0, 0.25) * self.hz * rate;
        self.tick
    }
}

/// Samples kept by a [`Spread`].
const SPREAD_SAMPLES: usize = 16;

/// Spread of the latest samples: the median excess over their minimum. A single
/// sample far above the rest, such as a reply delayed by a busy thread, does not
/// move it.
#[derive(Clone, Debug, Default)]
struct Spread {
    window: [f64; SPREAD_SAMPLES],
    /// samples held in `window`
    count: usize,
    /// slot the next sample is written to
    next: usize,
}

impl Spread {
    fn push(&mut self, x: f64) {
        self.window[self.next] = x;
        self.next = (self.next + 1) % SPREAD_SAMPLES;
        self.count = (self.count + 1).min(SPREAD_SAMPLES);
    }

    fn get(&self) -> f64 {
        let w = &self.window[..self.count];
        let Some(min) = w.iter().copied().reduce(f64::min) else {
            return 0.0;
        };
        let mut excess = [0.0f64; SPREAD_SAMPLES];
        for (e, &x) in excess.iter_mut().zip(w) {
            *e = x - min;
        }
        let e = &mut excess[..self.count];
        e.sort_unstable_by(f64::total_cmp);
        e[e.len() / 2]
    }
}

/// Smoothed round-trip time of the link in ms, from ping/pong samples. It sizes
/// the initial clock lead and the HUD; it does not set the target margin.
#[derive(Clone, Debug, Default)]
pub struct RttTracker {
    smooth: Option<f64>,
}

impl RttTracker {
    pub fn sample(&mut self, rtt_ms: f64) {
        self.smooth = Some(match self.smooth {
            None => rtt_ms,
            Some(prev) => prev + (rtt_ms - prev) * 0.2,
        });
    }

    /// Smoothed round-trip time in ms; None before the first sample.
    pub fn rtt(&self) -> Option<f64> {
        self.smooth
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neobox_sim::{GameSettings, MapData};
    use crate::protocol::InputFrame;
    use std::collections::VecDeque;
    use neobox_sim::input::BAT;
    use neobox_sim::step::kind;

    fn start() -> MatchStart {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../maps/01-proving-grounds.json");
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let code = MapData::from_json(&json["map"]).unwrap().to_code();
        MatchStart {
            seed: 5,
            start_tick: 0,
            tick_hz: 30.0,
            players: vec![(0, 1.0), (1, 1.0)],
            settings: GameSettings::default(),
            maps: vec![code],
            intro: false,
            rotation: false,
        }
    }

    /// Batches that arrive late, twice, or overlapping (the unreliable path
    /// resends everything unconfirmed from the acknowledged tick) are not gaps:
    /// the client applies each tick once and ends on the server's state.
    #[test]
    fn late_and_resent_batches_do_not_desync() {
        let mut server = ServerMatch::new(start()).unwrap();
        let ticks: Vec<TickData> = (0..90).map(|_| server.step()).collect();
        let mut c = ClientSession::new(start(), None).unwrap();
        c.on_ticks(&ticks[0..30]);
        c.on_ticks(&ticks[10..50]);
        c.on_ticks(&ticks[0..20]);
        c.on_ticks(&ticks[50..90]);
        assert_eq!(c.desync, None);
        assert_eq!(c.known, 90);
        assert_eq!(c.base, 90);
        assert_eq!(checksum(c.confirmed_state()), server.checksum());
    }

    /// The live feed's confirmed stream matches an undisturbed session after a rollback: a predicted
    /// tick the server corrects never reaches it, each confirmed tick is fed once, and the predicted
    /// stream (which the rollback leaves behind) is fed once too.
    #[test]
    fn confirmed_feed_ignores_rolled_back_predictions() {
        let mut server = ServerMatch::new(start()).unwrap();
        server.submit(0, &InputFrame { ack: 0, now: 0, changes: vec![(1, 0, 1)] });
        let ticks: Vec<TickData> = (0..30).map(|_| server.step()).collect();

        let mut reference = ClientSession::new(start(), None).unwrap();
        reference.attach_feed();
        reference.on_ticks(&ticks);
        let mut want = Vec::new();
        reference.drain_confirmed(|_, _, cur| want.push(checksum(cur)));

        // predicts player 0 idle; the server holds it left from tick 0
        let mut c = ClientSession::new(start(), Some(0)).unwrap();
        c.attach_feed();
        c.advance_to(20);
        let mut predicted = Vec::new();
        c.drain_predicted(|_, _, cur| predicted.push(checksum(cur)));
        c.on_ticks(&ticks);
        assert!(c.rollbacks > 0);
        let mut got = Vec::new();
        c.drain_confirmed(|_, _, cur| got.push(checksum(cur)));
        // the rollback rewinds the predicted feed to its first tick: all 20 ticks come round again,
        // while the confirmed feed has nothing left
        let mut refed = 0;
        c.drain_predicted(|_, _, _| refed += 1);
        let mut again = 0;
        c.drain_confirmed(|_, _, _| again += 1);
        assert_eq!(predicted.len(), 20);
        assert_eq!(refed, ticks.len());
        assert_ne!(predicted, want);
        assert_eq!(got, want);
        assert_eq!(again, 0);
    }

    /// A batch that starts beyond the next tick needed is a real gap on an
    /// ordered stream; the first reason is kept.
    #[test]
    fn batch_past_known_is_a_gap() {
        let mut server = ServerMatch::new(start()).unwrap();
        let ticks: Vec<TickData> = (0..30).map(|_| server.step()).collect();
        let mut c = ClientSession::new(start(), None).unwrap();
        c.on_ticks(&ticks[0..10]);
        c.on_ticks(&ticks[15..30]);
        assert_eq!(c.desync, Some(Desync::Gap { expected: 10, got: 15 }));
        c.on_ticks(&ticks[10..30]);
        assert_eq!(c.desync, Some(Desync::Gap { expected: 10, got: 15 }));
    }

    /// A checksum that disagrees with the confirmed state reports its tick.
    #[test]
    fn checksum_mismatch_reports_tick() {
        let mut server = ServerMatch::new(start()).unwrap();
        let ticks: Vec<TickData> = (0..30).map(|_| server.step()).collect();
        let mut c = ClientSession::new(start(), None).unwrap();
        c.on_ticks(&ticks);
        assert_eq!(c.base, 30);
        c.on_checksum(30, checksum(c.confirmed_state()));
        assert_eq!(c.desync, None);
        let mut c = ClientSession::new(start(), None).unwrap();
        c.on_ticks(&ticks);
        c.on_checksum(30, checksum(c.confirmed_state()) ^ 1);
        assert_eq!(c.desync, Some(Desync::Hash { tick: 30 }));
    }

    const MAX_RESEND: usize = 32;
    const FRAME_MS: f64 = 1000.0 / 60.0;
    /// match tick rate
    const HZ: f64 = 30.0;
    /// the stats skip this much of a session, as the wasm does
    const WARMUP_MS: f64 = 3000.0;
    /// the stall pattern of the rollback tests: 60 ms busy every 700 ms
    const STALL: Stall = Stall { period: 700.0, len: 60.0, phase: 0.0 };

    /// Main-thread stalls of one client: busy for `len` ms every `period` ms from `phase`.
    #[derive(Clone, Copy)]
    struct Stall {
        period: f64,
        len: f64,
        phase: f64,
    }

    /// When a client thread that wants to run at `t` gets to run: the end of a stall covering `t`.
    fn free_at(stall: Option<Stall>, t: f64) -> f64 {
        let Some(s) = stall else { return t };
        if t < s.phase {
            return t;
        }
        let start = s.phase + ((t - s.phase) / s.period).floor() * s.period;
        if t < start + s.len { start + s.len } else { t }
    }

    /// One simulated client of [`two_peer_rollbacks`].
    struct Peer {
        session: ClientSession,
        clock: TickClock,
        stall: Option<Stall>,
        last_t: f64,
        last_sent: u32,
        sent_seq: u32,
        mask: u8,
        typing: bool,
        rng: u64,
        warm: bool,
        /// (arrival ms, input frame) on the way to the server
        to_server: VecDeque<(f64, InputFrame)>,
        /// (arrival ms, what the server sent) from the server
        to_client: VecDeque<(f64, Down)>,
    }

    /// What the server sends a client, in order on one stream.
    enum Down {
        /// a tick's confirmed data, the server's input ack and margin in ticks
        Batch(TickData, u32, f64),
        /// a change forwarded ahead of its batch: player, tick, mask
        Hint(u32, u32, u8),
    }

    enum Ev {
        Step,
        Frame(usize),
        Up(usize),
        Down(usize),
    }

    fn next_rand(s: &mut u64) -> u64 {
        *s ^= *s << 13;
        *s ^= *s >> 7;
        *s ^= *s << 17;
        *s
    }

    /// Client frame, as `nb_frame` does it: predict to `target + 1` with the
    /// local input stamped at `target`, then send the changes.
    fn frame(p: &mut Peer, t: f64, owl: f64, net: f64) {
        let dt = (t - p.last_t) / 1000.0;
        p.last_t = t;
        if p.typing && next_rand(&mut p.rng) % 30 == 0 {
            p.mask = (next_rand(&mut p.rng) % 8) as u8;
        }
        let target = p.clock.update(dt, p.session.known as f64).floor().max(0.0) as u32;
        p.session.local_input(target, p.mask);
        p.session.advance_to(target + 1);
        let newest = p.session.last_input_seq();
        if target >= p.last_sent || newest != p.sent_seq {
            let at = jittered(&mut p.rng, net, t + owl, p.to_server.back().map(|b| b.0));
            p.to_server.push_back((at, p.session.input_frame(target, MAX_RESEND)));
            p.last_sent = p.last_sent.max(target + 1);
            p.sent_seq = newest;
        }
    }

    /// Arrival `at` plus a uniform delay in `[0, jit)` ms, never before `last` (in-order delivery).
    fn jittered(rng: &mut u64, jit: f64, at: f64, last: Option<f64>) -> f64 {
        let at = at + (next_rand(rng) % 10_000) as f64 / 10_000.0 * jit;
        last.map_or(at, |l| at.max(l))
    }

    /// Two clients in one match over a link with `owl` ms one-way delay, ticks
    /// at 30 Hz, frames at 60 Hz, both starting at time 0. `net` is the uplink and
    /// downlink jitter in ms. With `stall`, each client's thread (frames and
    /// received batches) waits out its stalls. Returns peer 0's session with its
    /// depth stats after warm-up.
    fn two_peer_rollbacks(owl: f64, net: f64, typing: [bool; 2], stall: Option<Stall>, secs: f64) -> ClientSession {
        let tick_ms = 1000.0 / HZ;
        let mut server = ServerMatch::new(start()).unwrap();
        let mut peers: Vec<Peer> = (0..2usize)
            .map(|i| {
                let session = ClientSession::new(start(), Some(i as u32)).unwrap();
                let clock = TickClock::new(HZ, session.head() as f64, owl / 1000.0 * HZ + 2.0);
                Peer {
                    session,
                    clock,
                    stall: stall.map(|s| Stall { phase: s.phase + i as f64 * s.period / 2.0, ..s }),
                    last_t: 0.0,
                    last_sent: 0,
                    sent_seq: 0,
                    mask: 0,
                    typing: typing[i],
                    rng: 0x9E37_79B9_7F4A_7C15 ^ (i as u64 + 1),
                    warm: false,
                    to_server: VecDeque::new(),
                    to_client: VecDeque::new(),
                }
            })
            .collect();
        let mut margins = [0.0f64; 2];
        let mut next_step = 0.0f64;
        let mut next_frame = [0.0f64; 2];
        let end = secs * 1000.0;
        loop {
            let mut best = (next_step, Ev::Step);
            for (i, p) in peers.iter().enumerate() {
                let frame_at = free_at(p.stall, next_frame[i]);
                if frame_at < best.0 {
                    best = (frame_at, Ev::Frame(i));
                }
                if let Some(&(t, _)) = p.to_server.front() {
                    if t < best.0 {
                        best = (t, Ev::Up(i));
                    }
                }
                if let Some(&(t, ..)) = p.to_client.front() {
                    let t = free_at(p.stall, t);
                    if t < best.0 {
                        best = (t, Ev::Down(i));
                    }
                }
            }
            let (t, ev) = best;
            if t >= end {
                break;
            }
            for p in peers.iter_mut() {
                if !p.warm && t >= WARMUP_MS {
                    p.warm = true;
                    p.session.reset_depth_stats();
                }
            }
            match ev {
                Ev::Step => {
                    let data = server.step();
                    for (i, p) in peers.iter_mut().enumerate() {
                        let at = jittered(&mut p.rng, net, t + owl, p.to_client.back().map(|b| b.0));
                        p.to_client.push_back((at, Down::Batch(data.clone(), server.input_ack(i as u32), margins[i])));
                    }
                    next_step += tick_ms;
                }
                Ev::Frame(i) => {
                    frame(&mut peers[i], t, owl, net);
                    // a frame loop resumes one frame after the stall, not on a backlog
                    next_frame[i] = t + FRAME_MS;
                }
                Ev::Up(i) => {
                    let (arr, f) = peers[i].to_server.pop_front().unwrap();
                    let receipt = server.submit(i as u32, &f);
                    // the server forwards each accepted change to the other players at once
                    for &(tick, mask) in &receipt.taken {
                        for (j, q) in peers.iter_mut().enumerate() {
                            if j != i {
                                let at = jittered(&mut q.rng, net, t + owl, q.to_client.back().map(|b| b.0));
                                q.to_client.push_back((at, Down::Hint(i as u32, tick, mask)));
                            }
                        }
                    }
                    // the server's margin counts the part of its current tick already elapsed
                    let to_next = ((next_step - arr) / tick_ms).clamp(0.0, 1.0);
                    margins[i] = ((receipt.margin as f64 - (1.0 - to_next)) * 16.0).round() / 16.0;
                }
                Ev::Down(i) => {
                    let (_, msg) = peers[i].to_client.pop_front().unwrap();
                    let p = &mut peers[i];
                    match msg {
                        Down::Batch(data, ack, margin) => {
                            p.session.on_ticks(&[data]);
                            p.session.input_ack(ack);
                            p.clock.on_margin(margin);
                        }
                        Down::Hint(player, tick, mask) => p.session.on_hint(player, tick, mask),
                    }
                }
            }
        }
        peers.swap_remove(0).session
    }

    /// The depth percentile is nearest-rank over the counted depths and restarts on reset.
    #[test]
    fn depth_percentile_counts_recorded_depths() {
        let mut c = ClientSession::new(start(), None).unwrap();
        c.depth_hist[1] = 90;
        c.depth_hist[3] = 4;
        c.depth_hist[8] = 6;
        assert_eq!(c.rollback_depth_pct(50), 1);
        assert_eq!(c.rollback_depth_pct(95), 8);
        c.reset_depth_stats();
        assert_eq!(c.rollback_depth_pct(95), 0);
    }

    /// The spread is the median excess over the minimum: excess spread over 0..40 gives about 21.
    #[test]
    fn spread_is_median_excess_over_min() {
        let mut s = Spread::default();
        for i in 0..SPREAD_SAMPLES {
            s.push(100.0 + i as f64 * 40.0 / (SPREAD_SAMPLES - 1) as f64);
        }
        let v = s.get();
        assert!((v - 21.3).abs() < 1.0, "spread {v}");
    }

    /// One late sample among steady ones does not move the spread.
    #[test]
    fn single_outlier_leaves_spread_unchanged() {
        let mut s = Spread::default();
        for i in 0..SPREAD_SAMPLES {
            s.push(if i == 3 { 50.0 } else { 2.0 });
        }
        assert_eq!(s.get(), 0.0);
    }

    /// Steady input margins want the minimum lead of one tick.
    #[test]
    fn steady_margin_wants_minimum_lead() {
        let mut c = TickClock::new(HZ, 0.0, 0.0);
        for _ in 0..SPREAD_SAMPLES {
            c.on_margin(2.0);
        }
        assert_eq!(c.target_margin, 1.0);
    }

    /// A local clock step, forward or back, resyncs to the server's tick at the target lead in one update.
    #[test]
    fn clock_step_resyncs_in_one_update() {
        for step in [3.0, -3.0] {
            let mut c = TickClock::new(HZ, 0.0, 0.0);
            c.on_margin(2.0);
            let t = c.update(step, 100.0);
            assert_eq!(t, 100.0 + c.target_margin);
        }
    }

    /// Ordinary frames still advance the clock.
    #[test]
    fn ordinary_frames_advance_clock() {
        let mut c = TickClock::new(HZ, 100.0, 0.0);
        let t = c.update(0.1, 100.0);
        assert!((t - (100.0 + 0.1 * HZ)).abs() < 1e-9);
    }

    /// Margins alternating between 0 and 2 ticks (spread 2) ask for 1 + 2 * 2 = 5 ticks of lead.
    #[test]
    fn margin_spread_sets_target() {
        let mut c = TickClock::new(HZ, 0.0, 0.0);
        for i in 0..SPREAD_SAMPLES {
            c.on_margin(if i % 2 == 0 { 0.0 } else { 2.0 });
        }
        assert_eq!(c.target_margin, 5.0);
    }

    /// Rollback depth p95 at 100 ms RTT stays within 8 ticks on a clean link, with
    /// main-thread stalls, and with uplink and downlink jitter.
    #[test]
    fn rtt100_rollback_depth_p95_within_budget() {
        let cases = [("clean", 0.0, None), ("stall", 0.0, Some(STALL)), ("net25", 25.0, None)];
        for (label, net, stall) in cases {
            let s = two_peer_rollbacks(50.0, net, [true, true], stall, 60.0);
            let (p50, p95) = (s.rollback_depth_pct(50), s.rollback_depth_pct(95));
            eprintln!("{label}: p50 {p50} p95 {p95}");
            assert!(p95 <= 8, "{label}: p95 {p95} (p50 {p50})");
        }
    }

    /// Two players on one flat floor, one unit apart, neither on a team: the bat reaches the other.
    fn flat_start() -> MatchStart {
        let map = serde_json::json!({
            "b": [{ "1": 0, "14": 0, "s": [{ "p": [-30.0, 10.0, 30.0, 10.0, 30.0, 12.0, -30.0, 12.0] }] }],
            "j": [],
            "s": [{ "1": 10.0, "2": 9.0, "5": true }, { "1": 11.0, "2": 9.0, "5": true }],
            "set": { "15": 60.0, "16": 30.0, "18": 15.0 }
        });
        MatchStart {
            seed: 3,
            start_tick: 0,
            tick_hz: 30.0,
            players: vec![(0, 1.0), (1, 1.0)],
            settings: GameSettings::default(),
            maps: vec![MapData::from_json(&map).unwrap().to_code()],
            intro: false,
            rotation: false,
        }
    }

    /// Bat hits `cur` records after `prev`: (tick, swinger, victim kind, victim index).
    fn bat_hits_between(tick: u32, prev: &State, cur: &State) -> Vec<(u32, u32, u32, u32)> {
        let mut out = Vec::new();
        for (id, p) in cur.players.iter() {
            let before = prev.players.get(id).map_or(0, |pp| pp.bat_hits.len());
            let from = if p.bat_hits.len() >= before { before } else { 0 };
            for pair in p.bat_hits[from..].chunks_exact(2) {
                out.push((tick, id as u32, pair[0] as u32, pair[1] as u32));
            }
        }
        out
    }

    /// Player 0 is local: it predicts holding the bat over `predict`, while the server hears it
    /// hold `sent`, and the confirmations reach the client `lag` ticks late. Returns the bat hits
    /// of the predicted stream and of the confirmed stream.
    fn swing_streams(who: u32, predict: std::ops::Range<u32>, sent: std::ops::Range<u32>, lag: usize) -> (Vec<(u32, u32, u32, u32)>, Vec<(u32, u32, u32, u32)>) {
        const TICKS: u32 = 70;
        let mut server = ServerMatch::new(flat_start()).unwrap();
        let mut c = ClientSession::new(flat_start(), Some(0)).unwrap();
        c.attach_feed();
        let (mut predicted, mut confirmed) = (Vec::new(), Vec::new());
        let mut fed = FedKeys::default();
        let mut in_flight = VecDeque::new();
        for t in 0..TICKS {
            let bat = |r: &std::ops::Range<u32>| if r.contains(&t) { BAT } else { 0 };
            c.local_input(t, if who == 0 { bat(&predict) } else { 0 });
            c.advance_to(t + 1);
            c.drain_predicted(|tick, prev, cur| {
                for h in bat_hits_between(tick, prev, cur) {
                    if fed.first(h.0, (h.1, h.2, h.3)) {
                        predicted.push(h);
                    }
                }
            });
            server.submit(who, &InputFrame { ack: 0, now: t, changes: vec![(t + 1, t, bat(&sent))] });
            in_flight.push_back(server.step());
            if in_flight.len() > lag {
                c.on_ticks(&[in_flight.pop_front().unwrap()]);
                c.drain_confirmed(|tick, prev, cur| confirmed.extend(bat_hits_between(tick, prev, cur)));
            }
        }
        for d in in_flight {
            c.on_ticks(&[d]);
        }
        c.drain_confirmed(|tick, prev, cur| confirmed.extend(bat_hits_between(tick, prev, cur)));
        (predicted, confirmed)
    }

    /// A predicted bat hit on the remote player reaches the predicted stream once; once the server
    /// confirms it, the same hit reaches the confirmed stream once, at the same tick.
    #[test]
    fn predicted_bat_hit_feeds_once_and_confirms_once() {
        let (predicted, confirmed) = swing_streams(0, 40..49, 40..49, 3);
        assert_eq!(predicted.len(), 1, "one predicted hit: {predicted:?}");
        assert_eq!((predicted[0].1, predicted[0].2, predicted[0].3), (0, kind::PLAYER as u32, 1));
        assert_eq!(confirmed, predicted);
    }

    /// A remote player's swing at the local player: the client learns it only from confirmations, so the
    /// hit lands in ticks the client already predicted; it must still reach the predicted stream once.
    #[test]
    fn remote_swing_hit_feeds_predicted_once() {
        let (predicted, confirmed) = swing_streams(1, 40..49, 40..49, 3);
        eprintln!("remote predicted {predicted:?}\nremote confirmed {confirmed:?}");
        assert_eq!(confirmed.len(), 1, "one confirmed hit: {confirmed:?}");
        assert_eq!(predicted.len(), 1, "one predicted hit: {predicted:?}");
        assert_eq!(predicted, confirmed);
    }

    /// A hit predicted from a swing the server never received may show, at most once, in the predicted
    /// stream, and never reaches the confirmed stream.
    #[test]
    fn mispredicted_bat_hit_never_confirms() {
        let (predicted, confirmed) = swing_streams(0, 40..49, 0..0, 3);
        assert!(predicted.len() <= 1, "a predicted hit shows at most once: {predicted:?}");
        assert!(confirmed.is_empty(), "the server saw no swing: {confirmed:?}");
    }
}
