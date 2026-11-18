//! The gameplay instrument's hit schedule (client/qa/gameplay.mjs hitbox case) on the hitbox fixture:
//! one swinger per round, alternating, so each round lands exactly one hit whatever the browsers' press
//! stagger. The schedule must land `ROUNDS` hits, each credited to the round's swinger, with the victim
//! as the other player.
use neobox_net::{InputFrame, MatchStart, ServerMatch};
use neobox_sim::input::BAT;
use neobox_sim::settings::mode;
use neobox_sim::{GameSettings, MapData};
use serde_json::{json, Value};

const ROUNDS: usize = 10;
/// Ticks per round. A victim dies at its hit (press + 13) and respawns 60 ticks later (sim
/// round::respawn_in), and must be past SPAWN_GRACE (27) when hit. The schedule lands 10/10 for every
/// period 100..=150; 90 fails.
const ROUND_TICKS: usize = 120;
/// The first swing waits out spawn grace and the first respawn.
const FIRST_SWING: usize = 90;
/// BAT held this many ticks: the bat fires at tick 13 after the press.
const HOLD: usize = 18;

/// The hitbox fixture (client/qa/gameplay.mjs FIXTURE_MAP): a flat platform, players side by side.
fn fixture() -> Value {
    json!({
        "b": [{ "1": 0, "2": 20, "3": 21, "s": [{ "7": 3754574, "p": [-6, -0.5, 6, -0.5, 6, 0.5, -6, 0.5] }] }],
        "j": [],
        "s": [{ "1": 19, "2": 19.5 }, { "1": 21, "2": 19.5 }],
        "p": [], "tu": [], "tc": [], "gp": [], "c": [],
        "set": { "3": 40, "15": 40, "16": 25 }
    })
}

fn start() -> MatchStart {
    MatchStart {
        seed: 1,
        start_tick: 0,
        tick_hz: 30.0,
        players: vec![(0, 1.0), (1, 1.0)],
        settings: GameSettings { game_mode: mode::KILLS, objective_limit: 99.0, ..GameSettings::default() },
        maps: vec![MapData::from_json(&fixture()).unwrap().to_code()],
        intro: false,
        rotation: false,
    }
}

/// Per-player mask timelines: round `i` is swung by player `i % 2`, `ROUND_TICKS` after the last.
fn schedule() -> [Vec<u8>; 2] {
    let len = FIRST_SWING + ROUNDS * ROUND_TICKS;
    let mut masks = [vec![0u8; len], vec![0u8; len]];
    for i in 0..ROUNDS {
        let at = FIRST_SWING + i * ROUND_TICKS;
        masks[i % 2][at..at + HOLD].fill(BAT);
    }
    masks
}

/// Runs the schedule; returns (swinger, victim) for each landed hit, in order.
fn run() -> Vec<(u32, u32)> {
    let mut server = ServerMatch::new(start()).unwrap();
    let masks = schedule();
    let mut hits = Vec::new();
    let mut seen = [0usize; 2];
    for _ in 0..masks[0].len() + ROUND_TICKS {
        for p in 0..2u32 {
            let mask = masks[p as usize].get(server.tick as usize).copied().unwrap_or(0);
            let frame = InputFrame { ack: 0, now: server.tick, changes: vec![(server.input_ack(p) + 1, server.tick, mask)] };
            server.submit(p, &frame);
        }
        server.step();
        for (id, pl) in server.state.players.iter() {
            let i = id as usize;
            let len = pl.bat_hits.len();
            // bat_hits grows during a swing and is cleared when the swing resets
            let from = if len >= seen[i] { seen[i] } else { 0 };
            for pair in pl.bat_hits[from..].chunks_exact(2) {
                hits.push((id, pair[1] as u32));
            }
            seen[i] = len;
        }
    }
    hits
}

#[test]
fn one_swinger_per_round_lands_one_hit_each() {
    let hits = run();
    assert_eq!(hits.len(), ROUNDS, "one hit per round, got {hits:?}");
    for (i, &(by, victim)) in hits.iter().enumerate() {
        assert_eq!(by as usize, i % 2, "round {i} is swung by player {}", i % 2);
        assert_eq!(victim as usize, 1 - i % 2, "round {i} hits the other player");
    }
}
