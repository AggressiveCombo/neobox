//! Point-blank bat exchange on the gameplay.mjs hitbox fixture. Simultaneous swings trade hits; a
//! swing that lands first knocks the other player out of reach before its own bat fires, so a
//! stagger of one tick or more leaves the second swinger with no hit. Browser hitbox runs stagger
//! the two swings by milliseconds, so they show one direction only.
use neobox_net::{InputFrame, MatchStart, ServerMatch};
use neobox_sim::input::BAT;
use neobox_sim::settings::mode;
use neobox_sim::{GameSettings, MapData};
use serde_json::{json, Value};

/// The hitbox fixture (client/qa/gameplay.mjs FIXTURE_MAP): a flat platform, players side by side.
fn fixture() -> Value {
    json!({
        "b": [{ "1": 0, "2": 20, "3": 21, "s": [{ "7": 3754574, "p": [-6, -0.5, 6, -0.5, 6, 0.5, -6, 0.5] }] }],
        "j": [],
        "s": [ { "1": 19, "2": 19.5 }, { "1": 21, "2": 19.5 } ],
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
        settings: GameSettings { game_mode: mode::LIVES, objective_limit: 99.0, ..GameSettings::default() },
        maps: vec![MapData::from_json(&fixture()).unwrap().to_code()],
        intro: false,
        rotation: false,
    }
}

/// One point-blank swing after spawn grace: `BAT` held through the fire frame, then released.
fn swing() -> Vec<u8> {
    let mut m = vec![0u8; 90];
    m.extend(std::iter::repeat_n(BAT, 18));
    m.extend(std::iter::repeat_n(0u8, 46));
    m
}

/// Runs the exchange; returns (attacker, victim) for each landed hit and the guest's x at the end.
fn exchange(delay: usize) -> (Vec<(u32, u32)>, f64) {
    let mut server = ServerMatch::new(start()).unwrap();
    let host = swing();
    let mut guest = vec![0u8; delay];
    guest.extend(swing());
    let mut hits = Vec::new();
    let mut seen = [0usize; 2];
    let mut guest_x = f64::NAN;
    for t in 0..host.len().max(guest.len()) {
        let masks = [host.get(t).copied().unwrap_or(0), guest.get(t).copied().unwrap_or(0)];
        for p in 0..2u32 {
            let frame = InputFrame { ack: 0, now: server.tick, changes: vec![(server.input_ack(p) + 1, server.tick, masks[p as usize])] };
            server.submit(p, &frame);
        }
        server.step();
        for (id, pl) in server.state.players.iter() {
            if id == 1 {
                guest_x = pl.x;
            }
            let i = id as usize;
            let len = pl.bat_hits.len();
            let from = if len >= seen[i] { seen[i] } else { 0 };
            for pair in pl.bat_hits[from..].chunks_exact(2) {
                assert_eq!(pair[0] as u32, neobox_sim::step::kind::PLAYER, "fixture hits are player hits");
                hits.push((id, pair[1] as u32));
            }
            seen[i] = len;
        }
    }
    (hits, guest_x)
}

#[test]
fn simultaneous_point_blank_swings_trade_hits() {
    let (hits, _) = exchange(0);
    assert!(hits.contains(&(0, 1)) && hits.contains(&(1, 0)), "both players hit, got {hits:?}");
}

#[test]
fn staggered_swings_let_only_the_first_swing_land() {
    let (hits, guest_x) = exchange(1);
    assert!(hits.iter().all(|&(a, _)| a == 0), "only the host (first) swing lands, got {hits:?}");
    assert!(!hits.is_empty(), "the first swing lands");
    assert!(guest_x > 21.0 + 2.0, "the knocked guest ends out of bat reach, x = {guest_x}");
}
