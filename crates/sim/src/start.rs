//! Lobby state from a map, match start, round transitions and the
//! deterministic per-tick driver.

use crate::map::MapData;
use crate::settings::GameSettings;
use crate::state::*;
use crate::step::{Events, Sim};

/// Intro countdown length in ticks.
pub const INTRO_TICKS: f64 = 90.0;

impl State {
    /// The map loaded as a lobby state (the original's `ac()`), normalized
    /// the way the original's state copy (`F()`/`A()`) normalizes it before
    /// every match: pin anchors only survive with the pin flag, force-zone
    /// forces only with the force-zone flag.
    pub fn from_map(map: &MapData) -> State {
        let mut s = State { settings: map.settings.clone(), ..State::default() };
        for (id, b) in &map.bodies {
            let mut def = b.def.clone();
            if (!def.pinned && (def.pin_x != 0.0 || def.pin_y != 0.0)) || (!def.force_zone && (def.zone_x != 0.0 || def.zone_y != 0.0)) {
                let d = std::sync::Arc::make_mut(&mut def);
                if !d.pinned {
                    d.pin_x = 0.0;
                    d.pin_y = 0.0;
                }
                if !d.force_zone {
                    d.zone_x = 0.0;
                    d.zone_y = 0.0;
                }
            }
            s.bodies.insert(
                *id,
                Body {
                    x: b.x,
                    y: b.y,
                    angle: b.angle,
                    angular_velocity: b.angular_velocity,
                    vx: b.vx,
                    vy: b.vy,
                    teleported: b.teleported,
                    damage: b.damage,
                    lifetime: b.lifetime,
                    sound_limiter: b.sound_limiter,
                    push_from: {
                        let mut p = Sparse::new();
                        for (k, w) in &b.push_from {
                            p.insert(*k, *w);
                        }
                        p
                    },
                    def,
                },
            );
        }
        for (i, j) in map.joints.iter().enumerate() {
            s.joints.insert(i as u32, j.clone());
        }
        for (i, sp) in map.spawns.iter().enumerate() {
            s.spawns.insert(i as u32, sp.clone());
        }
        for (i, t) in map.turrets.iter().enumerate() {
            s.turrets.insert(i as u32, t.clone());
        }
        for (i, g) in map.grapples.iter().enumerate() {
            s.grapples.insert(i as u32, g.clone());
        }
        s.caps = map.caps.clone();
        s
    }

    /// Register players in the round record.
    fn add_records(&mut self, players: &[(u32, f64)], gs: &GameSettings) {
        for &(id, team) in players {
            self.round.players.insert(id, PlayerRecord { id: id as f64, team, lives: gs.objective_limit, ..PlayerRecord::default() });
        }
    }

    /// Place players on spawns (priority + PRNG jitter, random pick
    /// among the players that may use each spawn).
    fn place_players(&mut self, players: &[(u32, f64)], gs: &GameSettings) {
        let mut spawns: Vec<crate::map::MapSpawn> = self.spawns.values().cloned().collect();
        let any_red = spawns.iter().any(|s| s.teams[2]);
        let any_blue = spawns.iter().any(|s| s.teams[3]);
        for s in spawns.iter_mut() {
            if !any_red {
                s.teams[2] = true;
            }
            if !any_blue {
                s.teams[3] = true;
            }
        }
        for s in spawns.iter_mut() {
            let r = self.round.random();
            s.priority += r;
        }
        spawns.retain(|s| s.cap_sequence == -2.0);
        spawns.sort_by(|a, b| b.priority.partial_cmp(&a.priority).unwrap_or(std::cmp::Ordering::Equal));
        let mut usable = [false; 5];
        for s in &spawns {
            for (u, t) in usable.iter_mut().zip(s.teams.iter()) {
                *u = *u || *t;
            }
        }
        let team_ok = |t: f64, teams: &[bool; 5]| index_of(t).filter(|t| *t < 5).is_some_and(|t| teams[t as usize]);
        let mut left: Vec<(u32, f64)> = players.iter().copied().filter(|p| team_ok(p.1, &usable)).collect();
        'outer: while !left.is_empty() && !spawns.is_empty() {
            for s in &spawns {
                let fits: Vec<usize> = (0..left.len()).filter(|&i| team_ok(left[i].1, &s.teams)).collect();
                if fits.is_empty() {
                    continue;
                }
                let pick = loop {
                    let r = self.round.random();
                    let k = (r * fits.len() as f64).floor() as usize;
                    if let Some(&i) = fits.get(k) {
                        break i;
                    }
                };
                let (id, team) = left[pick];
                self.players.insert(
                    id,
                    Player {
                        id: id as f64,
                        x: s.x,
                        y: s.y,
                        spawn_x: s.x,
                        spawn_y: s.y,
                        team,
                        teleported: true,
                        angle: s.angle,
                        stamina: gs.max_stamina,
                        ..Player::default()
                    },
                );
                if let Some(r) = self.round.players.get_mut(id) {
                    r.alive = true;
                    r.checkpoint_times.clear();
                }
                left.remove(pick);
                if left.is_empty() {
                    break 'outer;
                }
            }
        }
    }

    /// Mode-specific match initialisation.
    fn init_mode(&mut self, gs: &GameSettings) {
        if gs.game_mode == crate::settings::mode::LIVES_TEAMS {
            self.round.red = gs.objective_limit;
            self.round.blue = gs.objective_limit;
        }
    }
}

/// Start a match on `lobby`.
///
/// `players` are `(id, team)`; `rotation` is the original's rotation flag
/// (map rotation: the next map is played after a game over).
pub fn match_start(lobby: &State, seed: u32, players: &[(u32, f64)], gs: &GameSettings, intro: bool, rotation: bool) -> State {
    let mut s = lobby.clone();
    s.round.seed = seed as f64;
    s.round.rotation = rotation;
    if intro {
        s.round.intro = INTRO_TICKS;
    }
    s.add_records(players, gs);
    if gs.fixed_spawns {
        for &(id, _) in players {
            if let Some(r) = s.round.players.get_mut(id) {
                r.spawn = id as f64;
            }
        }
    } else {
        s.place_players(players, gs);
    }
    s.init_mode(gs);
    s
}

/// Start the next round: fresh map, round record carried over.
pub fn next_round(lobby: &State, current: &State, gs: &GameSettings) -> State {
    let mut s = lobby.clone();
    s.round = current.round.clone();
    s.round.game_over = -1.0;
    s.round.round_over = -1.0;
    s.round.ticks = 0.0;
    s.round.round_number += 1.0;
    s.round.intro = INTRO_TICKS;
    let players: Vec<(u32, f64)> = current.round.players.iter().map(|(k, r)| (k, r.team)).collect();
    for (_, r) in s.round.players.iter_mut() {
        r.kills = 0.0;
        r.kill_timer = -1.0;
        r.death_timer = -1.0;
        r.suicide_timer = -1.0;
        r.lives = gs.objective_limit;
    }
    s.place_players(&players, gs);
    s.init_mode(gs);
    s
}

/// What happened after a tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Normal tick.
    Running,
    /// A new round started this tick.
    NewRound,
    /// The game-over countdown finished: the match is over.
    MatchOver,
}

/// Deterministic per-tick driver: step, then apply the original's round
/// transitions. `maps` is the rotation playlist (at least one map).
pub fn advance(sim: &mut Sim, state: &State, inputs: &[u8], events: Option<&Events>, gs: &GameSettings, maps: &[State]) -> (State, Outcome) {
    let mut next = sim.step(state, inputs, events, gs);
    let rotation = next.round.rotation;
    let round_done = next.round.round_over == 0.0;
    let game_done = next.round.game_over == 0.0;
    if round_done || (rotation && game_done) {
        let index = if rotation && game_done {
            next.round.map_index += 1.0;
            next.round.map_index % maps.len() as f64
        } else if round_done && rotation {
            next.round.map_index % maps.len() as f64
        } else {
            0.0
        };
        let lobby = &maps[index as usize];
        let mut fresh = next_round(lobby, &next, gs);
        if rotation && game_done {
            for (_, r) in fresh.round.players.iter_mut() {
                r.wins = 0.0;
            }
        }
        next = fresh;
        return (next, Outcome::NewRound);
    }
    if game_done {
        return (next, Outcome::MatchOver);
    }
    (next, Outcome::Running)
}
