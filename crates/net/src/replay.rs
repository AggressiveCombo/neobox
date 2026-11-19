//! Match recordings. The simulation is deterministic, so a match is fully
//! described by its start parameters and the confirmed inputs and events of
//! every tick: a few bytes per tick instead of video. Players record on
//! their own client (they receive every confirmed tick anyway) and watch
//! recordings with [`ReplayPlayer`].

use crate::protocol::{DecodeError, MatchStart, Reader, TickData, TickEvent, Writer};
use crate::timeline::{decode_state, encode_state, load_maps, to_events, InputLog, MatchError};
use base64::Engine;
use neobox_sim::{advance, match_start, GameSettings, Sim, State};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 2: map bodies carry the race fields (snapshots of version 1 no longer
/// decode; version-1 recordings from a match start still play).
pub const REPLAY_VERSION: u32 = 2;
/// Ticks between the states [`ReplayPlayer`] keeps for seeking; built as playback passes them or by [`ReplayPlayer::build_keyframes`].
pub const KEYFRAME_INTERVAL: u32 = 60;
/// Longest accepted recording (ticks): 10 hours at 30 Hz.
pub const MAX_REPLAY_TICKS: usize = 30 * 60 * 60 * 10;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// A recorded match (serialised as JSON; files are usually gzip-compressed).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Replay {
    pub version: u32,
    pub start: MatchStart,
    /// Player names at recording time (id, name), for display.
    pub names: Vec<(u32, String)>,
    /// Tick of the first recorded state.
    pub first_tick: u32,
    /// When recording began mid-match (late join): the compressed state at
    /// `first_tick` (base64). `None`: the match's start state.
    pub snapshot: Option<String>,
    /// With `snapshot`: input masks players held at `first_tick` (player, mask).
    #[serde(default)]
    pub held: Vec<(u32, u8)>,
    /// Confirmed ticks from `first_tick` on ([`encode_ticks`], base64).
    pub ticks: String,
}

impl Replay {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn from_json(text: &[u8]) -> Result<Replay, ReplayError> {
        let r: Replay = serde_json::from_slice(text).map_err(|e| ReplayError::Format(e.to_string()))?;
        // a version-1 recording without a snapshot holds no encoded state
        if r.version != REPLAY_VERSION && !(r.version == 1 && r.snapshot.is_none()) {
            return Err(ReplayError::Version(r.version));
        }
        Ok(r)
    }

    /// The recorded ticks.
    pub fn decode_ticks(&self) -> Result<Vec<TickData>, ReplayError> {
        let bytes = B64.decode(&self.ticks).map_err(|_| ReplayError::Format("ticks are not base64".into()))?;
        decode_ticks(&bytes, self.first_tick).map_err(|_| ReplayError::Format("bad tick data".into()))
    }
}

#[derive(Debug)]
pub enum ReplayError {
    Format(String),
    Version(u32),
    Match(MatchError),
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReplayError::Format(e) => write!(f, "not a neobox replay: {e}"),
            ReplayError::Version(v) => write!(f, "replay format {v} is not supported by this version of neobox"),
            ReplayError::Match(e) => write!(f, "replay cannot be played: {e}"),
        }
    }
}
impl std::error::Error for ReplayError {}

/// Consecutive ticks in a compact binary form (count, then per tick the
/// input changes and join/leave events, as in a server batch).
pub fn encode_ticks(ticks: &[TickData]) -> Vec<u8> {
    let mut w = Writer::default();
    w.var(ticks.len() as u64);
    for t in ticks {
        w.var(t.changes.len() as u64);
        for (p, m) in &t.changes {
            w.var(*p as u64);
            w.u8(*m);
        }
        w.var(t.events.len() as u64);
        for e in &t.events {
            match e {
                TickEvent::Leave(p) => {
                    w.u8(0);
                    w.var(*p as u64);
                }
                TickEvent::Join(p, team) => {
                    w.u8(1);
                    w.var(*p as u64);
                    w.f64(*team);
                }
            }
        }
    }
    w.buf
}

pub fn decode_ticks(b: &[u8], first: u32) -> Result<Vec<TickData>, DecodeError> {
    let mut r = Reader::new(b);
    let n = r.var()? as usize;
    if n > MAX_REPLAY_TICKS {
        return Err(DecodeError);
    }
    let mut ticks = Vec::with_capacity(n);
    for i in 0..n {
        let nc = r.var()? as usize;
        if nc > 4096 {
            return Err(DecodeError);
        }
        let mut changes = Vec::with_capacity(nc);
        for _ in 0..nc {
            changes.push((r.var32()?, r.u8()?));
        }
        let ne = r.var()? as usize;
        if ne > 4096 {
            return Err(DecodeError);
        }
        let mut events = Vec::with_capacity(ne);
        for _ in 0..ne {
            events.push(match r.u8()? {
                0 => TickEvent::Leave(r.var32()?),
                1 => TickEvent::Join(r.var32()?, r.f64()?),
                _ => return Err(DecodeError),
            });
        }
        ticks.push(TickData { tick: first + i as u32, changes, events });
    }
    if !r.done() {
        return Err(DecodeError);
    }
    Ok(ticks)
}

/// Collects a match's confirmed ticks as they arrive (in order, duplicates
/// and anything after a gap ignored).
#[derive(Clone, Debug)]
pub struct ReplayRecorder {
    start: MatchStart,
    first_tick: u32,
    snapshot: Option<Vec<u8>>,
    held: Vec<(u32, u8)>,
    ticks: Vec<TickData>,
}

impl ReplayRecorder {
    /// Recording from the match start, or from a late-join snapshot
    /// (tick, compressed state, held masks).
    pub fn new(start: MatchStart, snapshot: Option<(u32, Vec<u8>, Vec<(u32, u8)>)>) -> ReplayRecorder {
        let (first_tick, snapshot, held) = match snapshot {
            Some((t, s, h)) => (t, Some(s), h),
            None => (start.start_tick, None, Vec::new()),
        };
        ReplayRecorder { start, first_tick, snapshot, held, ticks: Vec::new() }
    }

    /// The match this recording belongs to.
    pub fn start(&self) -> &MatchStart {
        &self.start
    }

    /// Tick of the next confirmed tick the recording expects.
    pub fn next_tick(&self) -> u32 {
        self.first_tick + self.ticks.len() as u32
    }

    pub fn push(&mut self, ticks: &[TickData]) {
        for t in ticks {
            let next = self.first_tick + self.ticks.len() as u32;
            if t.tick == next && self.ticks.len() < MAX_REPLAY_TICKS {
                self.ticks.push(t.clone());
            }
        }
    }

    /// Number of recorded ticks.
    pub fn len(&self) -> usize {
        self.ticks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ticks.is_empty()
    }

    pub fn finish(&self, names: Vec<(u32, String)>) -> Replay {
        Replay {
            version: REPLAY_VERSION,
            start: self.start.clone(),
            names,
            first_tick: self.first_tick,
            snapshot: self.snapshot.as_ref().map(|s| B64.encode(s)),
            held: self.held.clone(),
            ticks: B64.encode(encode_ticks(&self.ticks)),
        }
    }
}

/// Plays a recording: steps forward tick by tick and seeks anywhere
/// (backwards through keyframes kept every [`KEYFRAME_INTERVAL`] ticks).
pub struct ReplayPlayer {
    pub replay: Replay,
    sim: Sim,
    gs: GameSettings,
    maps: Vec<State>,
    inputs: InputLog,
    /// events per tick, index = tick - first
    events: Vec<Vec<TickEvent>>,
    first: u32,
    end: u32,
    /// (tick, state) every KEYFRAME_INTERVAL ticks from `first`, filled as
    /// playback passes them
    keyframes: Vec<(u32, State)>,
    /// where [`ReplayPlayer::build_keyframes`] stopped: (tick, state), kept between slices
    build: Option<(u32, State)>,
    tick: u32,
    prev: State,
    state: State,
    scratch: Vec<u8>,
}

impl ReplayPlayer {
    pub fn new(replay: Replay) -> Result<ReplayPlayer, ReplayError> {
        let ticks = replay.decode_ticks()?;
        let maps = load_maps(&replay.start).map_err(ReplayError::Match)?;
        let gs = replay.start.settings.clone();
        let state = match &replay.snapshot {
            Some(s) => {
                let bytes = B64.decode(s).map_err(|_| ReplayError::Format("snapshot is not base64".into()))?;
                decode_state(&bytes).map_err(ReplayError::Match)?
            }
            None => match_start(&maps[0], replay.start.seed, &replay.start.players, &gs, replay.start.intro, replay.start.rotation),
        };
        let first = replay.first_tick;
        let mut inputs = InputLog::default();
        for &(p, m) in &replay.held {
            inputs.record(p, first.saturating_sub(1), m);
        }
        let count = ticks.len() as u32;
        let mut events = Vec::with_capacity(ticks.len());
        for t in ticks {
            for &(p, m) in &t.changes {
                inputs.record(p, t.tick, m);
            }
            events.push(t.events);
        }
        Ok(ReplayPlayer {
            end: first + count,
            replay,
            sim: Sim::new(),
            gs,
            maps,
            inputs,
            events,
            first,
            keyframes: vec![(first, state.clone())],
            build: None,
            tick: first,
            prev: state.clone(),
            state,
            scratch: Vec::new(),
        })
    }

    /// First and one-past-last playable tick (the state at `end_tick` is the last one).
    pub fn first_tick(&self) -> u32 {
        self.first
    }

    pub fn end_tick(&self) -> u32 {
        self.end
    }

    /// Tick of the current state.
    pub fn tick(&self) -> u32 {
        self.tick
    }

    /// The previous and the current state (for interpolation).
    pub fn states(&self) -> (&State, &State) {
        (&self.prev, &self.state)
    }

    pub fn settings(&self) -> &GameSettings {
        &self.gs
    }

    /// Advance one tick; false at the end of the recording.
    pub fn step(&mut self) -> bool {
        if self.tick >= self.end {
            return false;
        }
        let i = (self.tick - self.first) as usize;
        self.inputs.masks_at(self.tick, &mut self.scratch);
        let evs = to_events(&self.events[i]);
        let (next, _) = advance(&mut self.sim, &self.state, &self.scratch, evs.as_ref(), &self.gs, &self.maps);
        self.prev = std::mem::replace(&mut self.state, next);
        self.tick += 1;
        // keep the chain contiguous: a keyframe only where the last one is one interval back
        if self.keyframes.last().is_some_and(|k| k.0 + KEYFRAME_INTERVAL == self.tick) {
            self.keyframes.push((self.tick, self.state.clone()));
        }
        true
    }

    /// Move to the state at `tick` (clamped to the recording). Restores the nearest
    /// keyframe before `tick - 1` when that saves stepping, then steps; afterwards
    /// `states()` holds the states at `tick - 1` and `tick` (the interpolation pair).
    pub fn seek(&mut self, tick: u32) {
        let tick = tick.clamp(self.first, self.end);
        let before = tick.saturating_sub(1).max(self.first);
        let k = self.keyframes.partition_point(|k| k.0 <= before) - 1;
        let (kt, ks) = &self.keyframes[k];
        if tick < self.tick || *kt > self.tick {
            self.tick = *kt;
            self.state = ks.clone();
            self.prev = ks.clone();
        }
        while self.tick < tick {
            self.step();
        }
    }

    /// Simulate up to `max_ticks` more ticks past the last keyframe, keeping one every
    /// [`KEYFRAME_INTERVAL`]. The position is kept between calls, so a slice may be shorter
    /// than an interval. Returns true once the whole recording has keyframes.
    /// Meant for idle time after loading, so seeks step at most one interval.
    pub fn build_keyframes(&mut self, max_ticks: u32) -> bool {
        let last = self.keyframes.len() - 1;
        let (mut tick, mut state) = match self.build.take() {
            Some(c) if c.0 >= self.keyframes[last].0 => c,
            _ => (self.keyframes[last].0, self.keyframes[last].1.clone()),
        };
        let mut budget = max_ticks;
        while tick < self.end && budget > 0 {
            let i = (tick - self.first) as usize;
            self.inputs.masks_at(tick, &mut self.scratch);
            let evs = to_events(&self.events[i]);
            let (next, _) = advance(&mut self.sim, &state, &self.scratch, evs.as_ref(), &self.gs, &self.maps);
            state = next;
            tick += 1;
            budget -= 1;
            if (tick - self.first) % KEYFRAME_INTERVAL == 0 {
                self.keyframes.push((tick, state.clone()));
            }
        }
        if tick < self.end {
            self.build = Some((tick, state));
        }
        tick >= self.end
    }
}

/// The last `max_ticks` ticks of `source` as a recording that starts from a
/// state snapshot, so it plays back exactly as the match did over that span.
pub fn clip(source: &Replay, max_ticks: u32) -> Result<Replay, ReplayError> {
    let mut player = ReplayPlayer::new(source.clone())?;
    let from = player.end_tick().saturating_sub(max_ticks).max(player.first_tick());
    player.seek(from);
    let snapshot = encode_state(player.states().1);
    // the masks in effect just before `from`: the source's held masks, then
    // every change made before it, in order
    let mut held: BTreeMap<u32, u8> = source.held.iter().copied().collect();
    let ticks = source.decode_ticks()?;
    for t in ticks.iter().take_while(|t| t.tick < from) {
        for &(p, m) in &t.changes {
            held.insert(p, m);
        }
    }
    let held: Vec<(u32, u8)> = held.into_iter().filter(|e| e.1 != 0).collect();
    let mut recorder = ReplayRecorder::new(source.start.clone(), Some((from, snapshot, held)));
    recorder.push(&ticks);
    Ok(recorder.finish(source.names.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::InputFrame;
    use crate::timeline::{ServerMatch, checksum};
    use neobox_sim::MapData;

    fn start() -> MatchStart {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../maps/01-proving-grounds.json");
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let code = MapData::from_json(&json["map"]).unwrap().to_code();
        MatchStart {
            seed: 9,
            start_tick: 0,
            tick_hz: 30.0,
            players: vec![(0, 1.0), (1, 1.0)],
            settings: GameSettings::default(),
            maps: vec![code],
            intro: false,
            rotation: false,
        }
    }

    #[test]
    fn clip_plays_back_like_the_source_match() {
        let start = start();
        let mut server = ServerMatch::new(start.clone()).unwrap();
        let mut recorder = ReplayRecorder::new(start, None);
        let mut hashes = vec![checksum(&server.state)];
        let mut rng = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..600 {
            for p in 0..2u32 {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                if rng % 5 == 0 {
                    let frame = InputFrame { ack: 0, now: server.tick, changes: vec![(server.input_ack(p) + 1, server.tick, (rng >> 8) as u8)] };
                    server.submit(p, &frame);
                }
            }
            recorder.push(&[server.step()]);
            hashes.push(checksum(&server.state));
        }
        let source = Replay::from_json(recorder.finish(vec![(0, "a".to_string())]).to_json().as_bytes()).unwrap();

        // the last 150 ticks: they start from a snapshot with the held masks
        let c = Replay::from_json(clip(&source, 150).unwrap().to_json().as_bytes()).unwrap();
        let mut player = ReplayPlayer::new(c).unwrap();
        assert_eq!((player.first_tick(), player.end_tick()), (450, 600));
        assert_eq!(checksum(player.states().1), hashes[450]);
        while player.step() {
            assert_eq!(checksum(player.states().1), hashes[player.tick() as usize], "tick {}", player.tick());
        }
        player.seek(455);
        assert_eq!(checksum(player.states().1), hashes[455]);

        // longer than the recording: the whole match
        let c = clip(&source, 10_000).unwrap();
        let mut player = ReplayPlayer::new(c).unwrap();
        assert_eq!((player.first_tick(), player.end_tick()), (0, 600));
        player.seek(600);
        assert_eq!(checksum(player.states().1), hashes[600]);
    }

    #[test]
    fn seek_lands_on_the_stepped_state() {
        let start = start();
        let mut server = ServerMatch::new(start.clone()).unwrap();
        let mut recorder = ReplayRecorder::new(start, None);
        let mut hashes = vec![checksum(&server.state)];
        let mut rng = 0x2545_f491_4f6c_dd1du64;
        for _ in 0..900 {
            for p in 0..2u32 {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                if rng % 5 == 0 {
                    let frame = InputFrame { ack: 0, now: server.tick, changes: vec![(server.input_ack(p) + 1, server.tick, (rng >> 8) as u8)] };
                    server.submit(p, &frame);
                }
            }
            recorder.push(&[server.step()]);
            hashes.push(checksum(&server.state));
        }
        let source = Replay::from_json(recorder.finish(vec![(0, "a".to_string())]).to_json().as_bytes()).unwrap();

        // forward, backward, onto a keyframe, the end, and the first tick; keyframes built in the background before the third
        let mut player = ReplayPlayer::new(source.clone()).unwrap();
        for (n, target) in [430u32, 61, 300, 899, 1].into_iter().enumerate() {
            if n == 2 {
                while !player.build_keyframes(100) {}
            }
            player.seek(target);
            let seeked = checksum(player.states().1);
            let seeked_prev = checksum(player.states().0);
            let mut stepped = ReplayPlayer::new(source.clone()).unwrap();
            while stepped.tick() < target {
                stepped.step();
            }
            let stepped_now = checksum(stepped.states().1);
            eprintln!("seek tick {target}: seek {seeked:016x} stepped-from-zero {stepped_now:016x}");
            assert_eq!(seeked, stepped_now, "tick {target}");
            assert_eq!(seeked, hashes[target as usize], "tick {target} vs server");
            assert_eq!(seeked_prev, checksum(stepped.states().0), "prev of tick {target}");
        }
    }
}
