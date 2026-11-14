//! Room/game settings (the original's settings class), with the original
//! defaults and the `/set <name> <value>` parameter names.

/// Game modes.
pub mod mode {
    pub const KILLS: i32 = 0;
    pub const LIVES: i32 = 1;
    pub const ROUNDS: i32 = 2;
    pub const TEAM_ROUNDS: i32 = 3;
    pub const ENDLESS_TEAMS: i32 = 4;
    pub const LIVES_TEAMS: i32 = 5;
    pub const ENDLESS: i32 = 6;
}

/// Missing fields deserialise to their defaults, so `{}` is the default
/// settings (offline games, older replays).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct GameSettings {
    /// `gsFightersCollide`: players' contact rays see other players.
    pub fighters_collide: bool,
    pub record_mode: bool,
    /// `W`
    pub w: bool,
    /// `J` timeScale: physics step is `1 / time_scale` seconds per tick.
    pub time_scale: f64,
    /// `G` gravityOffset added to the map gravity.
    pub gravity_offset: f64,
    /// `H` gameMode.
    pub game_mode: i32,
    /// `Y` pushPlayers.
    pub push_players: bool,
    /// `q` pushRange.
    pub push_range: f64,
    /// `V` pushDelay.
    pub push_delay: f64,
    /// `K` maxStamina.
    pub max_stamina: f64,
    /// `X` pushMinAmmoToStartPush.
    pub push_min_ammo: f64,
    /// `Z` pushAmmoSpendIfPushing.
    pub push_spend: f64,
    /// `$` pushAmmoSpendAtFirstPushFrame.
    pub push_first_spend: f64,
    /// `tt` pushAmmoReplenish.
    pub ammo_regen: f64,
    /// `it` bbPower.
    pub bat_power: f64,
    /// `st` bbRange.
    pub bat_range: f64,
    /// `ht` bbAngleVariance (degrees).
    pub bat_angle: f64,
    /// `et` bbHoldUntil.
    pub bat_hold_until: f64,
    /// `nt` bbFireOn.
    pub bat_fire_on: f64,
    /// `ot` bbInitAmmoCost.
    pub bat_init_cost: f64,
    /// `rt` bbHoldAmmoCost.
    pub bat_hold_cost: f64,
    /// `at` bbFireFramesLength.
    pub bat_fire_frames: f64,
    /// `lt` bbHideAfterFireFrames.
    pub bat_hide_after: f64,
    /// `ut` bbResetOn.
    pub bat_reset_on: f64,
    /// `ct` bbEnabled.
    pub bat_enabled: bool,
    /// `dt` dashInitDelay.
    pub dash_init_delay: f64,
    /// `wt` dashActiveLength.
    pub dash_active: f64,
    /// `ft` dashCoolDownAfterLength.
    pub dash_cooldown: f64,
    /// `gt` dashBoostSpeed.
    pub dash_boost: f64,
    /// `yt` dashAmmoCost.
    pub dash_cost: f64,
    /// `bt` dashEnabled.
    pub dash_enabled: bool,
    /// `vt` parachuteEnabled.
    pub parachute_enabled: bool,
    /// `kt` rkAmmoNeeded.
    pub rocket_cost: f64,
    /// `St` rkVelocity.
    pub rocket_speed: f64,
    /// `Nt` rkAimRate.
    pub rocket_aim_rate: f64,
    /// `Mt` rkBulletRound.
    pub rocket_round: bool,
    /// `Ct` rkBulletRadius.
    pub rocket_radius: f64,
    /// `Tt` rkBulletAge.
    pub rocket_age: f64,
    /// `xt` rkBulletTurnRate.
    pub rocket_turn_rate: f64,
    /// `_t` rkBulletGravityScale.
    pub rocket_gravity_scale: f64,
    /// `Pt` rkBulletBounces.
    pub rocket_bounces: bool,
    /// `Et` rkBulletRestitution.
    pub rocket_restitution: f64,
    /// `Bt` rkBulletBounceCountLimit.
    pub rocket_bounce_limit: f64,
    /// `It` rkSelfBatScale.
    pub rocket_self_bat_scale: f64,
    /// `Ft` rkExplodeRadius.
    pub rocket_explode_radius: f64,
    /// `At` rkExplodePush.
    pub rocket_explode_push: f64,
    /// `Ot` egEnabled.
    pub egg_enabled: bool,
    /// `Rt` egSize.
    pub egg_size: f64,
    /// `Dt` egAge.
    pub egg_age: f64,
    /// `Lt` egGravityScale (unused by the original's throw code).
    pub egg_gravity_scale: f64,
    /// `Ut` egRestitution.
    pub egg_restitution: f64,
    /// `jt` egExplodeRadius.
    pub egg_explode_radius: f64,
    /// `Wt` egStartSpin.
    pub egg_spin: f64,
    /// `Jt` egMaxThrowPower.
    pub egg_power: f64,
    /// `Gt` egAmmoNeeded.
    pub egg_cost: f64,
    /// `Ht` egDelay1.
    pub egg_delay1: f64,
    /// `zt` egDelay2.
    pub egg_delay2: f64,
    /// `Yt` egDelayBeforeAmmoUse.
    pub egg_delay_ammo: f64,
    /// `qt` egAimRate.
    pub egg_aim_rate: f64,
    /// `Vt` egShape.
    pub egg_shape: f64,
    /// `Kt`/`Xt` playerSize (width/height).
    pub player_width: f64,
    pub player_height: f64,
    /// `Zt` objectiveLimit (lives, kills, rounds, score...).
    pub objective_limit: f64,
    /// `Qt` credited kills before becoming a ghost (0 = never).
    pub ghost_after: f64,
    /// `$t` ghost linear damping.
    pub ghost_damping: f64,
    /// `ti` ghost move force.
    pub ghost_force: f64,
    /// `ii` ghost stamina regen.
    pub ghost_regen: f64,
    /// `si` ghost rocket speed.
    pub ghost_rocket_speed: f64,
    /// `hi` ghost rocket radius.
    pub ghost_rocket_radius: f64,
    /// `ei` ghost rocket age.
    pub ghost_rocket_age: f64,
    /// `ni` ghost rocket turn rate.
    pub ghost_rocket_turn: f64,
    /// `oi` ghost rocket explode radius.
    pub ghost_rocket_explode: f64,
    /// `ri` fixed spawn assignment (spawn index = player id).
    pub fixed_spawns: bool,
}

impl Default for GameSettings {
    fn default() -> Self {
        GameSettings {
            fighters_collide: false,
            record_mode: false,
            w: false,
            time_scale: 30.0,
            gravity_offset: 0.0,
            game_mode: mode::LIVES,
            push_players: true,
            push_range: 7.0,
            push_delay: 1.0,
            max_stamina: 100.0,
            push_min_ammo: 10.0,
            push_spend: 5.0,
            push_first_spend: 10.0,
            ammo_regen: 1.0,
            bat_power: 120.0,
            bat_range: 2.1,
            bat_angle: 30.0,
            bat_hold_until: 8.0,
            bat_fire_on: 13.0,
            bat_init_cost: 0.0,
            bat_hold_cost: 1.5,
            bat_fire_frames: 3.0,
            bat_hide_after: 3.0,
            bat_reset_on: 35.0,
            bat_enabled: true,
            dash_init_delay: 3.0,
            dash_active: 6.0,
            dash_cooldown: 8.0,
            dash_boost: 15.0,
            dash_cost: 30.0,
            dash_enabled: false,
            parachute_enabled: false,
            rocket_cost: 70.0,
            rocket_speed: 15.0,
            rocket_aim_rate: 0.12,
            rocket_round: false,
            rocket_radius: 0.11,
            rocket_age: 70.0,
            rocket_turn_rate: 0.025,
            rocket_gravity_scale: 0.0,
            rocket_bounces: false,
            rocket_restitution: 1.0,
            rocket_bounce_limit: 5.0,
            rocket_self_bat_scale: 0.0,
            rocket_explode_radius: 1.0,
            rocket_explode_push: 40.0,
            egg_enabled: false,
            egg_size: 0.11,
            egg_age: 70.0,
            egg_gravity_scale: 1.0,
            egg_restitution: 0.5,
            egg_explode_radius: 3.0,
            egg_spin: 0.09,
            egg_power: 20.0,
            egg_cost: 75.0,
            egg_delay1: 5.0,
            egg_delay2: 40.0,
            egg_delay_ammo: 15.0,
            egg_aim_rate: 0.12,
            egg_shape: 2.0,
            player_width: 0.8,
            player_height: 0.8,
            objective_limit: 5.0,
            ghost_after: 0.0,
            ghost_damping: 2.0,
            ghost_force: 55.0,
            ghost_regen: 5.0,
            ghost_rocket_speed: 7.0,
            ghost_rocket_radius: 0.08,
            ghost_rocket_age: 70.0,
            ghost_rocket_turn: 0.025,
            ghost_rocket_explode: 1.0,
            fixed_spawns: false,
        }
    }
}

/// JS `parseFloat` (leading numeric prefix).
fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut end = 0;
    let mut seen_digit = false;
    let mut seen_dot = false;
    let mut seen_exp = false;
    if end < b.len() && (b[end] == b'+' || b[end] == b'-') {
        end += 1;
    }
    if t[end..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    while end < b.len() {
        let c = b[end];
        if c.is_ascii_digit() {
            seen_digit = true;
        } else if c == b'.' && !seen_dot && !seen_exp {
            seen_dot = true;
        } else if (c == b'e' || c == b'E') && seen_digit && !seen_exp {
            let mut k = end + 1;
            if k < b.len() && (b[k] == b'+' || b[k] == b'-') {
                k += 1;
            }
            if k < b.len() && b[k].is_ascii_digit() {
                seen_exp = true;
                end = k;
                continue;
            }
            break;
        } else {
            break;
        }
        end += 1;
    }
    if !seen_digit {
        return f64::NAN;
    }
    t[..end].parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `parseInt(s)` (base 10).
fn parse_int(s: &str) -> f64 {
    let t = s.trim_start();
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    let v: f64 = digits.parse().unwrap_or(f64::NAN);
    if neg { -v } else { v }
}

impl GameSettings {
    /// Team modes use teams 2 (red) and 3 (blue).
    pub fn is_team_mode(&self) -> bool {
        matches!(self.game_mode, 3..=5)
    }

    /// neobox safety limits for host settings. The original accepts any
    /// value, and some of them freeze or crash every client (e.g.
    /// `timeScale 0` makes the physics step infinite). Returns the first
    /// offending setting name.
    pub fn validate(&self) -> Result<(), &'static str> {
        let finite = |v: f64| v.is_finite();
        if !(finite(self.time_scale) && self.time_scale >= 1.0 && self.time_scale <= 1000.0) {
            return Err("timeScale (must be between 1 and 1000)");
        }
        if !(finite(self.player_width) && self.player_width >= 0.05 && self.player_width <= 20.0) {
            return Err("playerSize (must be between 0.05 and 20)");
        }
        let all = [
            ("gravityOffset", self.gravity_offset),
            ("pushRange", self.push_range),
            ("pushDelay", self.push_delay),
            ("maxStamina", self.max_stamina),
            ("bbPower", self.bat_power),
            ("bbRange", self.bat_range),
            ("rkVelocity", self.rocket_speed),
            ("rkBulletRadius", self.rocket_radius),
            ("rkExplodeRadius", self.rocket_explode_radius),
            ("rkExplodePush", self.rocket_explode_push),
            ("egSize", self.egg_size),
            ("egExplodeRadius", self.egg_explode_radius),
            ("egMaxThrowPower", self.egg_power),
            ("objectiveLimit", self.objective_limit),
        ];
        for (name, v) in all {
            if !finite(v) {
                return Err(name);
            }
        }
        if self.rocket_radius <= 0.0 || self.egg_size <= 0.0 {
            return Err("projectile size (must be positive)");
        }
        if self.rocket_explode_radius > 100.0 || self.egg_explode_radius > 100.0 {
            return Err("explosion radius (at most 100)");
        }
        Ok(())
    }

    /// Apply a `/set <name> <value>` command like the original (`wi`).
    /// Returns the confirmation text, or an error message.
    pub fn set(&mut self, name: &str, value: &str) -> Result<String, String> {
        let n = name.to_ascii_lowercase();
        let f = parse_float(value);
        let i = parse_int(value);
        let b = value == "true";
        macro_rules! fl {
            ($field:ident, $label:expr) => {{
                self.$field = f;
                Ok(format!("{}: {}", $label, js_num(self.$field)))
            }};
        }
        macro_rules! it {
            ($field:ident, $label:expr) => {{
                self.$field = i;
                Ok(format!("{}: {}", $label, js_num(self.$field)))
            }};
        }
        macro_rules! bo {
            ($field:ident, $label:expr) => {{
                self.$field = b;
                Ok(format!("{}: {}", $label, self.$field))
            }};
        }
        match n.as_str() {
            "timescale" => fl!(time_scale, "timeScale"),
            "gravityoffset" => fl!(gravity_offset, "gravityOffset"),
            "gamemode" => {
                // parseInt; NaN behaves like an unknown mode (falls back to the base mode)
                self.game_mode = if i.is_nan() { -1 } else { i as i32 };
                Ok(format!("gameMode: {}", if i.is_nan() { "NaN".into() } else { self.game_mode.to_string() }))
            }
            "pushplayers" => bo!(push_players, "pushPlayers"),
            "pushrange" => fl!(push_range, "pushRange"),
            "pushdelay" => it!(push_delay, "pushDelay"),
            "maxstamina" => fl!(max_stamina, "maxStamina"),
            "pushminammotostartpush" => fl!(push_min_ammo, "pushminammotostartpush"),
            "pushammospendifpushing" => fl!(push_spend, "pushammospendifpushing"),
            "pushammospendatfirstpushframe" => fl!(push_first_spend, "pushammospendatfirstpushframe"),
            "pushammoreplenish" => fl!(ammo_regen, "pushammoreplenish"),
            "bbpower" => fl!(bat_power, "bbPower"),
            "bbrange" => fl!(bat_range, "bbRange"),
            "bbanglevariance" => fl!(bat_angle, "bbAngleVariance"),
            "bbfireon" => fl!(bat_fire_on, "bbFireOn"),
            "bbfireframeslength" => fl!(bat_fire_frames, "bbFireFramesLength"),
            "bbhideafterfireframes" => fl!(bat_hide_after, "bbHideAfterFireFrames"),
            "bbreseton" => fl!(bat_reset_on, "bbResetOn"),
            "bbenabled" => bo!(bat_enabled, "bbEnabled"),
            "bbholduntil" => fl!(bat_hold_until, "bbHoldUntil"),
            "bbinitammocost" => fl!(bat_init_cost, "bbInitAmmoCost"),
            "bbholdammocost" => fl!(bat_hold_cost, "bbHoldAmmoCost"),
            "dashinitdelay" => it!(dash_init_delay, "dashInitDelay"),
            "dashactivelength" => it!(dash_active, "dashActiveLength"),
            "dashcooldownafterlength" => it!(dash_cooldown, "dashCoolDownAfterLength"),
            "dashboostspeed" => it!(dash_boost, "dashBoostSpeed"),
            "dashammocost" => it!(dash_cost, "dashAmmoCost"),
            "dashenabled" => bo!(dash_enabled, "dashEnabled"),
            "parachuteenabled" => bo!(parachute_enabled, "parachuteEnabled"),
            "rkammoneeded" => fl!(rocket_cost, "rkAmmoNeeded"),
            "rkvelocity" => fl!(rocket_speed, "rkVelocity"),
            "rkaimrate" => fl!(rocket_aim_rate, "rkAimRate"),
            "rkbulletround" => bo!(rocket_round, "rkBulletRound"),
            "rkbulletradius" => fl!(rocket_radius, "rkBulletRadius"),
            "rkbulletage" => fl!(rocket_age, "rkBulletAge"),
            "rkbulletturnrate" => fl!(rocket_turn_rate, "rkBulletTurnRate"),
            "rkbulletgravityscale" => fl!(rocket_gravity_scale, "rkBulletGravityScale"),
            "rkbulletbounces" => bo!(rocket_bounces, "rkBulletBounces"),
            "rkbulletrestitution" => fl!(rocket_restitution, "rkBulletRestitution"),
            "rkbulletbouncecountlimit" => fl!(rocket_bounce_limit, "rkBulletBounceCountLimit"),
            "rkselfbatscale" => fl!(rocket_self_bat_scale, "rkSelfBatScale"),
            "rkexploderadius" => fl!(rocket_explode_radius, "rkExplodeRadius"),
            "rkexplodepush" => fl!(rocket_explode_push, "rkExplodePush"),
            "egenabled" => bo!(egg_enabled, "egEnabled"),
            "egsize" => fl!(egg_size, "egSize"),
            "egage" => fl!(egg_age, "egAge"),
            "eggravityscale" => fl!(egg_gravity_scale, "egGravityScale"),
            "egrestitution" => fl!(egg_restitution, "egRestitution"),
            "egexploderadius" => fl!(egg_explode_radius, "egExplodeRadius"),
            "egstartspin" => fl!(egg_spin, "egStartSpin"),
            "egmaxthrowpower" => fl!(egg_power, "egMaxThrowPower"),
            "egammoneeded" => fl!(egg_cost, "egAmmoNeeded"),
            "egdelay1" => it!(egg_delay1, "egDelay1"),
            "egdelay2" => it!(egg_delay2, "egDelay2"),
            "egdelaybeforeammouse" => it!(egg_delay_ammo, "egDelayBeforeAmmoUse"),
            "egaimrate" => fl!(egg_aim_rate, "egAimRate"),
            "egshape" => it!(egg_shape, "egShape"),
            "playersize" => {
                self.player_width = f;
                self.player_height = f;
                Ok(format!("playerSize: {}", js_num(f)))
            }
            "objectivelimit" => it!(objective_limit, "objectiveLimit"),
            _ => Err(format!("Couldn't find param {n}")),
        }
    }
}

/// JS-style number formatting for messages.
pub fn js_num(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_parses_like_js() {
        let mut s = GameSettings::default();
        assert_eq!(s.set("PushRange", "12.5abc").unwrap(), "pushRange: 12.5");
        assert_eq!(s.push_range, 12.5);
        s.set("dashInitDelay", "4.9").unwrap();
        assert_eq!(s.dash_init_delay, 4.0);
        s.set("playerSize", "1").unwrap();
        assert_eq!((s.player_width, s.player_height), (1.0, 1.0));
        assert!(s.set("nope", "1").is_err());
        s.set("bbEnabled", "yes").unwrap();
        assert!(!s.bat_enabled);
    }
}
