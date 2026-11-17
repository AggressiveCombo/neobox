//! Gameplay determinism: one scripted input log, run twice through `advance`,
//! gives the same KO order and final scores. Two players walk toward a pit in
//! Lives mode (objectiveLimit 2); falling onto the kill body below is the KO.

use neobox_sim::input::{BAT, LEFT, RIGHT, UP};
use neobox_sim::settings::mode;
use neobox_sim::{advance, match_start, GameSettings, MapData, Outcome, Sim, State};
use serde_json::{json, Value};

const SEED: u32 = 7;
const MAX_TICKS: u32 = 3000;

/// Two platforms with a 4-unit pit between them; a kill body lies below the pit.
/// Spawns sit above the platforms (y grows downward).
fn pit_map() -> Value {
    json!({
        "b": [
            { "1": 0, "14": 0, "s": [
                { "p": [-12.0, 10.0, -2.0, 10.0, -2.0, 11.0, -12.0, 11.0] },
                { "p": [2.0, 10.0, 12.0, 10.0, 12.0, 11.0, 2.0, 11.0] }
            ] },
            { "1": 1, "13": true, "14": 0, "s": [
                { "p": [-40.0, 20.0, 40.0, 20.0, 40.0, 21.0, -40.0, 21.0] }
            ] }
        ],
        "j": [],
        "s": [ { "1": -6.0, "2": 9.0, "5": true }, { "1": 6.0, "2": 9.0, "5": true } ],
        "set": { "15": 60.0, "16": 30.0, "18": 15.0 }
    })
}

fn settings() -> GameSettings {
    GameSettings { game_mode: mode::LIVES, objective_limit: 2.0, ..GameSettings::default() }
}

/// The recorded input log: walk into the pit for 240 ticks, then a fixed
/// pseudo-random mix of walks, jumps and bat swings in 8-tick blocks.
fn script(player: usize, tick: u32) -> u8 {
    if tick < 240 {
        return if player == 0 { RIGHT } else { LEFT };
    }
    let mut h = (u64::from(tick / 8) << 8 | player as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^= h >> 31;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 29;
    const PICKS: [u8; 8] = [0, LEFT, RIGHT, UP, LEFT | UP, RIGHT | UP, BAT, RIGHT | BAT];
    PICKS[(h >> 40) as usize % PICKS.len()]
}

#[derive(Debug, PartialEq)]
struct Log {
    /// (tick, player, lives left, elimination order) for every life lost
    kos: Vec<(u32, u32, f64, f64)>,
    /// (player, kills, lives left, elimination order) at the end
    scores: Vec<(u32, f64, f64, f64)>,
    outcome: Outcome,
    end_tick: u32,
    final_state: String,
}

fn run() -> Log {
    let lobby = State::from_map(&MapData::from_json(&pit_map()).expect("valid map"));
    let gs = settings();
    let mut state = match_start(&lobby, SEED, &[(0, 1.0), (1, 1.0)], &gs, false, false);
    let mut sim = Sim::new();
    let mut kos = Vec::new();
    let mut outcome = Outcome::Running;
    let mut tick = 0;
    while tick < MAX_TICKS {
        let masks = [script(0, tick), script(1, tick)];
        let (next, o) = advance(&mut sim, &state, &masks, None, &gs, std::slice::from_ref(&lobby));
        tick += 1;
        for (id, r) in next.round.players.iter() {
            if let Some(prev) = state.round.players.get(id) {
                if r.lives < prev.lives {
                    kos.push((tick, id, r.lives, r.eliminated));
                }
            }
        }
        state = next;
        outcome = o;
        if o == Outcome::MatchOver {
            break;
        }
    }
    let scores = state
        .round
        .players
        .iter()
        .map(|(id, r)| (id, r.kills, r.lives, r.eliminated))
        .collect();
    Log { kos, scores, outcome, end_tick: tick, final_state: format!("{state:?}") }
}

#[test]
fn same_input_log_gives_the_same_ko_order_and_scores() {
    let a = run();
    let b = run();
    assert!(a.kos.len() >= 2, "the pit should KO players, got {:?}", a.kos);
    assert_eq!(a.kos, b.kos, "KO order differs between runs");
    assert_eq!(a.scores, b.scores, "final scores differ between runs");
    assert_eq!(a.outcome, b.outcome);
    assert_eq!(a.end_tick, b.end_tick);
    assert_eq!(a.final_state, b.final_state, "final states differ between runs");
}
