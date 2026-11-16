//! Experience awarded at the end of a game: the original's placement rule and
//! amounts. The server computes them from the authoritative final state, so a
//! client cannot claim more than it earned.

use neobox_sim::settings::mode;
use neobox_sim::state::Round;
use neobox_sim::GameSettings;
use neobox_store::MatchStats;
use std::collections::HashMap;

const TEAM_RED: f64 = 2.0;
const TEAM_BLUE: f64 = 3.0;

/// Place of player `me` (1 = first; -1 when it has none), by game mode.
pub fn placement(round: &Round, game_mode: i32, me: u32) -> i32 {
    let Some(mine) = round.players.get(me) else { return -1 };
    let others = || round.players.iter().filter(move |(id, _)| *id != me).map(|(_, r)| r);
    let ahead = match game_mode {
        mode::KILLS | mode::ENDLESS => others().filter(|r| r.kills > mine.kills).count(),
        mode::ROUNDS => others().filter(|r| r.wins > mine.wins).count(),
        mode::LIVES => {
            if mine.lives > 0.0 {
                0
            } else if mine.lives == 0.0 && mine.eliminated == 0.0 {
                return -1;
            } else {
                others().filter(|r| r.eliminated > mine.eliminated || r.lives > 0.0).count()
            }
        }
        _ => 0,
    };
    1 + ahead as i32
}

/// Award at the end of a custom-room match: `(placement, xp)`, or `None` for
/// a player without a record (a spectator). Team modes report placement 1
/// for a win and 2 otherwise.
pub fn match_award(round: &Round, gs: &GameSettings, me: u32) -> Option<(i32, u32)> {
    let mine = round.players.get(me)?;
    if gs.is_team_mode() {
        let won = (mine.team == TEAM_RED && round.red > round.blue) || (mine.team == TEAM_BLUE && round.blue > round.red);
        let mut xp: u32 = if won { 75 } else { 25 };
        if gs.game_mode == mode::LIVES_TEAMS {
            xp = xp.saturating_mul(1 + (gs.objective_limit / 25.0).floor().max(0.0) as u32);
        }
        return Some((if won { 1 } else { 2 }, xp));
    }
    let place = placement(round, gs.game_mode, me);
    let players = round.players.len() as i64;
    let mut xp: i64 = match place {
        1 => 100,
        2 => 50,
        3 => 25,
        p if p >= 4 => 10,
        _ => 0,
    };
    if players > 4 {
        xp += 10 * (players - place as i64);
    }
    Some((place, xp.max(0) as u32))
}

/// Award of one game in a quick-play rotation: `(placement, xp)`.
pub fn quick_award(round: &Round, game_mode: i32, me: u32) -> Option<(i32, u32)> {
    round.players.get(me)?;
    let place = placement(round, game_mode, me);
    let xp = match place {
        1 => 50,
        2 => 25,
        3 => 10,
        p if p >= 4 => 5,
        _ => 0,
    };
    Some((place, xp))
}

/// What the sim's counters held for one player at the last tick.
#[derive(Clone, Copy, Default)]
struct Seen {
    kills: f64,
    wins: f64,
    death: f64,
    suicide: f64,
}

/// One player's game so far.
#[derive(Clone, Copy, Default)]
struct Totals {
    kills: i64,
    rounds_won: i64,
    deaths: i64,
    /// Seconds in play (not spectating).
    play_seconds: f64,
}

/// Per-player numbers of a game, counted from the authoritative state after
/// every tick. The sim resets kills and round wins when a round or game
/// starts, so their growth is counted as it happens and a fall means a reset.
#[derive(Default)]
pub struct Tallies {
    seen: HashMap<u32, Seen>,
    totals: HashMap<u32, Totals>,
}

/// How much a counter grew since `before`. After a reset it holds what came since.
fn grown(before: f64, now: f64) -> i64 {
    if now >= before { (now - before) as i64 } else { now.max(0.0) as i64 }
}

impl Tallies {
    /// Count what happened during one tick of `tick_seconds`.
    pub fn observe(&mut self, round: &Round, tick_seconds: f64) {
        for (id, r) in round.players.iter() {
            let seen = self.seen.entry(id).or_insert(Seen { death: -1.0, suicide: -1.0, ..Seen::default() });
            let t = self.totals.entry(id).or_default();
            t.kills += grown(seen.kills, r.kills);
            t.rounds_won += grown(seen.wins, r.wins);
            // a death or suicide starts the death banner countdown: its timer rises to BANNER_TICKS
            if r.death_timer > seen.death {
                t.deaths += 1;
            }
            if r.suicide_timer > seen.suicide {
                t.deaths += 1;
            }
            // team 0 is a spectator
            if r.team != 0.0 {
                t.play_seconds += tick_seconds;
            }
            *seen = Seen { kills: r.kills, wins: r.wins, death: r.death_timer, suicide: r.suicide_timer };
        }
    }

    /// One game's numbers for player `me`, who finished in `place` (1 = won).
    /// `None` when they never played it.
    pub fn game(&self, me: u32, place: i32) -> Option<MatchStats> {
        let t = self.totals.get(&me).filter(|t| t.play_seconds > 0.0)?;
        Some(MatchStats {
            games: 1,
            wins: i64::from(place == 1),
            rounds_won: t.rounds_won,
            kills: t.kills,
            deaths: t.deaths,
            play_seconds: t.play_seconds as i64,
        })
    }

    /// Start counting the next game of a rotation. The baselines carry on, so
    /// the sim's counters are not counted twice.
    pub fn reset(&mut self) {
        self.totals.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neobox_sim::state::PlayerRecord;

    fn round(players: &[(u32, f64, f64, f64, f64, f64)]) -> Round {
        let mut r = Round::default();
        for &(id, team, kills, wins, lives, eliminated) in players {
            let rec = PlayerRecord { id: id as f64, team, kills, wins, lives, eliminated, ..PlayerRecord::default() };
            r.players.insert(id, rec);
        }
        r
    }

    fn settings(game_mode: i32) -> GameSettings {
        GameSettings { game_mode, ..GameSettings::default() }
    }

    #[test]
    fn kills_placement_counts_players_ahead() {
        let r = round(&[(0, 1.0, 5.0, 0.0, 0.0, 0.0), (1, 1.0, 3.0, 0.0, 0.0, 0.0), (2, 1.0, 3.0, 0.0, 0.0, 0.0), (3, 1.0, 1.0, 0.0, 0.0, 0.0)]);
        assert_eq!(placement(&r, mode::KILLS, 0), 1);
        // ties share the better place
        assert_eq!(placement(&r, mode::KILLS, 1), 2);
        assert_eq!(placement(&r, mode::KILLS, 2), 2);
        assert_eq!(placement(&r, mode::KILLS, 3), 4);
        assert_eq!(placement(&r, mode::KILLS, 9), -1);
    }

    #[test]
    fn lives_placement_follows_elimination_order() {
        // 0 survives; 1 was eliminated last (higher order), 2 first
        let r = round(&[(0, 1.0, 0.0, 0.0, 2.0, 0.0), (1, 1.0, 0.0, 0.0, 0.0, 2.0), (2, 1.0, 0.0, 0.0, 0.0, 1.0)]);
        assert_eq!(placement(&r, mode::LIVES, 0), 1);
        assert_eq!(placement(&r, mode::LIVES, 1), 2);
        assert_eq!(placement(&r, mode::LIVES, 2), 3);
        // out of lives without an elimination record: no place
        let r = round(&[(0, 1.0, 0.0, 0.0, 0.0, 0.0), (1, 1.0, 0.0, 0.0, 1.0, 0.0)]);
        assert_eq!(placement(&r, mode::LIVES, 0), -1);
    }

    #[test]
    fn rounds_placement_uses_round_wins() {
        let r = round(&[(0, 1.0, 9.0, 1.0, 0.0, 0.0), (1, 1.0, 0.0, 3.0, 0.0, 0.0)]);
        assert_eq!(placement(&r, mode::ROUNDS, 0), 2);
        assert_eq!(placement(&r, mode::ROUNDS, 1), 1);
    }

    #[test]
    fn ffa_amounts_and_large_room_bonus() {
        let small = round(&[(0, 1.0, 3.0, 0.0, 0.0, 0.0), (1, 1.0, 2.0, 0.0, 0.0, 0.0), (2, 1.0, 1.0, 0.0, 0.0, 0.0), (3, 1.0, 0.0, 0.0, 0.0, 0.0)]);
        let gs = settings(mode::KILLS);
        assert_eq!(match_award(&small, &gs, 0), Some((1, 100)));
        assert_eq!(match_award(&small, &gs, 1), Some((2, 50)));
        assert_eq!(match_award(&small, &gs, 2), Some((3, 25)));
        assert_eq!(match_award(&small, &gs, 3), Some((4, 10)));
        // six players: +10 per player behind
        let six: Vec<_> = (0..6).map(|i| (i, 1.0, 10.0 - i as f64, 0.0, 0.0, 0.0)).collect();
        let big = round(&six);
        assert_eq!(match_award(&big, &gs, 0), Some((1, 150)));
        assert_eq!(match_award(&big, &gs, 5), Some((6, 10)));
        assert_eq!(match_award(&big, &gs, 42), None);
    }

    #[test]
    fn team_awards_and_lives_teams_scaling() {
        let mut r = round(&[(0, TEAM_RED, 0.0, 0.0, 0.0, 0.0), (1, TEAM_BLUE, 0.0, 0.0, 0.0, 0.0)]);
        r.red = 3.0;
        r.blue = 1.0;
        let gs = settings(mode::TEAM_ROUNDS);
        assert_eq!(match_award(&r, &gs, 0), Some((1, 75)));
        assert_eq!(match_award(&r, &gs, 1), Some((2, 25)));
        // a draw is not a win
        r.blue = 3.0;
        assert_eq!(match_award(&r, &gs, 0), Some((2, 25)));
        let lives = GameSettings { game_mode: mode::LIVES_TEAMS, objective_limit: 50.0, ..GameSettings::default() };
        r.blue = 0.0;
        assert_eq!(match_award(&r, &lives, 0), Some((1, 225)));
    }

    #[test]
    fn quick_amounts() {
        let r = round(&[(0, 1.0, 3.0, 0.0, 0.0, 0.0), (1, 1.0, 2.0, 0.0, 0.0, 0.0), (2, 1.0, 1.0, 0.0, 0.0, 0.0), (3, 1.0, 0.0, 0.0, 0.0, 0.0)]);
        assert_eq!(quick_award(&r, mode::KILLS, 0), Some((1, 50)));
        assert_eq!(quick_award(&r, mode::KILLS, 1), Some((2, 25)));
        assert_eq!(quick_award(&r, mode::KILLS, 2), Some((3, 10)));
        assert_eq!(quick_award(&r, mode::KILLS, 3), Some((4, 5)));
    }
}
