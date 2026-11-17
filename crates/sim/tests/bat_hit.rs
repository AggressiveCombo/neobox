//! Bat hits at the engine level: a player holding the bat for the full wind-up
//! and releasing it hits the adjacent player; without the swing nothing is hit.

use neobox_sim::input::BAT;
use neobox_sim::step::kind;
use neobox_sim::{advance, match_start, GameSettings, MapData, Sim, State};
use serde_json::json;

const ATTACKER: u32 = 0;
const VICTIM: u32 = 1;
/// First tick the attacker holds the bat (both players are past spawn grace).
const PRESS: u32 = 40;
/// First tick the bat is released (frame 8 -> 10 on this tick).
const RELEASE: u32 = 49;
/// Frame 13 (fire window opens) is reached at tick RELEASE + 3; the hit is
/// recorded in that tick's step, i.e. in `states[RELEASE + 4]`.
const HIT_STATE: usize = RELEASE as usize + 4;
const TICKS: u32 = 70;

/// A flat floor under two spawns one unit apart (y grows downward).
fn flat_map() -> serde_json::Value {
    json!({
        "b": [{ "1": 0, "14": 0, "s": [
            { "p": [-30.0, 10.0, 30.0, 10.0, 30.0, 12.0, -30.0, 12.0] }
        ] }],
        "j": [],
        "s": [ { "1": 10.0, "2": 9.0, "5": true }, { "1": 11.0, "2": 9.0, "5": true } ],
        "set": { "15": 60.0, "16": 30.0, "18": 15.0 }
    })
}

/// States after each tick (`states[0]` is the spawn state). The attacker holds
/// the bat over `[PRESS, RELEASE)` when `swing` is set; nobody presses otherwise.
fn run(swing: bool) -> Vec<State> {
    let lobby = State::from_map(&MapData::from_json(&flat_map()).expect("valid map"));
    let gs = GameSettings::default();
    let mut state = match_start(&lobby, 3, &[(0, 1.0), (1, 1.0)], &gs, false, false);
    let mut sim = Sim::new();
    let mut states = vec![state.clone()];
    for tick in 0..TICKS {
        let mut masks = [0u8; 2];
        if swing && (PRESS..RELEASE).contains(&tick) {
            masks[ATTACKER as usize] = BAT;
        }
        let (next, _) = advance(&mut sim, &state, &masks, None, &gs, std::slice::from_ref(&lobby));
        state = next;
        states.push(state.clone());
    }
    states
}

/// The attacker's bat history records a PLAYER hit on the victim.
fn hit_on_victim(state: &State) -> bool {
    state
        .players
        .get(ATTACKER)
        .is_some_and(|p| p.bat_hits.chunks(2).any(|h| h == [f64::from(kind::PLAYER), f64::from(VICTIM)]))
}

#[test]
fn held_then_released_swing_hits_the_adjacent_player() {
    let states = run(true);
    let spawn = &states[0];
    let (a, v) = (spawn.players.get(ATTACKER).unwrap(), spawn.players.get(VICTIM).unwrap());
    assert!((a.x - v.x).abs() <= 2.0, "players must start adjacent");

    let first = states.iter().position(hit_on_victim).expect("the swing hits the victim");
    assert_eq!(first, HIT_STATE, "hit recorded at the fire-window tick");

    let hit = &states[first];
    assert_eq!(hit.players.get(VICTIM).unwrap().attacker, f64::from(ATTACKER), "victim credited to the attacker");

    let control = run(false);
    let cv = control[first].players.get(VICTIM).unwrap();
    let hv = hit.players.get(VICTIM).unwrap();
    assert_ne!((hv.vx, hv.vy), (cv.vx, cv.vy), "the bat impulse must move the victim");
}

#[test]
fn no_swing_no_hit() {
    let states = run(false);
    assert!(!states.iter().any(hit_on_victim), "a player that never swings hits nobody");
    let spawn_attacker = states[0].players.get(VICTIM).unwrap().attacker;
    assert!(states.iter().all(|s| s.players.get(ATTACKER).is_some_and(|p| p.bat_hits.is_empty())));
    assert!(states.iter().all(|s| s.players.get(VICTIM).is_some_and(|p| p.attacker == spawn_attacker)));
}
