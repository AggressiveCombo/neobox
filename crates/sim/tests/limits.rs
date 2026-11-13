//! Maps far beyond what the original can run must not take the process down:
//! the physics engine's pair limit is hit deterministically and reported.

use neobox_sim::{advance, match_start, GameSettings, MapData, Sim, State};
use serde_json::json;

#[test]
fn stacked_shapes_hit_the_pair_limit_instead_of_exhausting_memory() {
    // one dynamic body of 1100 identical overlapping squares: ~1.2 million
    // proxy pairs per step, over the broadphase limit, but within the
    // import limits (a Hitbox "lag map" in miniature)
    let square = json!({ "p": [-0.25, -0.25, 0.25, -0.25, 0.25, 0.25, -0.25, 0.25] });
    let map = json!({ "b": [{ "2": 20, "3": 12, "s": vec![square; 1100] }], "j": [], "s": [], "set": {} });
    let map = MapData::from_json(&map).expect("within the import limits");
    let lobby = State::from_map(&map);
    let gs = GameSettings::default();
    let state = match_start(&lobby, 1, &[(0, 1.0)], &gs, false, false);
    let mut sim = Sim::new();
    let (next, _) = advance(&mut sim, &state, &[0], None, &gs, &[lobby.clone()]);
    assert!(sim.overloaded());

    // deterministic: a second simulation of the same tick agrees exactly
    let mut again = Sim::new();
    let (other, _) = advance(&mut again, &state, &[0], None, &gs, &[lobby]);
    assert!(again.overloaded());
    // states hold NaN fields like the original's, so compare their printed form
    assert_eq!(format!("{next:?}"), format!("{other:?}"));
}
