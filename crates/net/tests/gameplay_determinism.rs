//! The recorded-input replay path reproduces the pit-map gameplay log: the same
//! scripted input, run through the authoritative server and recorded, plays
//! back tick-for-tick and yields the same KO order and final scores; two server
//! runs of the log agree.

use neobox_net::{checksum, InputFrame, MatchStart, Replay, ReplayPlayer, ReplayRecorder, ServerMatch};
use neobox_sim::input::{BAT, LEFT, RIGHT, UP};
use neobox_sim::settings::mode;
use neobox_sim::{GameSettings, MapData, State};
use serde_json::{json, Value};

const TICKS: u32 = 1200;

/// Two platforms with a pit between them; a kill body lies below the pit.
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

fn start() -> MatchStart {
    MatchStart {
        seed: 7,
        start_tick: 0,
        tick_hz: 30.0,
        players: vec![(0, 1.0), (1, 1.0)],
        settings: GameSettings { game_mode: mode::LIVES, objective_limit: 2.0, ..GameSettings::default() },
        maps: vec![MapData::from_json(&pit_map()).unwrap().to_code()],
        intro: false,
        rotation: false,
    }
}

/// Same recorded log as `neobox-sim/tests/gameplay_determinism.rs`.
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

type Ko = (u32, u32, f64, f64);

/// (tick, player, lives left, elimination order) for every life lost.
fn kos(states: &[State]) -> Vec<Ko> {
    let mut out = Vec::new();
    for (t, pair) in states.windows(2).enumerate() {
        for (id, r) in pair[1].round.players.iter() {
            if let Some(prev) = pair[0].round.players.get(id) {
                if r.lives < prev.lives {
                    out.push(((t + 1) as u32, id, r.lives, r.eliminated));
                }
            }
        }
    }
    out
}

fn scores(state: &State) -> Vec<(u32, f64, f64, f64)> {
    state.round.players.iter().map(|(id, r)| (id, r.kills, r.lives, r.eliminated)).collect()
}

/// Runs the log through the server, records it, and returns the server's states
/// (index = tick, 0 = match start) along with the replayed states.
fn server_and_replay() -> (Vec<State>, Vec<State>) {
    let start = start();
    let mut server = ServerMatch::new(start.clone()).unwrap();
    let mut recorder = ReplayRecorder::new(start, None);
    let mut server_states = vec![server.state.clone()];
    for _ in 0..TICKS {
        for p in 0..2u32 {
            let mask = script(p as usize, server.tick);
            let frame = InputFrame { ack: 0, now: server.tick, changes: vec![(server.input_ack(p) + 1, server.tick, mask)] };
            server.submit(p, &frame);
        }
        let data = server.step();
        recorder.push(std::slice::from_ref(&data));
        server_states.push(server.state.clone());
    }

    let replay = Replay::from_json(recorder.finish(Vec::new()).to_json().as_bytes()).unwrap();
    let mut player = ReplayPlayer::new(replay).unwrap();
    let mut replayed = vec![server_states[0].clone()];
    while player.step() {
        replayed.push(player.states().1.clone());
    }
    assert_eq!(replayed.len(), TICKS as usize + 1, "replay must reach the final tick");
    (server_states, replayed)
}

#[test]
fn replay_reproduces_the_pit_log_ko_order_and_scores() {
    let (server, replayed) = server_and_replay();
    for (t, (s, r)) in server.iter().zip(&replayed).enumerate() {
        assert_eq!(checksum(s), checksum(r), "replay diverged at tick {t}");
    }
    let server_kos = kos(&server);
    assert!(server_kos.len() >= 2, "the pit should KO players, got {server_kos:?}");
    assert_eq!(kos(&replayed), server_kos, "replay KO order differs");
    assert_eq!(scores(replayed.last().unwrap()), scores(server.last().unwrap()), "replay final scores differ");
}

#[test]
fn server_runs_of_the_same_log_agree() {
    let (a, _) = server_and_replay();
    let (b, _) = server_and_replay();
    assert_eq!(kos(&a), kos(&b), "KO order differs between server runs");
    assert_eq!(scores(a.last().unwrap()), scores(b.last().unwrap()), "final scores differ between server runs");
}
