//! The heav.io checkpoint race (src/race.rs): checkpoints in order, back to
//! the last checkpoint instead of dying, finish times, `recordMode`.

use neobox_sim::settings::mode;
use neobox_sim::{advance, match_start, GameSettings, MapData, Sim, State};
use serde_json::{json, Value};

/// A static platform 6 wide at (`x`, `y`) with race checkpoint number `cp`.
fn platform(x: f64, y: f64, cp: u32) -> Value {
    json!({ "2": x, "3": y, "31": cp, "s": [{ "p": [-3, -0.25, 3, -0.25, 3, 0.25, -3, 0.25] }] })
}

fn lobby(bodies: Vec<Value>) -> State {
    let bodies: Vec<Value> = bodies
        .into_iter()
        .enumerate()
        .map(|(id, mut b)| {
            b["1"] = json!(id);
            b
        })
        .collect();
    let map = json!({ "b": bodies, "j": [], "s": [{ "1": 5, "2": 1 }], "set": { "15": 40, "16": 30 } });
    State::from_map(&MapData::from_json(&map).expect("map"))
}

struct Run {
    sim: Sim,
    lobby: State,
    gs: GameSettings,
    state: State,
}

impl Run {
    fn new(bodies: Vec<Value>, gs: GameSettings) -> Run {
        let lobby = lobby(bodies);
        let state = match_start(&lobby, 1, &[(0, 1.0)], &gs, false, false);
        Run { sim: Sim::new(), lobby, gs, state }
    }

    fn tick(&mut self, mask: u8) {
        let (next, _) = advance(&mut self.sim, &self.state, &[mask], None, &self.gs, std::slice::from_ref(&self.lobby));
        self.state = next;
    }

    /// Ticks (holding `mask`) until `done` holds; panics after `limit`.
    fn until(&mut self, mask: u8, limit: u32, what: &str, done: impl Fn(&State) -> bool) {
        for _ in 0..limit {
            self.tick(mask);
            if done(&self.state) {
                return;
            }
        }
        panic!("{what} did not happen within {limit} ticks");
    }
}

fn kills() -> GameSettings {
    GameSettings { game_mode: mode::KILLS, ..GameSettings::default() }
}

#[test]
fn checkpoints_count_in_order_and_a_fall_returns_to_the_last_one() {
    // fall through checkpoint 1 (its contacts are off on the first tick); 2 is out of reach
    let mut run = Run::new(vec![platform(5.0, 4.0, 1), platform(35.0, 4.0, 2)], kills());
    run.until(0, 120, "passing checkpoint 1", |s| s.players.get(0).is_some_and(|p| p.checkpoint == 1.0));
    let rec = run.state.round.players.get(0).unwrap();
    assert_eq!(rec.checkpoint_times.len(), 2);
    assert!(rec.checkpoint_times[0].is_nan(), "no checkpoint 0");
    assert_eq!(rec.last_checkpoint_time, rec.checkpoint_times[1], "the last checkpoint's time");
    assert_eq!(rec.best_finish_time, 0.0, "no finish yet");

    // fall out of the arena: back at checkpoint 1, run time still going
    run.until(0, 300, "the return to checkpoint 1", |s| {
        s.players.get(0).is_some_and(|p| p.teleported && p.age > 0.0 && p.x == 5.0 && p.y == 4.0)
    });
    let p = run.state.players.get(0).unwrap();
    assert_eq!(p.checkpoint, 1.0, "the checkpoint is kept");
    assert!(p.age > 30.0, "the run time keeps going: age {}", p.age);
    let rec = run.state.round.players.get(0).unwrap();
    assert_eq!(rec.kills, 0.0);
    assert_eq!(rec.respawn, -1.0, "not a death: no respawn countdown");
}

#[test]
fn finishing_records_the_time_and_starts_a_new_run() {
    // checkpoint 1 above the finish (2): falling passes both
    let mut run = Run::new(vec![platform(5.0, 4.0, 1), platform(5.0, 10.0, 2)], kills());
    run.until(0, 120, "the finish", |s| s.round.players.get(0).is_some_and(|r| r.best_finish_time > 0.0));
    let rec = run.state.round.players.get(0).unwrap().clone();
    assert!(run.state.players.get(0).is_none(), "the finisher leaves without dying");
    assert_eq!(rec.last_finish_time, rec.best_finish_time, "the last finish");
    assert_eq!(rec.checkpoint_times[2], rec.best_finish_time, "the finish split");
    assert!(rec.checkpoint_times[1] < rec.checkpoint_times[2]);
    assert_eq!(format!("{:?}", rec.best_checkpoint_times), format!("{:?}", rec.checkpoint_times), "the best run's splits");
    assert!(rec.checkpoint_delta.is_nan(), "no earlier best to compare with");
    assert_eq!(rec.respawn, 59.0, "a new run starts 60 ticks after the finish");
    run.until(0, 70, "the respawn", |s| s.players.get(0).is_some_and(|p| p.checkpoint == 0.0 && p.age == 0.0));
}

#[test]
fn record_mode_finishers_sit_out_the_round() {
    let gs = GameSettings { record_mode: true, ..kills() };
    let mut run = Run::new(vec![platform(5.0, 4.0, 1), platform(5.0, 10.0, 2)], gs);
    run.until(0, 120, "the finish", |s| s.round.players.get(0).is_some_and(|r| r.best_finish_time > 0.0));
    let rec = run.state.round.players.get(0).unwrap();
    assert!(!rec.alive, "out of play");
    assert_eq!(rec.respawn, -1.0, "no new run this round");
    assert!(run.state.round.round_over > 0.0, "nobody is left: the round ends");
    assert_eq!(run.state.round.winner, -1.0, "a draw");
}

#[test]
fn a_map_without_checkpoints_keeps_the_race_slots_unused() {
    let mut run = Run::new(vec![platform(5.0, 4.0, 0)], kills());
    for _ in 0..60 {
        run.tick(0);
    }
    let rec = run.state.round.players.get(0).unwrap();
    assert_eq!((rec.best_finish_time, rec.checkpoint_age, rec.last_finish_time, rec.last_checkpoint_time), (0.0, 0.0, 0.0, 0.0));
    assert!(rec.checkpoint_times.is_empty() && rec.best_checkpoint_times.is_empty());
    assert_eq!(run.state.players.get(0).unwrap().checkpoint, 0.0);
}
