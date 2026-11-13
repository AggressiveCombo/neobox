//! Builds the per-frame render buffer (see docs/CLIENT-API.md) from two
//! consecutive simulation states.

use neobox_sim::map::{BodyDef, MapShape, SHAPE_CIRCLE};
use neobox_sim::state::{Body, Effect, Player, Projectile, State};
use neobox_sim::GameSettings;
use std::collections::HashMap;

pub const LAYOUT_VERSION: u32 = 1;
pub const HEADER_WORDS: usize = 32;
pub const PLAYER_WORDS: usize = 12;
pub const SOUND_WORDS: usize = 5;
pub const SCORE_WORDS: usize = 8;

/// Team colours (0xRRGGBB).
pub const RED: u32 = 0xd44234;
pub const BLUE: u32 = 0x347bd4;
/// FFA palette (original colours, chosen for neobox).
pub const PALETTE: [u32; 8] = [0x2f9bff, 0xffc94a, 0x4cd98b, 0xff6f91, 0xa98bff, 0xff9a3c, 0x3fd6d6, 0xd6e05a];

pub fn player_color(id: f64, team: f64) -> u32 {
    if team == 2.0 {
        RED
    } else if team == 3.0 {
        BLUE
    } else {
        PALETTE[(id.max(0.0) as usize) % PALETTE.len()]
    }
}

#[inline]
fn rgba(rgb: u32, alpha: f32) -> u32 {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    let r = (rgb >> 16) & 0xff;
    let g = (rgb >> 8) & 0xff;
    let b = rgb & 0xff;
    r | (g << 8) | (b << 16) | (a << 24)
}

/// Sound emitted this frame.
#[derive(Clone, Copy, Debug)]
pub struct SoundOut {
    pub kind: u32,
    pub x: f32,
    pub y: f32,
    pub volume: f32,
    pub player: i32,
}

/// Network/meta values shown in the header.
#[derive(Clone, Copy, Debug, Default)]
pub struct Meta {
    pub tick: u32,
    pub local: i32,
    pub prediction: f32,
    pub rollbacks_per_s: f32,
}

#[derive(Default)]
pub struct FrameBuilder {
    pub words: Vec<u32>,
    verts: Vec<u32>,
    /// triangulated local geometry per shape list (keyed by body definition)
    cache: HashMap<usize, Vec<Mesh>>,
    tmp: Vec<[f32; 2]>,
}

/// Local-space triangles of one shape and its colour.
struct Mesh {
    tris: Vec<[f32; 2]>,
    color: u32,
    z: f64,
}

fn circle_points(cx: f64, cy: f64, r: f64, out: &mut Vec<[f32; 2]>) {
    let n = ((r * 24.0).ceil() as usize).clamp(12, 64);
    let mut prev = [(cx + r) as f32, cy as f32];
    for i in 1..=n {
        let a = i as f64 / n as f64 * std::f64::consts::TAU;
        let p = [(cx + r * a.cos()) as f32, (cy + r * a.sin()) as f32];
        out.push([cx as f32, cy as f32]);
        out.push(prev);
        out.push(p);
        prev = p;
    }
}

fn area2(p: &[[f32; 2]]) -> f32 {
    let mut a = 0.0;
    for i in 0..p.len() {
        let j = (i + 1) % p.len();
        a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
    }
    a
}

/// Ear-clipping triangulation (falls back to a fan for degenerate input).
fn triangulate(pts: &[[f32; 2]], out: &mut Vec<[f32; 2]>) {
    let n = pts.len();
    if n < 3 {
        return;
    }
    let mut idx: Vec<usize> = (0..n).collect();
    if area2(pts) < 0.0 {
        idx.reverse();
    }
    let cross = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let inside = |p: [f32; 2], a: [f32; 2], b: [f32; 2], c: [f32; 2]| cross(a, b, p) >= 0.0 && cross(b, c, p) >= 0.0 && cross(c, a, p) >= 0.0;
    let mut guard = 0;
    while idx.len() > 3 && guard < n * n {
        guard += 1;
        let m = idx.len();
        let mut clipped = false;
        for i in 0..m {
            let (ia, ib, ic) = (idx[(i + m - 1) % m], idx[i], idx[(i + 1) % m]);
            let (a, b, c) = (pts[ia], pts[ib], pts[ic]);
            if cross(a, b, c) <= 0.0 {
                continue;
            }
            if idx.iter().any(|&k| k != ia && k != ib && k != ic && inside(pts[k], a, b, c)) {
                continue;
            }
            out.extend([a, b, c]);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break;
        }
    }
    if idx.len() >= 3 {
        for i in 1..idx.len() - 1 {
            out.extend([pts[idx[0]], pts[idx[i]], pts[idx[i + 1]]]);
        }
    }
}

fn shape_mesh(s: &MapShape, color: u32) -> Mesh {
    let mut tris = Vec::new();
    if s.kind == SHAPE_CIRCLE {
        circle_points(s.x, s.y, s.radius, &mut tris);
    } else {
        let pts: Vec<[f32; 2]> = s.points.iter().map(|p| [(p[0] + s.x) as f32, (p[1] + s.y) as f32]).collect();
        if pts.iter().all(|p| p[0].is_finite() && p[1].is_finite()) {
            triangulate(&pts, &mut tris);
        }
    }
    Mesh { tris, color, z: s.z_index }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn lerp_angle(a: f64, b: f64, t: f64) -> f64 {
    let mut d = (b - a) % std::f64::consts::TAU;
    if d > std::f64::consts::PI {
        d -= std::f64::consts::TAU;
    } else if d < -std::f64::consts::PI {
        d += std::f64::consts::TAU;
    }
    a + d * t
}

impl FrameBuilder {
    fn meshes(&mut self, def: &std::sync::Arc<BodyDef>) -> &Vec<Mesh> {
        let key = std::sync::Arc::as_ptr(def) as usize;
        if self.cache.len() > 4096 {
            self.cache.clear();
        }
        self.cache.entry(key).or_insert_with(|| {
            let mut v: Vec<Mesh> = def
                .shapes
                .iter()
                .map(|s| {
                    let c = if def.source_player > -1.0 { player_color(def.source_player, s.color) } else { s.color as u32 & 0xffffff };
                    shape_mesh(s, c)
                })
                .collect();
            v.sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
            v
        })
    }

    fn push_tri_list(&mut self, local: &[[f32; 2]], x: f64, y: f64, angle: f64, color: u32) {
        push_tris(&mut self.verts, local, x, y, angle, color);
    }

    fn quad_line(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, w: f64, color: u32) {
        let (dx, dy) = (x2 - x1, y2 - y1);
        let len = (dx * dx + dy * dy).sqrt();
        if !(len > 1e-9) {
            return;
        }
        let (nx, ny) = (-dy / len * w * 0.5, dx / len * w * 0.5);
        let p = [
            [(x1 + nx) as f32, (y1 + ny) as f32],
            [(x2 + nx) as f32, (y2 + ny) as f32],
            [(x2 - nx) as f32, (y2 - ny) as f32],
            [(x1 - nx) as f32, (y1 - ny) as f32],
        ];
        for i in [0, 1, 2, 0, 2, 3] {
            self.verts.extend([p[i][0].to_bits(), p[i][1].to_bits(), color]);
        }
    }

    fn ring(&mut self, x: f64, y: f64, r: f64, width: f64, color: u32) {
        let n = ((r * 16.0).ceil() as usize).clamp(12, 48);
        let (ri, ro) = ((r - width * 0.5).max(0.0), r + width * 0.5);
        for i in 0..n {
            let a0 = i as f64 / n as f64 * std::f64::consts::TAU;
            let a1 = (i + 1) as f64 / n as f64 * std::f64::consts::TAU;
            let p = |a: f64, rr: f64| [(x + rr * a.cos()) as f32, (y + rr * a.sin()) as f32];
            let q = [p(a0, ri), p(a0, ro), p(a1, ro), p(a1, ri)];
            for k in [0, 1, 2, 0, 2, 3] {
                self.verts.extend([q[k][0].to_bits(), q[k][1].to_bits(), color]);
            }
        }
    }

    fn disc(&mut self, x: f64, y: f64, r: f64, color: u32) {
        self.tmp.clear();
        let mut tmp = std::mem::take(&mut self.tmp);
        circle_points(0.0, 0.0, r, &mut tmp);
        self.push_tri_list(&tmp, x, y, 0.0, color);
        self.tmp = tmp;
    }

    fn body(&mut self, prev: Option<&Body>, cur: &Body, t: f64) {
        if cur.def.invisible {
            return;
        }
        let (x, y, a) = match prev {
            Some(p) if !cur.teleported && std::sync::Arc::ptr_eq(&p.def, &cur.def) => {
                (lerp(p.x, cur.x, t), lerp(p.y, cur.y, t), lerp_angle(p.angle, cur.angle, t))
            }
            _ => (cur.x, cur.y, cur.angle),
        };
        let key = std::sync::Arc::as_ptr(&cur.def) as usize;
        self.meshes(&cur.def);
        let meshes = &self.cache[&key];
        for m in meshes {
            push_tris(&mut self.verts, &m.tris, x, y, a, rgba(m.color, 1.0));
        }
    }

    fn projectile(&mut self, prev: Option<&Projectile>, q: &Projectile, t: f64) {
        let (x, y) = match prev {
            Some(p) => (lerp(p.x, q.x, t), lerp(p.y, q.y, t)),
            None => (q.x, q.y),
        };
        let angle = if q.align { q.vy.atan2(q.vx) } else { q.angle };
        let color = rgba(if q.team == 2.0 { RED } else if q.team == 3.0 { BLUE } else { 0xf2f2f2 }, 1.0);
        let u = q.size;
        let mut tris = Vec::new();
        if q.shape == 0.0 {
            circle_points(0.0, 0.0, u, &mut tris);
        } else if q.shape == 1.0 {
            let (w, h) = ((2.5 * u) as f32, u as f32);
            tris.extend([[-w, -h], [w, -h], [w, h], [-w, -h], [w, h], [-w, h]]);
        } else {
            let (w, h) = ((1.5 * u) as f32, u as f32);
            tris.extend([[-w, -h], [w, -h], [w, h], [-w, -h], [w, h], [-w, h]]);
            circle_points(-1.5 * u, 0.0, u, &mut tris);
            circle_points(1.5 * u, 0.0, u, &mut tris);
        }
        self.push_tri_list(&tris, x, y, angle, color);
    }

    fn effect(&mut self, e: &Effect) {
        let fade = (e.ttl / 15.0).clamp(0.15, 1.0) as f32;
        match e.kind as i64 {
            33 => {
                let c = rgba(player_color(e.player, e.team), 0.55 * fade);
                self.quad_line(e.x, e.y, e.x2, e.y2, 0.12, c);
            }
            43 => {
                let r = 0.6 + (4.0 - e.ttl).max(0.0) * 0.5;
                self.ring(e.x, e.y, r, 0.08, rgba(player_color(e.player, e.team), 0.5 * fade));
            }
            18 => self.ring(e.x, e.y, 0.25 + (15.0 - e.ttl).max(0.0) * 0.03, 0.06, rgba(0xffffff, 0.6 * fade)),
            0 => {
                let r = e.volume.max(0.2);
                self.disc(e.x, e.y, r * (1.0 - e.ttl / 10.0).max(0.3), rgba(0xffb347, 0.45 * fade));
            }
            _ => {}
        }
    }

    /// Build the frame for `cur`, interpolating from `prev` by `t` in [0, 1].
    pub fn build(&mut self, prev: &State, cur: &State, t: f64, gs: &GameSettings, meta: Meta, sounds: &[SoundOut]) {
        self.verts.clear();
        // bodies, back to front by z-index (stable)
        let mut order: Vec<(f64, u32)> = cur.bodies.iter().map(|(k, b)| (b.def.z_index, k)).collect();
        order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, id) in order {
            let b = cur.bodies.get(id).expect("body");
            self.body(prev.bodies.get(id), b, t);
        }
        // capture points
        for c in &cur.caps {
            let h = c.width / 2.0;
            let pts = [[-h - 0.5, 0.0], [-h, -0.5], [h, -0.5], [h + 0.5, 0.0]];
            let mut tris = Vec::new();
            triangulate(&pts.map(|p| [p[0] as f32, p[1] as f32]), &mut tris);
            let owner = if c.owner == 2.0 { RED } else if c.owner == 3.0 { BLUE } else if c.owner >= 0.0 { 0xffd440 } else { 0x9a9a9a };
            self.push_tri_list(&tris, c.x, c.y, 0.0, rgba(owner, 0.9));
            if c.progress > 0.0 && c.capture_time > 0.0 {
                let f = (c.progress / c.capture_time).clamp(0.0, 1.0);
                let col = if c.capturer == 2.0 { RED } else if c.capturer == 3.0 { BLUE } else { 0xffffff };
                self.quad_line(c.x - h, c.y - 0.9, c.x - h + 2.0 * h * f, c.y - 0.9, 0.18, rgba(col, 0.9));
            }
        }
        // turrets
        for (_, tu) in cur.turrets.iter() {
            let mut tris = Vec::new();
            let pts: Vec<[f32; 2]> = (0..8)
                .map(|g| {
                    let a = g as f64 * std::f64::consts::PI / 4.0 + std::f64::consts::PI / 8.0;
                    [(0.7 * a.cos()) as f32, (0.7 * a.sin()) as f32]
                })
                .collect();
            triangulate(&pts, &mut tris);
            let col = if tu.team == 2.0 { RED } else if tu.team == 3.0 { BLUE } else { 0x777777 };
            self.push_tri_list(&tris, tu.x, tu.y, 0.0, rgba(col, 1.0));
            if tu.max_health > 0.0 {
                let f = (tu.health / tu.max_health).clamp(0.0, 1.0);
                self.quad_line(tu.x - 0.6, tu.y - 1.0, tu.x - 0.6 + 1.2 * f, tu.y - 1.0, 0.1, rgba(0x6be675, 0.9));
            }
        }
        // parachutes and ability indicators
        for (id, p) in cur.players.iter() {
            let pp = prev.players.get(id);
            let (px, py) = interp_player(pp, p, t);
            if let Some(c) = &p.parachute {
                let w = gs.player_width;
                let h = 0.5 * gs.player_height / 2.0;
                let tris = [[-w, -h], [w, -h], [w, h], [-w, -h], [w, h], [-w, h]].map(|v| [v[0] as f32, v[1] as f32]);
                let col = rgba(player_color(p.id, p.team), 0.85);
                self.push_tri_list(&tris, c.x, c.y, c.angle, col);
                self.quad_line(px, py, c.x - w * c.angle.cos(), c.y - w * c.angle.sin(), 0.04, rgba(0xdddddd, 0.7));
                self.quad_line(px, py, c.x + w * c.angle.cos(), c.y + w * c.angle.sin(), 0.04, rgba(0xdddddd, 0.7));
            }
            let col = player_color(p.id, p.team);
            if p.rocket_frame >= 0.0 {
                let a = p.rocket_aim;
                let len = 1.2 + p.rocket_frame.min(8.0) * 0.08;
                self.quad_line(px, py, px + len * a.cos(), py + len * a.sin(), 0.07, rgba(col, 0.75));
            }
            if p.egg_frame > 0.0 {
                let a = p.egg_aim;
                self.quad_line(px, py, px + 1.4 * a.cos(), py + 1.4 * a.sin(), 0.07, rgba(col, 0.75));
            }
            if p.bat_frame >= 0.0 && p.bat_frame < gs.bat_fire_on + gs.bat_fire_frames {
                let a = p.bat_aim;
                let firing = p.bat_frame >= gs.bat_fire_on;
                let r = gs.bat_range;
                let span = gs.bat_angle.to_radians();
                let n = 10;
                let alpha = if firing { 0.55 } else { 0.18 };
                for i in 0..n {
                    let a0 = a - span + 2.0 * span * i as f64 / n as f64;
                    let a1 = a - span + 2.0 * span * (i + 1) as f64 / n as f64;
                    let tri = [[px, py], [px + r * a0.cos(), py + r * a0.sin()], [px + r * a1.cos(), py + r * a1.sin()]];
                    let c = rgba(0xffffff, alpha);
                    for v in tri {
                        self.verts.extend([(v[0] as f32).to_bits(), (v[1] as f32).to_bits(), c]);
                    }
                }
            }
        }
        for (_, q) in cur.projectiles.iter() {
            self.projectile(None, q, t);
        }
        for (_, e) in cur.effects.iter() {
            self.effect(e);
        }

        // ---- assemble
        let w = &mut self.words;
        w.clear();
        w.resize(HEADER_WORDS, 0);
        let f = |v: f64| (v as f32).to_bits();
        w[0] = LAYOUT_VERSION;
        w[1] = (self.verts.len() / 3) as u32;
        w[2] = HEADER_WORDS as u32;
        w.extend_from_slice(&self.verts);
        // players
        w[3] = cur.players.len() as u32;
        w[4] = w.len() as u32;
        for (id, p) in cur.players.iter() {
            let (x, y) = interp_player(prev.players.get(id), p, t);
            let angle = match prev.players.get(id) {
                Some(pp) if !p.teleported => lerp_angle(pp.angle, p.angle, t),
                _ => p.angle,
            };
            let mut flags = 0u32;
            if meta.local >= 0 && id == meta.local as u32 {
                flags |= 1;
            }
            if p.ghost {
                flags |= 2;
            }
            if p.frozen > 0.0 {
                flags |= 4;
            }
            if p.rocket_frame >= 0.0 {
                flags |= 8;
            }
            if p.bat_frame >= 0.0 {
                flags |= 16;
            }
            if p.push_frames > 0.0 {
                flags |= 32;
            }
            if p.dash_frame >= 0.0 {
                flags |= 64;
            }
            if p.teleported {
                flags |= 128;
            }
            let aim = if p.rocket_frame >= 0.0 { p.rocket_aim } else if p.egg_frame > 0.0 { p.egg_aim } else { p.bat_aim };
            w.extend([
                id,
                f(x),
                f(y),
                f(angle),
                p.team.max(0.0) as u32,
                f(p.stamina),
                flags,
                if p.attacker >= 0.0 { p.attacker as u32 } else { u32::MAX },
                f(gs.player_width),
                f(p.health),
                f(aim),
                0,
            ]);
        }
        w[5] = sounds.len() as u32;
        w[6] = w.len() as u32;
        for s in sounds {
            w.extend([s.kind, s.x.to_bits(), s.y.to_bits(), s.volume.to_bits(), s.player as u32]);
        }
        w[7] = cur.round.players.len() as u32;
        w[8] = w.len() as u32;
        // scores and lives can go negative in the original rules (kept for
        // identical gameplay); they are shown clamped at 0 (DEVIATIONS.md S5)
        let shown = |v: f64| f(v.max(0.0));
        for (id, r) in cur.round.players.iter() {
            w.extend([id, r.team.max(0.0) as u32, shown(r.kills), shown(r.wins), shown(r.lives), r.alive as u32, f(r.respawn), f(r.eliminated)]);
        }
        let st = &cur.settings;
        w[9] = f(st.screen_width);
        w[10] = f(st.width);
        w[11] = f(st.height);
        w[12] = st.color_top as u32 & 0xffffff;
        w[13] = st.color_bottom as u32 & 0xffffff;
        w[14] = meta.tick;
        w[15] = meta.local as u32;
        w[16] = f(cur.round.intro);
        w[17] = f(cur.round.round_over);
        w[18] = f(cur.round.game_over);
        w[19] = f(cur.round.winner);
        w[20] = f(cur.round.objective_team);
        w[21] = shown(cur.round.red);
        w[22] = shown(cur.round.blue);
        w[23] = gs.game_mode as u32;
        w[24] = f(gs.objective_limit);
        w[25] = f(gs.max_stamina);
        w[26] = f(cur.round.round_number);
        w[27] = st.wrap as u32;
        w[28] = meta.prediction.to_bits();
        w[29] = meta.rollbacks_per_s.to_bits();
    }
}

fn push_tris(verts: &mut Vec<u32>, local: &[[f32; 2]], x: f64, y: f64, angle: f64, color: u32) {
    let (s, c) = (angle.sin() as f32, angle.cos() as f32);
    let (x, y) = (x as f32, y as f32);
    for p in local {
        let wx = x + p[0] * c - p[1] * s;
        let wy = y + p[0] * s + p[1] * c;
        verts.extend([wx.to_bits(), wy.to_bits(), color]);
    }
}

fn interp_player(prev: Option<&Player>, p: &Player, t: f64) -> (f64, f64) {
    match prev {
        Some(pp) if !p.teleported => (lerp(pp.x, p.x, t), lerp(pp.y, p.y, t)),
        _ => (p.x, p.y),
    }
}

/// New sounds of `cur` relative to `prev` (sounds append after survivors).
pub fn new_sounds(prev: &State, cur: &State, out: &mut Vec<SoundOut>) {
    let survivors = prev.sounds.iter().filter(|s| s.ttl - 1.0 > 0.0).count();
    for s in cur.sounds.iter().skip(survivors) {
        out.push(SoundOut { kind: s.kind as u32, x: s.x as f32, y: s.y as f32, volume: s.volume as f32, player: s.player as i32 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concave_polygon_triangulates_to_its_area() {
        // an L shape with area 3
        let l = [[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [1.0, 1.0], [1.0, 2.0], [0.0, 2.0]];
        let mut out = Vec::new();
        triangulate(&l, &mut out);
        assert_eq!(out.len(), 12);
        let total: f32 = out.chunks(3).map(|t| area2(t).abs() / 2.0).sum();
        assert!((total - 3.0).abs() < 1e-5);
    }
}
