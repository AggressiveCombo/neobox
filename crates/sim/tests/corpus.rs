//! Map import check against a corpus of real Hitbox.io maps.
//!
//! Community maps are not redistributed with neobox, so the corpus lives
//! outside the repository: `NEOBOX_MAP_CORPUS=<file.jsonl>` with one
//! `{"id", "name", "code"}` object per line (the public map list format).
//! Without the variable the test does nothing.
//!
//! Every map must decode, survive an encode/decode round trip unchanged,
//! and play 300 ticks with four players moving at random without reaching
//! the physics limits. Maps over the import limits (`MAX_MAP_SHAPES`,
//! `MAX_MAP_VERTICES`) must be rejected as too complex; they are listed.

use neobox_sim::{advance, match_start, GameSettings, MapData, MapError, Sim, State};
use serde_json::Value;

#[test]
fn community_maps() {
    let Some(path) = std::env::var_os("NEOBOX_MAP_CORPUS") else { return };
    let text = std::fs::read_to_string(path).expect("corpus readable");
    let gs = GameSettings::default();
    let players = [(0, 1.0), (1, 1.0), (2, 1.0), (3, 1.0)];
    let mut failures = Vec::new();
    let mut rejected = Vec::new();
    let mut count = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        count += 1;
        let row: Value = serde_json::from_str(line).expect("corpus line is JSON");
        let label = format!("{} {:?}", row["id"], row["name"].as_str().unwrap_or(""));
        let map = match MapData::from_code(row["code"].as_str().unwrap_or("")) {
            Ok(m) => m,
            Err(e @ MapError::TooComplex { .. }) => {
                rejected.push(format!("{label}: {e}"));
                continue;
            }
            Err(e) => {
                failures.push(format!("{label}: decode: {e}"));
                continue;
            }
        };
        match MapData::from_code(&map.to_code()) {
            // Compared as canonical JSON: a missing y (odd-length `p`) is NaN, and NaN != NaN.
            Ok(again) if again.to_json() == map.to_json() => {}
            Ok(_) => failures.push(format!("{label}: round trip changed the map")),
            Err(e) => failures.push(format!("{label}: re-decode: {e}")),
        }
        let lobby = State::from_map(&map);
        let maps = [lobby.clone()];
        let mut state = match_start(&lobby, 7, &players, &gs, false, false);
        let mut sim = Sim::new();
        let mut seed = 0x9e3779b9u32;
        for _ in 0..300 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let inputs = seed.to_le_bytes();
            state = advance(&mut sim, &state, &inputs, None, &gs, &maps).0;
            if sim.overloaded() {
                failures.push(format!("{label}: reached the physics limits"));
                break;
            }
        }
    }
    println!("{count} maps, {} rejected as too complex, {} failures", rejected.len(), failures.len());
    for r in &rejected {
        println!("  rejected {r}");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
