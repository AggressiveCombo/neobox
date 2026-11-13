//! Replays every reference trajectory recorded from the original game
//! (`tests/reference/*.json.gz`, produced by `tools/oracle/record.cjs`) and
//! requires the neobox simulation to reproduce every tick's full state
//! exactly.
//!
//! `NEOBOX_ORACLE=<substring>` limits the run to matching scenarios.

use neobox_sim::compat::first_difference;
use neobox_sim::start::advance;
use neobox_sim::{match_start, Events, GameSettings, MapData, Sim, State};
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;

/// `NEOBOX_ORACLE_DIR` replays recordings kept outside the repository (for
/// example on community maps that cannot be redistributed).
fn reference_dir() -> PathBuf {
    match std::env::var_os("NEOBOX_ORACLE_DIR") {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/reference"),
    }
}

fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap();
            if f.fract() == 0.0 && f.abs() < 1e15 { format!("{}", f as i64) } else { format!("{f}") }
        }
        other => other.to_string(),
    }
}

fn at<'a>(v: &'a Value, path: &str) -> String {
    // render the value at a "[a][b]..." path for error messages
    let mut cur = v;
    for part in path.trim_start_matches('[').trim_end_matches(']').split("][") {
        if let Ok(i) = part.parse::<usize>() {
            cur = cur.get(i).unwrap_or(&Value::Null);
        }
    }
    let s = cur.to_string();
    if s.len() > 200 { format!("{}…", &s[..200]) } else { s }
}

struct Outcome {
    name: String,
    ticks: usize,
    passed: usize,
    failure: Option<String>,
}

fn run(file: &PathBuf) -> Outcome {
    let mut gz = Vec::new();
    std::fs::File::open(file).unwrap().read_to_end(&mut gz).unwrap();
    let mut json = String::new();
    flate2::read::GzDecoder::new(&gz[..]).read_to_string(&mut json).unwrap();
    let rec: Value = serde_json::from_str(&json).unwrap();
    let sc = &rec["scenario"];
    let name = sc["name"].as_str().unwrap().to_string();
    let map = MapData::from_code(rec["mapCode"].as_str().unwrap()).expect("map decodes");
    let mut gs = GameSettings::default();
    if let Some(set) = sc["settings"].as_object() {
        for (k, v) in set {
            gs.set(k, &js_string(v)).expect("setting applies");
        }
    }
    let players: Vec<(u32, f64)> =
        sc["players"].as_array().unwrap().iter().map(|p| (p[0].as_u64().unwrap() as u32, p[1].as_f64().unwrap())).collect();
    let seed = sc["seed"].as_u64().unwrap_or(0) as u32;
    let intro = !sc["skipIntro"].as_bool().unwrap_or(false);
    let rotation = sc["iP"].as_bool().unwrap_or(false);
    let lobby = State::from_map(&map);
    let mut state = match_start(&lobby, seed, &players, &gs, intro, rotation);
    let states = rec["states"].as_array().unwrap();
    let mut out = Outcome { name: name.clone(), ticks: states.len(), passed: 0, failure: None };
    if let Some(p) = first_difference(&state.to_original_layout(), &rec["init"]) {
        out.failure = Some(format!("initial state differs at {p}: neobox {} vs original {}", at(&state.to_original_layout(), &p), at(&rec["init"], &p)));
        return out;
    }
    let mut changes: Vec<(u64, usize, u8)> = Vec::new();
    if let Some(inp) = sc["inputs"].as_object() {
        for (id, list) in inp {
            for e in list.as_array().unwrap() {
                changes.push((e[0].as_u64().unwrap(), id.parse().unwrap(), e[1].as_u64().unwrap() as u8));
            }
        }
    }
    let events: Vec<(u64, Events)> = sc["events"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|e| {
                    let ev = &e[1];
                    let removed = ev["remove"].as_array().map_or(vec![], |r| r.iter().map(|x| x.as_u64().unwrap() as u32).collect());
                    let joined = ev["join"]
                        .as_array()
                        .map_or(vec![], |j| j.iter().map(|x| (x[0].as_u64().unwrap() as u32, x[1].as_f64().unwrap())).collect());
                    (e[0].as_u64().unwrap(), Events { removed, joined })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut masks: Vec<u8> = Vec::new();
    let mut sim = Sim::new();
    let maps = [lobby.clone()];
    for (t, expected) in states.iter().enumerate() {
        for &(tick, id, m) in &changes {
            if tick == t as u64 {
                if masks.len() <= id {
                    masks.resize(id + 1, 0);
                }
                masks[id] = m;
            }
        }
        let ev = events.iter().find(|e| e.0 == t as u64).map(|e| &e.1);
        let (next, _) = advance(&mut sim, &state, &masks, ev, &gs, &maps);
        state = next;
        let got = state.to_original_layout();
        let expected = &platform_pow_tolerant(expected, &got);
        if let Some(p) = first_difference(&got, expected) {
            out.failure = Some(format!("tick {t}: differs at {p}: neobox {} vs original {}", at(&got, &p), at(expected, &p)));
            return out;
        }
        out.passed += 1;
    }
    out
}

/// The parachute sound volume is `Math.pow(speed, 1.5)`, which browsers take
/// from the operating system's math library (results differ in the last
/// bits between platforms). neobox uses one portable `pow` everywhere
/// (DEVIATIONS.md S6), so that single field is compared to 1e-12 relative.
fn platform_pow_tolerant(expected: &Value, got: &Value) -> Value {
    let mut e = expected.clone();
    if let (Some(rows), Some(got_rows)) = (e.get_mut(1).and_then(Value::as_array_mut), got.get(1).and_then(Value::as_array)) {
        for (row, g) in rows.iter_mut().zip(got_rows) {
            let is_chute = row.as_array().is_some_and(|r| r.len() == 11 && r[2] == 18.0);
            if let (true, Some(gv), Some(ev)) = (is_chute, g.get(7).and_then(Value::as_f64), row.get(7).and_then(Value::as_f64)) {
                if (gv - ev).abs() <= 1e-12 * ev.abs() {
                    row[7] = g[7].clone();
                }
            }
        }
    }
    e
}

#[test]
fn reference_trajectories() {
    let filter = std::env::var("NEOBOX_ORACLE").unwrap_or_default();
    let mut files: Vec<PathBuf> = std::fs::read_dir(reference_dir())
        .expect("tests/reference exists")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.to_string_lossy().ends_with(".json.gz"))
        .filter(|p| filter.is_empty() || p.to_string_lossy().contains(&filter))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no reference trajectories");
    let mut failed = 0;
    for f in &files {
        let o = run(f);
        match &o.failure {
            None => println!("PASS {:<24} {:>5}/{} ticks bit-exact", o.name, o.passed, o.ticks),
            Some(e) => {
                failed += 1;
                println!("FAIL {:<24} {:>5}/{} ticks; {e}", o.name, o.passed, o.ticks);
            }
        }
    }
    assert_eq!(failed, 0, "{failed} of {} reference trajectories diverged", files.len());
}
