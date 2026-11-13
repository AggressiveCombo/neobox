//! Round state and game modes: scoring, lives, respawns, spawn assignment.

use crate::map::{MapCap, MapSpawn};
use crate::settings::{mode, GameSettings};
use crate::state::*;
use crate::step::{sound, Ctx, Events};

/// Ticks of the kill/death banners.
pub const BANNER_TICKS: f64 = 30.0;
/// Game-over countdown (slow motion while it runs).
pub const GAME_OVER_TICKS: f64 = 150.0;
/// Round-over countdown.
pub const ROUND_OVER_TICKS: f64 = 120.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Base,
    Kills,
    Lives,
    Rounds,
    TeamRounds,
    EndlessTeams,
    LivesTeams,
    Endless,
}

impl Mode {
    pub fn of(game_mode: i32) -> Mode {
        match game_mode {
            mode::KILLS => Mode::Kills,
            mode::LIVES => Mode::Lives,
            mode::ROUNDS => Mode::Rounds,
            mode::TEAM_ROUNDS => Mode::TeamRounds,
            mode::ENDLESS_TEAMS => Mode::EndlessTeams,
            mode::LIVES_TEAMS => Mode::LivesTeams,
            mode::ENDLESS => Mode::Endless,
            _ => Mode::Base,
        }
    }
    fn rounds_like(self) -> bool {
        matches!(self, Mode::Rounds | Mode::TeamRounds)
    }
}

/// Runtime wrapper of the round state for one tick.
pub(crate) struct RoundObj {
    pub mode: Mode,
    pub eo: Round,
    /// rounds modes: something changed (death/leave) this tick (`A_`)
    changed: bool,
    /// rounds modes: someone joined this tick (`O_`)
    joined: bool,
    /// rounds modes: the round state at the start of the tick (`R_`)
    initial: Option<Round>,
    /// endless teams: the map has objective bodies (`J_`)
    has_objectives: bool,
}

impl RoundObj {
    pub fn new(eo: Round, gs: &GameSettings) -> RoundObj {
        let mode = Mode::of(gs.game_mode);
        let initial = if mode.rounds_like() { Some(eo.clone()) } else { None };
        RoundObj { mode, eo, changed: false, joined: false, initial, has_objectives: false }
    }

    pub fn with_bodies(mut self, bodies: &Sparse<Body>) -> RoundObj {
        if self.mode == Mode::EndlessTeams {
            self.has_objectives = bodies.values().any(|b| b.def.objective != 0.0);
        }
        self
    }

    fn round_over(&self) -> bool {
        self.eo.round_over > -1.0
    }
    fn game_over(&self) -> bool {
        self.eo.game_over > -1.0
    }

    /// `Ko`: a player left.
    fn leave(&mut self, id: u32) {
        self.eo.players.remove(id);
        match self.mode {
            Mode::Lives => self.lives_check(0),
            Mode::Rounds | Mode::TeamRounds => self.changed = true,
            _ => {}
        }
    }

    /// `Zo`: a player joined with `team`.
    fn join(&mut self, id: u32, team: f64, gs: &GameSettings) {
        let rec = |respawn: f64| PlayerRecord { id: id as f64, team, respawn, ..PlayerRecord::default() };
        match self.mode {
            Mode::Kills => {
                if team > 0.0 {
                    self.eo.players.insert(id, rec(30.0));
                }
            }
            Mode::Lives => {
                if team > 0.0 {
                    let mut r = rec(-1.0);
                    if self.eo.intro > -1.0 {
                        r.respawn = 30.0;
                        r.lives = gs.objective_limit;
                    } else if self.eo.min_lives >= 2.0 {
                        r.respawn = 30.0;
                        r.lives = self.eo.min_lives - 1.0;
                    }
                    self.eo.players.insert(id, r);
                }
            }
            Mode::Rounds | Mode::TeamRounds => {
                if team > 0.0 {
                    self.eo.players.insert(id, rec(-1.0));
                    self.joined = true;
                }
            }
            Mode::EndlessTeams => {
                if team >= 2.0 {
                    self.eo.players.insert(id, rec(30.0));
                }
            }
            Mode::LivesTeams => {
                if team >= 2.0 {
                    self.eo.players.insert(id, rec(-1.0));
                    if self.take_team_life(team) {
                        if let Some(r) = self.eo.players.get_mut(id) {
                            r.respawn = 30.0;
                        }
                    }
                }
            }
            Mode::Endless => {
                if team == 1.0 {
                    self.eo.players.insert(id, rec(30.0));
                }
            }
            Mode::Base => {}
        }
    }

    /// `H_`: take a life from the team pool (lives teams).
    fn take_team_life(&mut self, team: f64) -> bool {
        if team == 2.0 && self.eo.red > 0.0 {
            self.eo.red -= 1.0;
            return true;
        }
        if team == 3.0 && self.eo.blue > 0.0 {
            self.eo.blue -= 1.0;
            return true;
        }
        false
    }

    /// `nr`: schedule a respawn.
    fn respawn_in(&mut self, id: u32, ticks: f64) {
        let over = self.round_over() || self.game_over();
        match self.mode {
            Mode::Kills => {
                if !over {
                    if let Some(r) = self.eo.players.get_mut(id) {
                        r.respawn = ticks;
                    }
                }
            }
            Mode::Lives => {
                if !over {
                    if let Some(r) = self.eo.players.get_mut(id) {
                        if r.lives > 0.0 {
                            r.respawn = ticks;
                        }
                    }
                }
            }
            Mode::Rounds | Mode::TeamRounds => {}
            Mode::LivesTeams => {
                if over {
                    return;
                }
                let Some(team) = self.eo.players.get(id).map(|r| r.team) else { return };
                if self.take_team_life(team) {
                    if let Some(r) = self.eo.players.get_mut(id) {
                        r.respawn = ticks;
                    }
                }
            }
            _ => {
                if let Some(r) = self.eo.players.get_mut(id) {
                    r.respawn = ticks;
                }
            }
        }
    }

    /// `rr`: `killer` killed `victim`.
    fn kill(&mut self, killer: f64, victim: f64, gs: &GameSettings) {
        // base
        let (Some(k), v) = (index_of(killer), index_of(victim)) else { return };
        if self.eo.players.contains(k) && !self.game_over() {
            let r = self.eo.players.get_mut(k).expect("record");
            r.kills += 1.0;
            r.last_victim = victim;
            r.kill_timer = BANNER_TICKS;
            if let Some(vr) = v.and_then(|v| self.eo.players.get_mut(v)) {
                vr.killed_by = killer;
                vr.death_timer = BANNER_TICKS;
            }
        }
        match self.mode {
            Mode::Kills => {
                if let Some(r) = self.eo.players.get(k) {
                    if r.kills >= gs.objective_limit {
                        self.eo.game_over = GAME_OVER_TICKS;
                        self.eo.winner = killer;
                    }
                }
            }
            Mode::Lives => {
                if let Some(v) = v {
                    if let Some(vr) = self.eo.players.get_mut(v) {
                        vr.lives -= 1.0;
                    }
                    self.eliminated(v);
                }
                self.lives_check(1);
            }
            Mode::Rounds | Mode::TeamRounds => {
                self.changed = true;
                if let Some(vr) = v.and_then(|v| self.eo.players.get_mut(v)) {
                    vr.alive = false;
                }
            }
            Mode::EndlessTeams => {
                if !self.round_over() && !self.game_over() {
                    let team = v.and_then(|v| self.eo.players.get(v)).map(|r| r.team);
                    if team == Some(2.0) && !self.has_objectives {
                        self.eo.blue += 1.0;
                    }
                    if team == Some(3.0) && !self.has_objectives {
                        self.eo.red += 1.0;
                    }
                }
            }
            _ => {}
        }
    }

    /// `lr`: suicide / environmental death.
    fn suicide(&mut self, id: f64) {
        let Some(i) = index_of(id) else { return };
        if self.eo.players.contains(i) && !self.game_over() {
            self.eo.players.get_mut(i).expect("record").suicide_timer = BANNER_TICKS;
        }
        match self.mode {
            Mode::Lives => {
                if let Some(r) = self.eo.players.get_mut(i) {
                    r.lives -= 1.0;
                }
                self.eliminated(i);
                self.lives_check(1);
            }
            Mode::Rounds | Mode::TeamRounds => {
                self.changed = true;
                if let Some(r) = self.eo.players.get_mut(i) {
                    r.alive = false;
                }
            }
            _ => {}
        }
    }

    /// `W_`: record elimination order.
    fn eliminated(&mut self, id: u32) {
        if let Some(r) = self.eo.players.get(id) {
            if r.lives == 0.0 {
                self.eo.eliminations += 1.0;
                let n = self.eo.eliminations;
                self.eo.players.get_mut(id).expect("record").eliminated = n;
            }
        }
    }

    /// `U_`: last player with lives wins.
    fn lives_check(&mut self, min_players: usize) {
        let mut total = 0;
        let mut with_lives = 0;
        let mut last = -1.0;
        for (_, r) in self.eo.players.iter() {
            total += 1;
            if r.lives > 0.0 {
                with_lives += 1;
                last = r.id;
            }
        }
        if with_lives == 1 && total > min_players {
            self.eo.game_over = GAME_OVER_TICKS;
            self.eo.winner = last;
        }
    }

    /// `dr`: objective delivered for `team`.
    fn objective(&mut self, team: f64, gs: &GameSettings) {
        match self.mode {
            Mode::EndlessTeams => {
                if self.round_over() || self.game_over() {
                    return;
                }
                let mut win = false;
                if team == 2.0 {
                    self.eo.red += 1.0;
                    if self.eo.red >= gs.objective_limit {
                        win = true;
                    }
                }
                if team == 3.0 {
                    self.eo.blue += 1.0;
                    if self.eo.blue >= gs.objective_limit {
                        win = true;
                    }
                }
                self.eo.objective_team = team;
                if win {
                    self.eo.game_over = GAME_OVER_TICKS;
                } else {
                    self.eo.round_over = ROUND_OVER_TICKS;
                }
            }
            Mode::LivesTeams => {
                if !(self.round_over() || self.game_over()) {
                    self.eo.objective_team = team;
                    self.eo.game_over = GAME_OVER_TICKS;
                }
            }
            _ => {}
        }
    }

    /// `pr`: all capture points owned by `owner`.
    fn capture_win(&mut self, owner: f64) {
        self.eo.game_over = GAME_OVER_TICKS;
        self.eo.winner = owner;
    }

    /// `ro` (mode part).
    fn post_step(&mut self, prev_players: &[(f64, f64, f64)]) {
        for (_, r) in self.eo.players.iter_mut() {
            if r.kill_timer > -1.0 {
                r.kill_timer -= 1.0;
            }
            if r.death_timer > -1.0 {
                r.death_timer -= 1.0;
            }
            if r.suicide_timer > -1.0 {
                r.suicide_timer -= 1.0;
            }
        }
        match self.mode {
            Mode::Lives => {
                // `j_`: track the lowest lives left (for late joiners)
                let mut low = f64::INFINITY;
                let ids: Vec<u32> = self.eo.players.ids().collect();
                for id in ids {
                    let lives = self.eo.players.get(id).expect("record").lives;
                    if lives < low {
                        low = lives;
                    }
                    if low < self.eo.min_lives || self.eo.min_lives == -1.0 {
                        self.eo.min_lives = low;
                    }
                }
            }
            Mode::LivesTeams => {
                if self.game_over() || self.round_over() {
                    return;
                }
                let alive = |team: f64, me: &Self| {
                    prev_players.iter().any(|p| p.2 == team) || me.eo.players.values().any(|r| r.team == team && r.respawn > -1.0)
                };
                if self.eo.red <= 0.0 && !alive(2.0, self) {
                    self.eo.objective_team = 3.0;
                    self.eo.game_over = GAME_OVER_TICKS;
                }
                if self.eo.blue <= 0.0 && !alive(3.0, self) {
                    self.eo.objective_team = 2.0;
                    self.eo.game_over = GAME_OVER_TICKS;
                }
            }
            _ => {}
        }
    }

    /// Rounds modes: decide the round (`D_`).
    fn rounds_decide(&mut self, gs: &GameSettings) {
        if self.round_over() || self.game_over() {
            return;
        }
        let initial = self.initial.as_ref().expect("rounds initial state");
        if self.mode == Mode::TeamRounds {
            let mut now = [0u32; 4];
            for r in self.eo.players.values() {
                if r.alive {
                    if let Some(t) = index_of(r.team).filter(|t| *t < 4) {
                        now[t as usize] += 1;
                    }
                }
            }
            let mut before = [0u32; 4];
            for r in initial.players.values() {
                if r.alive {
                    if let Some(t) = index_of(r.team).filter(|t| *t < 4) {
                        before[t as usize] += 1;
                    }
                }
            }
            let mut decided = false;
            if now[2] > 0 && now[3] == 0 && before[3] > 0 {
                self.eo.red += 1.0;
                decided = true;
                self.eo.objective_team = 2.0;
            }
            if now[3] > 0 && now[2] == 0 && before[2] > 0 {
                self.eo.blue += 1.0;
                decided = true;
                self.eo.objective_team = 3.0;
            }
            if now[2] == 0 && now[3] == 0 && before[2] > 0 && before[3] > 0 {
                self.eo.objective_team = -2.0;
                decided = true;
            }
            if now[2] == 0 && now[3] == 0 && ((before[2] > 0 && before[3] == 0) || (before[3] > 0 && before[2] == 0)) {
                self.eo.objective_team = -1.0;
                decided = true;
            }
            if decided {
                if self.eo.red >= gs.objective_limit || self.eo.blue >= gs.objective_limit {
                    self.eo.game_over = GAME_OVER_TICKS;
                } else {
                    self.eo.round_over = ROUND_OVER_TICKS;
                }
            }
            return;
        }
        let mut alive = 0;
        let mut last = -1.0;
        for r in self.eo.players.values() {
            if r.alive {
                alive += 1;
                last = r.id;
            }
        }
        let alive_before = initial.players.values().filter(|r| r.alive).count();
        if alive <= 1 {
            if alive == 1 {
                if let Some(r) = index_of(last).and_then(|l| self.eo.players.get_mut(l)) {
                    r.wins += 1.0;
                }
                self.eo.winner = last;
            } else if alive_before == 1 {
                self.eo.winner = -1.0;
            } else if alive_before > 1 {
                self.eo.winner = -2.0;
            }
            let wins = index_of(last).and_then(|l| self.eo.players.get(l)).map(|r| r.wins);
            if last >= 0.0 && wins.is_some_and(|w| w >= gs.objective_limit) {
                self.eo.game_over = GAME_OVER_TICKS;
            } else {
                self.eo.round_over = ROUND_OVER_TICKS;
            }
        }
    }

    /// Rounds modes: someone joined; end the round if at most one is alive (`L_`).
    fn rounds_joined(&mut self) {
        if self.round_over() || self.game_over() {
            return;
        }
        let alive = self.eo.players.values().filter(|r| r.alive).count();
        if alive <= 1 {
            self.eo.round_over = ROUND_OVER_TICKS;
            self.eo.winner = -1.0;
        }
    }

    /// `lo`: countdowns, respawn timers, spawn claims and spawning.
    fn serialize(&mut self, next: &mut State, prev_players: &[(f64, f64, f64)], prev_caps: &[MapCap], gs: &GameSettings) {
        if self.mode.rounds_like() {
            if self.changed {
                self.rounds_decide(gs);
            }
            if self.joined {
                self.rounds_joined();
            }
        }
        if self.eo.round_over > 0.0 {
            self.eo.round_over -= 1.0;
        }
        if self.eo.game_over > 0.0 {
            self.eo.game_over -= 1.0;
        }
        let mut claims: Vec<(f64, f64)> = Vec::new();
        for (_, r) in self.eo.players.iter_mut() {
            if r.respawn == 30.0 {
                claims.push((r.id, r.team));
            }
            if r.respawn > -1.0 {
                r.respawn -= 1.0;
            }
        }
        next.round = self.eo.clone();
        if !claims.is_empty() {
            if gs.fixed_spawns {
                for (id, _) in &claims {
                    if let Some(r) = index_of(*id).and_then(|i| next.round.players.get_mut(i)) {
                        r.spawn = *id;
                    }
                }
            } else {
                claim_spawns(&claims, next, prev_players, prev_caps);
            }
        }
        spawn_players(next, gs);
    }
}

/// Spawn candidate for respawn claims.
struct Cand {
    spawn: MapSpawn,
    /// distance to the nearest player
    dist: f64,
    index: f64,
    claimed: bool,
    claim_time: f64,
}

/// `hr`: pick a spawn for every claim (farthest from players, team-aware,
/// following capture-point progress in team modes).
fn claim_spawns(claims: &[(f64, f64)], next: &mut State, prev_players: &[(f64, f64, f64)], prev_caps: &[MapCap]) {
    let spawns: Vec<(u32, MapSpawn)> = next.spawns.iter().map(|(k, s)| (k, s.clone())).collect();
    let mut usable = [false; 5];
    for (_, s) in &spawns {
        for (u, t) in usable.iter_mut().zip(s.teams.iter()) {
            *u = *u || *t;
        }
    }
    let mut cands: Vec<Cand> = Vec::with_capacity(spawns.len());
    for (k, s) in &spawns {
        let mut best = 9999999.0;
        for p in prev_players {
            let dx = p.0 - s.x;
            let dy = p.1 - s.y;
            let d = (dx * dx + dy * dy).sqrt();
            if d < best {
                best = d;
            }
        }
        let mut claimed = false;
        let mut claim_time = -1.0;
        for r in next.round.players.values() {
            if r.spawn == *k as f64 {
                claimed = true;
                claim_time = r.respawn;
            }
        }
        cands.push(Cand { spawn: s.clone(), dist: best, index: *k as f64, claimed, claim_time });
    }
    for &(id, team) in claims {
        let ti = index_of(team).filter(|t| *t < 5).map(|t| t as usize);
        let mut pool: Vec<usize> = (0..cands.len())
            .filter(|&c| match ti {
                Some(t) if usable[t] => cands[c].spawn.teams[t],
                _ => true,
            })
            .collect();
        if team == 2.0 || team == 3.0 {
            let mut front = if team == 2.0 { -1.0 } else { 999.0 };
            for cap in prev_caps {
                let owned = cap.owner == team;
                let mut matched = false;
                pool.retain(|&c| {
                    if cands[c].spawn.cap_sequence == cap.sequence {
                        matched = true;
                        owned
                    } else {
                        true
                    }
                });
                if owned && matched && ((team == 2.0 && cap.sequence > front) || (team == 3.0 && cap.sequence < front)) {
                    front = cap.sequence;
                }
            }
            if front != -1.0 && front != 999.0 {
                pool.retain(|&c| cands[c].spawn.cap_sequence == front);
            }
        }
        let all_claimed = pool.iter().all(|&c| cands[c].claimed);
        let respawn = index_of(id).and_then(|i| next.round.players.get(i)).map_or(-1.0, |r| r.respawn);
        if all_claimed {
            pool.sort_by(|&a, &b| cands[a].claim_time.partial_cmp(&cands[b].claim_time).unwrap_or(std::cmp::Ordering::Equal));
            if let Some(&c) = pool.first() {
                if let Some(r) = index_of(id).and_then(|i| next.round.players.get_mut(i)) {
                    r.spawn = cands[c].index;
                }
                cands[c].claimed = true;
                cands[c].claim_time = respawn;
            }
        } else {
            pool.sort_by(|&a, &b| cands[b].dist.partial_cmp(&cands[a].dist).unwrap_or(std::cmp::Ordering::Equal));
            for &c in &pool {
                if !cands[c].claimed {
                    if let Some(r) = index_of(id).and_then(|i| next.round.players.get_mut(i)) {
                        r.spawn = cands[c].index;
                    }
                    cands[c].claimed = true;
                    cands[c].claim_time = respawn;
                    break;
                }
            }
        }
    }
}

/// `er`: players whose respawn countdown hit 0 appear at their claimed spawn.
fn spawn_players(next: &mut State, gs: &GameSettings) {
    let ids: Vec<u32> = next.round.players.ids().collect();
    for id in ids {
        let (respawn, spawn, team, pid) = {
            let r = next.round.players.get(id).expect("record");
            (r.respawn, r.spawn, r.team, r.id)
        };
        if respawn != 0.0 || spawn == -1.0 {
            continue;
        }
        let Some(s) = index_of(spawn).and_then(|k| next.spawns.get(k)).cloned() else { continue };
        let p = Player {
            id: pid,
            x: s.x,
            y: s.y,
            spawn_x: s.x,
            spawn_y: s.y,
            team,
            teleported: true,
            angle: s.angle,
            stamina: gs.max_stamina,
            ..Player::default()
        };
        if let Some(pi) = index_of(pid) {
            next.players.insert(pi, p);
        }
        let r = next.round.players.get_mut(id).expect("record");
        r.alive = true;
        r.mo.clear();
        r.spawn = -1.0;
        next.sounds.push(Sound { x: s.x, y: s.y, ttl: 15.0, kind: sound::SPAWN, player: pid, ..Sound::default() });
    }
}

// ------------------------------------------------------------------ step hooks

fn prev_player_list(players: &Sparse<Player>) -> Vec<(f64, f64, f64)> {
    players.values().map(|p| (p.x, p.y, p.team)).collect()
}

/// Intro countdown tick (`qo` + `lo` only).
pub(crate) fn intro_tick(next: &mut State, events: Option<&Events>, gs: &GameSettings) {
    let mut obj = RoundObj::new(next.round.clone(), gs).with_bodies(&next.bodies);
    if let Some(ev) = events {
        for id in &ev.removed {
            obj.leave(*id);
        }
        for (id, team) in &ev.joined {
            obj.join(*id, *team, gs);
        }
    }
    let prev = prev_player_list(&next.players);
    let caps = next.caps.clone();
    obj.serialize(next, &prev, &caps, gs);
}

pub(crate) fn events(ctx: &mut Ctx<'_>, events: Option<&Events>) {
    let gs = ctx.gs;
    if let Some(ev) = events {
        for id in &ev.removed {
            ctx.round.leave(*id);
        }
        for (id, team) in &ev.joined {
            ctx.round.join(*id, *team, gs);
        }
    }
}

/// `ao`: tick counter.
pub(crate) fn pre_step(ctx: &mut Ctx<'_>) {
    ctx.round.eo.ticks += 1.0;
}

pub(crate) fn post_step(ctx: &mut Ctx<'_>) {
    let prev = ctx.prev_players.clone();
    ctx.round.post_step(&prev);
}

pub(crate) fn serialize(ctx: &mut Ctx<'_>, next: &mut State) {
    let gs = ctx.gs;
    let prev = ctx.prev_players.clone();
    let caps = ctx.prev_caps.clone();
    ctx.round.serialize(next, &prev, &caps, gs);
}

pub(crate) fn kill(ctx: &mut Ctx<'_>, killer: f64, victim: f64) {
    let gs = ctx.gs;
    ctx.round.kill(killer, victim, gs);
}

pub(crate) fn suicide(ctx: &mut Ctx<'_>, id: f64) {
    ctx.round.suicide(id);
}

pub(crate) fn respawn_in(ctx: &mut Ctx<'_>, id: f64, ticks: f64) {
    if let Some(i) = index_of(id) {
        ctx.round.respawn_in(i, ticks);
    }
}

pub(crate) fn objective(ctx: &mut Ctx<'_>, team: f64) {
    let gs = ctx.gs;
    ctx.round.objective(team, gs);
}

pub(crate) fn capture_win(ctx: &mut Ctx<'_>, owner: f64) {
    ctx.round.capture_win(owner);
}

pub(crate) fn round_over(ctx: &Ctx<'_>) -> bool {
    ctx.round.round_over()
}

pub(crate) fn game_over(ctx: &Ctx<'_>) -> bool {
    ctx.round.game_over()
}
