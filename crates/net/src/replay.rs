//! Match recordings. The simulation is deterministic, so a match is fully
//! described by its start parameters and the confirmed inputs and events of
//! every tick: a few bytes per tick instead of video. Players record on
//! their own client (they receive every confirmed tick anyway) and watch
//! recordings with [`ReplayPlayer`].

use crate::protocol::{DecodeError, MatchStart, Reader, TickData, TickEvent, Writer};
use crate::timeline::{decode_state, load_maps, to_events, InputLog, MatchError};
use base64::Engine;
use neobox_sim::{advance, match_start, GameSettings, Sim, State};
use serde::{Deserialize, Serialize};

pub const REPLAY_VERSION: u32 = 1;
/// Ticks between the states [`ReplayPlayer`] keeps for seeking backwards.
pub const KEYFRAME_INTERVAL: u32 = 300;
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
        if r.version != REPLAY_VERSION {
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
        let mut events = Vec::with_capacity(ticks.len());
        for t in &ticks {
            for &(p, m) in &t.changes {
                inputs.record(p, t.tick, m);
            }
            events.push(t.events.clone());
        }
        Ok(ReplayPlayer {
            end: first + ticks.len() as u32,
            replay,
            sim: Sim::new(),
            gs,
            maps,
            inputs,
            events,
            first,
            keyframes: vec![(first, state.clone())],
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
        if (self.tick - self.first) % KEYFRAME_INTERVAL == 0 && self.keyframes.last().is_some_and(|k| k.0 < self.tick) {
            self.keyframes.push((self.tick, self.state.clone()));
        }
        true
    }

    /// Move to the state at `tick` (clamped to the recording).
    pub fn seek(&mut self, tick: u32) {
        let tick = tick.clamp(self.first, self.end);
        if tick < self.tick || tick - self.tick > KEYFRAME_INTERVAL {
            // nearest known keyframe at or before the target
            let k = match self.keyframes.binary_search_by_key(&tick, |k| k.0) {
                Ok(i) => i,
                Err(i) => i - 1,
            };
            if self.keyframes[k].0 > self.tick || tick < self.tick {
                let (t, s) = &self.keyframes[k];
                self.tick = *t;
                self.state = s.clone();
                self.prev = s.clone();
            }
        }
        while self.tick < tick {
            self.step();
        }
    }
}
