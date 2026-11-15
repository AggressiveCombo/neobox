//! The checkpoint race of the heav.io builds (August to October 2023),
//! which the original dropped on 1 November 2023 while keeping its state
//! slots. Bodies numbered with a checkpoint (`31`) are passed in order; the
//! highest number is the finish. Players who die after passing a checkpoint
//! come back at it with their run time still running. A finish takes the
//! player out of the run: with `recordMode` they stay out of the round,
//! otherwise they respawn for a new run 60 ticks later. Race objects (`34`)
//! are carried through the checkpoints instead, and their finish ends the
//! round. Maps without checkpoints play exactly as in the current original.
//!
//! Reference: heav.io `bundle.js` of 2023-10-29 (player `Ye`/`Tl`/`xa`, map
//! body `Ye`/`Fr`/`Or`, game state `jn`/`Hn`/`Jn`/`Wn`/`Yn`).

use crate::step::{kind, v2, Ctx};
use neobox_box2d::World;
use std::sync::Arc;

/// Ticks before a finisher starts a new run (`zn(id, 60)`).
const FINISH_RESPAWN: f64 = 60.0;
/// Round-over countdown after a race object's finish (`Wn`).
const OBJECT_FINISH_ROUND_OVER: f64 = 60.0;
/// `Mh < 15`: the reset key works while this counter (never changed by the
/// heav.io builds, so always) is below 15.
const RESET_LIMIT: f64 = 15.0;

/// `yn`/`vn` of the map: the finish (highest checkpoint number, 0 = no race)
/// and whether a race object is in play.
pub(crate) fn course(bodies: &crate::state::Sparse<crate::state::Body>) -> (f64, bool) {
    let mut finish = 0.0;
    let mut object = false;
    for b in bodies.values() {
        if b.def.checkpoint > finish {
            finish = b.def.checkpoint;
        }
        object |= b.def.race_object;
    }
    (finish, object)
}

/// `Tl`: send player `i` back to its last checkpoint at the end of the tick
/// (the checkpoint body's position at the start of the tick; when several
/// bodies share the number, the last one counts).
pub(crate) fn back_to_checkpoint(ctx: &mut Ctx<'_>, i: usize) {
    let n = ctx.players[i].eo.checkpoint;
    let mut at = None;
    for b in &ctx.bodies {
        if b.eo.def.checkpoint == n {
            at = Some((b.eo.x, b.eo.y));
        }
    }
    if at.is_some() {
        ctx.players[i].to_checkpoint = at;
    }
}

/// `xa`: with the bat switched off, the bat key returns a player who has
/// passed a checkpoint to it.
pub(crate) fn reset_key(ctx: &mut Ctx<'_>, i: usize, bat_key: bool) {
    let p = &ctx.players[i].eo;
    if bat_key && !ctx.gs.bat_enabled && p.checkpoint > 0.0 && p.en < RESET_LIMIT {
        back_to_checkpoint(ctx, i);
    }
}

/// Player `i` touched the next checkpoint this tick (`rl`).
pub(crate) fn passed(ctx: &mut Ctx<'_>, i: usize) {
    let (finish, object) = (ctx.race_finish, ctx.race_object);
    let p = &mut ctx.players[i];
    p.eo.checkpoint += 1.0;
    let (id, k, age) = (p.id(), p.eo.checkpoint, p.eo.age);
    if k == finish && !object {
        // the run is over: the player leaves without dying
        p.gone = true;
        if ctx.gs.record_mode {
            crate::round::race_out(ctx, id);
        } else {
            crate::round::respawn_in(ctx, id, FINISH_RESPAWN);
        }
    }
    if object && k == finish {
        ctx.players[i].eo.checkpoint -= 1.0;
    } else {
        split(ctx, id, age, k, finish);
    }
}

/// `jn`: player `id` reached checkpoint `k` at run time `t`.
fn split(ctx: &mut Ctx<'_>, id: f64, t: f64, k: f64, finish: f64) {
    let Some(r) = crate::state::index_of(id).and_then(|id| ctx.round.eo.players.get_mut(id)) else { return };
    let Some(slot) = crate::state::index_of(k).map(|k| k as usize) else { return };
    r.fo = t;
    if r.mo.len() <= slot {
        r.mo.resize(slot + 1, f64::NAN);
    }
    r.mo[slot] = t;
    if k == finish {
        if r.co != 0.0 {
            r.yo = t - r.co;
        }
        if r.co == 0.0 || r.co > t {
            r.co = t;
            r.wo = r.mo.clone();
        }
        r.po = t;
    } else if let Some(best) = r.wo.get(slot).copied().filter(|b| *b != 0.0 && !b.is_nan()) {
        r.yo = t - best;
    }
}

/// `Hn`: the run time of every player on a race map, each tick.
pub(crate) fn run_time(ctx: &mut Ctx<'_>, i: usize) {
    if ctx.race_finish <= 0.0 {
        return;
    }
    let (id, age) = (ctx.players[i].index, ctx.players[i].eo.age);
    if let Some(r) = ctx.round.eo.players.get_mut(id) {
        r.do_ = age;
    }
}

/// `Or` (race object part): body `i` touched `other`'s checkpoint, the next
/// one it has to reach.
pub(crate) fn object_touch(ctx: &mut Ctx<'_>, i: usize, other_kind: u32, other: usize) {
    let def = &ctx.bodies[i].eo.def;
    if !def.race_object || other_kind != kind::BODY {
        return;
    }
    let next = def.race_progress + 1.0;
    if ctx.bodies[other].eo.def.checkpoint == next {
        ctx.bodies[i].race_passed = true;
    }
}

/// `Ye`/`Fr` of a race object after the physics step: a race object that
/// left the arena while nobody holds it goes back to its last checkpoint (or
/// restarts the round before the first one); passing the finish ends the
/// round.
pub(crate) fn object_step(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    if !ctx.bodies[i].eo.def.race_object {
        return;
    }
    let Some(body) = ctx.bodies[i].body else { return };
    let pos = world.store().body(body).get_position();
    if !in_arena(pos.x, pos.y, ctx.settings.width, ctx.settings.height) && !held(ctx, ctx.bodies[i].index as f64) {
        let progress = ctx.bodies[i].eo.def.race_progress;
        if progress == 0.0 {
            object_finish(ctx);
        } else {
            let mut at = None;
            for b in &ctx.bodies {
                if b.eo.def.checkpoint == progress {
                    at = Some((b.eo.x, b.eo.y));
                }
            }
            if let Some((x, y)) = at {
                world.set_position(body, v2(x, y));
                world.store_mut().body_mut(body).set_linear_velocity(v2(0.0, 0.0));
                ctx.bodies[i].eo.teleported = true;
            }
        }
    }
    if ctx.bodies[i].race_passed {
        let o = &mut ctx.bodies[i];
        let mut def = (*o.eo.def).clone();
        def.race_progress += 1.0;
        let done = def.race_progress == ctx.race_finish;
        o.eo.def = Arc::new(def);
        if done {
            object_finish(ctx);
        }
    }
}

/// `Jn`/`Wn`: a race object finished (or restarted): the round ends in 2 s.
fn object_finish(ctx: &mut Ctx<'_>) {
    let r = &mut ctx.round.eo;
    if r.round_over <= -1.0 && r.game_over <= -1.0 {
        r.round_over = OBJECT_FINISH_ROUND_OVER;
    }
}

/// A player holds body `id` with a grab.
fn held(ctx: &Ctx<'_>, id: f64) -> bool {
    ctx.players.iter().any(|p| {
        p.eo.grabs.iter().any(|g| g.state == crate::state::ATTACH_ON && g.kind == kind::BODY as f64 && g.target == id)
    })
}

/// `Ut`: inside the arena, allowing half the arena width beyond the sides and
/// the top (measured from the corners above the arena); never below it.
fn in_arena(x: f64, y: f64, w: f64, h: f64) -> bool {
    let margin = w / 2.0;
    let left = x < 0.0;
    let right = x > w;
    let above = y < 0.0;
    if y > h {
        return false;
    }
    if left && !above && x < -margin {
        return false;
    }
    if right && !above && x > w + margin {
        return false;
    }
    if above && !left && !right && y < -margin {
        return false;
    }
    if above && left && (x * x + y * y).sqrt() > margin {
        return false;
    }
    if above && right {
        let dx = x - w;
        if (dx * dx + y * y).sqrt() > margin {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::in_arena;

    #[test]
    fn arena_bounds() {
        assert!(in_arena(5.0, 5.0, 10.0, 10.0));
        assert!(!in_arena(5.0, 10.1, 10.0, 10.0), "below the arena");
        assert!(in_arena(-4.9, 5.0, 10.0, 10.0), "within half a width to the side");
        assert!(!in_arena(-5.1, 5.0, 10.0, 10.0));
        assert!(!in_arena(15.1, 5.0, 10.0, 10.0));
        assert!(!in_arena(5.0, -5.1, 10.0, 10.0), "above");
        assert!(in_arena(-3.0, -3.0, 10.0, 10.0), "near the top corner");
        assert!(!in_arena(-4.0, -4.0, 10.0, 10.0), "beyond the corner radius");
    }
}
