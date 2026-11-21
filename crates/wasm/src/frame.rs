//! Builds the per-frame render buffer (see docs/CLIENT-API.md) from two
//! consecutive simulation states.

use neobox_net::FedKeys;
use neobox_sim::map::{BodyDef, MapShape, BODY_STATIC, SHAPE_CIRCLE};
use neobox_sim::state::{Body, Effect, Player, Projectile, State, ATTACH_ON};
use neobox_sim::step::kind;
use neobox_sim::GameSettings;
use std::collections::HashMap;

pub const LAYOUT_VERSION: u32 = 9;
pub const HEADER_WORDS: usize = 43;
pub const PLAYER_WORDS: usize = 14;
pub const SOUND_WORDS: usize = 5;
pub const SCORE_WORDS: usize = 15;
pub const BAR_WORDS: usize = 4;
/// Client-only sound cues (the sim emits kinds 1-4 and 6-19): push stamina ran out, game over.
pub const SOUND_PUSH_CLICK: u32 = 5;
pub const SOUND_FANFARE: u32 = 20;
/// Damage bar colours (0xRRGGBB): yellow while the dynamic threshold is the next one, red towards removal.
pub const DAMAGE_DYNAMIC_RGB: u32 = 0xd4cd47;
pub const DAMAGE_REMOVAL_RGB: u32 = 0xc43543;

/// Team colours (0xRRGGBB) of the parts that carry no player colour: projectiles, flags.
pub const RED: u32 = 0xd44234;
pub const BLUE: u32 = 0x347bd4;

/// The colours player-owned parts are drawn in, as the client draws players (`playerColourWords` in
/// client/src/render/geometry.ts): team colours, the FFA palette by player id, and the room's own colour
/// per FFA player id.
#[derive(Clone, Debug, PartialEq)]
pub struct PlayerColours {
    red: u32,
    blue: u32,
    ffa: Vec<u32>,
    room: Vec<(u32, u32)>,
}

impl Default for PlayerColours {
    /// The client's default palette; the client sends its own before the first frame (`nb_set_colours`).
    fn default() -> Self {
        Self {
            red: 0xd44234,
            blue: 0x347bd4,
            ffa: vec![0xf9fc91, 0x33658a, 0xe34a6f, 0x3acf60, 0xbc56d5, 0xeea210],
            room: Vec::new(),
        }
    }
}

impl PlayerColours {
    /// Decode the words of `nb_set_colours`: red, blue, FFA count, FFA colours, room count, then (id, colour) pairs.
    pub fn from_words(w: &[u32]) -> Option<Self> {
        let [red, blue, n, rest @ ..] = w else { return None };
        let n = *n as usize;
        if n == 0 || rest.len() < n {
            return None;
        }
        let (ffa, rest) = rest.split_at(n);
        let [m, pairs @ ..] = rest else { return None };
        if pairs.len() != 2 * *m as usize {
            return None;
        }
        Some(Self { red: *red, blue: *blue, ffa: ffa.to_vec(), room: pairs.chunks_exact(2).map(|p| (p[0], p[1])).collect() })
    }

    /// Colour of a player of `team` with id `id`: the same mapping as `playerRgb` in the client.
    pub fn of(&self, id: f64, team: f64) -> u32 {
        if team == 2.0 {
            return self.red;
        }
        if team == 3.0 {
            return self.blue;
        }
        if team == 1.0 {
            if let Some(&(_, rgb)) = self.room.iter().find(|(rid, _)| f64::from(*rid) == id) {
                return rgb;
            }
        }
        self.ffa[(id.max(0.0) as usize) % self.ffa.len()]
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
    /// triangulated local geometry per shape list, keyed by the address of the
    /// body definition; the entry holds that definition, so the address cannot
    /// be reused by another definition while it is cached
    cache: HashMap<usize, (std::sync::Arc<BodyDef>, Vec<Mesh>)>,
    tmp: Vec<[f32; 2]>,
    /// Damage bars of the built frame: x, y, fraction, colour (BAR_WORDS each).
    bars: Vec<u32>,
    /// Player colours the frames are drawn with (set by `nb_set_colours`).
    colours: PlayerColours,
}

impl FrameBuilder {
    /// Set the player colours of the next frames. Cached meshes keep the colours they were built with, so they go too.
    pub fn set_colours(&mut self, colours: PlayerColours) {
        if colours != self.colours {
            self.colours = colours;
            self.cache.clear();
        }
    }
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

/// Triangulates a ring exactly as PIXI fills it (legacy-654 `Us.triangulate`): reverse to earcut's winding, then
/// earcut. Triangles are appended three points each; self-intersecting rings fill the way earcut fills them.
fn triangulate(pts: &[[f32; 2]], out: &mut Vec<[f32; 2]>) {
    let ring: Vec<[f64; 2]> = pts.iter().map(|p| [f64::from(p[0]), f64::from(p[1])]).collect();
    let mut tris = Vec::new();
    fill_ring(&ring, &mut tris);
    out.extend(tris.iter().map(|p| [p[0] as f32, p[1] as f32]));
}

/// Earcut 2.2 as bundled in PIXI legacy-654, for one ring without holes. Its hashed ear test only skips candidates,
/// so the brute-force test here picks the same ears.
const NIL: usize = usize::MAX;

#[derive(Clone, Copy)]
struct Node {
    i: usize,
    x: f64,
    y: f64,
    prev: usize,
    next: usize,
}

struct Earcut {
    v: Vec<Node>,
    tris: Vec<[[f64; 2]; 3]>,
}

impl Earcut {
    fn prev(&self, p: usize) -> usize {
        self.v[p].prev
    }

    fn next(&self, p: usize) -> usize {
        self.v[p].next
    }

    /// earcut's St(p, q, r): twice the signed area of p, q, r.
    fn st(&self, p: usize, q: usize, r: usize) -> f64 {
        let (p, q, r) = (self.v[p], self.v[q], self.v[r]);
        (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
    }

    fn equals(&self, p: usize, q: usize) -> bool {
        self.v[p].x == self.v[q].x && self.v[p].y == self.v[q].y
    }

    fn copy(&mut self, p: usize) -> usize {
        let n = self.v[p];
        self.v.push(Node { prev: NIL, next: NIL, ..n });
        self.v.len() - 1
    }

    /// earcut's wt: unlinks p (its own links are kept).
    fn remove(&mut self, p: usize) {
        let (a, b) = (self.v[p].prev, self.v[p].next);
        self.v[b].prev = a;
        self.v[a].next = b;
    }

    /// earcut's Ct: appends a node for point `i` after `last` (or starts the ring when `last` is NIL).
    fn insert(&mut self, i: usize, pt: [f64; 2], last: usize) -> usize {
        let n = self.v.len();
        self.v.push(Node { i, x: pt[0], y: pt[1], prev: NIL, next: NIL });
        if last == NIL {
            self.v[n].prev = n;
            self.v[n].next = n;
        } else {
            let nx = self.v[last].next;
            self.v[n].next = nx;
            self.v[n].prev = last;
            self.v[nx].prev = n;
            self.v[last].next = n;
        }
        n
    }

    /// earcut's dt (clockwise = true, no holes). Returns the last node built.
    fn linked_list(&mut self, pts: &[[f64; 2]]) -> usize {
        let n = pts.len();
        let mut sum = 0.0;
        let mut s = n - 1;
        for o in 0..n {
            sum += (pts[s][0] - pts[o][0]) * (pts[o][1] + pts[s][1]);
            s = o;
        }
        let mut last = NIL;
        if sum > 0.0 {
            for o in 0..n {
                last = self.insert(o, pts[o], last);
            }
        } else {
            for o in (0..n).rev() {
                last = self.insert(o, pts[o], last);
            }
        }
        if last != NIL && self.equals(last, self.next(last)) {
            self.remove(last);
            last = self.next(last);
        }
        last
    }

    /// earcut's ft: drops duplicate and zero-area vertices, starting at `start`.
    fn filter(&mut self, start: usize, end: usize) -> usize {
        if start == NIL {
            return NIL;
        }
        let mut end = if end == NIL { start } else { end };
        let mut p = start;
        loop {
            let mut again = false;
            let n = self.next(p);
            if self.equals(p, n) || self.st(self.prev(p), p, n) == 0.0 {
                self.remove(p);
                p = self.prev(p);
                end = p;
                if p == self.next(p) {
                    break;
                }
                again = true;
            } else {
                p = n;
            }
            if !again && p == end {
                break;
            }
        }
        end
    }

    /// earcut's pt: clips ears from the ring. Pass 0 is the plain clip; a stall moves to pass 1 (cure crossings) and
    /// then pass 2 (split along a valid diagonal).
    fn clip(&mut self, start: usize, pass: u8) {
        if start == NIL {
            return;
        }
        let mut ear = start;
        let mut stop = start;
        while self.prev(ear) != self.next(ear) {
            let (a, h) = (self.prev(ear), self.next(ear));
            if self.is_ear(ear) {
                self.tris.push([self.coords(a), self.coords(ear), self.coords(h)]);
                self.remove(ear);
                ear = self.next(h);
                stop = ear;
            } else {
                ear = h;
                if ear == stop {
                    match pass {
                        0 => {
                            let f = self.filter(ear, NIL);
                            self.clip(f, 1);
                        }
                        1 => {
                            let f = self.filter(ear, NIL);
                            let c = self.cure(f);
                            self.clip(c, 2);
                        }
                        _ => self.split(ear),
                    }
                    break;
                }
            }
        }
    }

    fn coords(&self, p: usize) -> [f64; 2] {
        [self.v[p].x, self.v[p].y]
    }

    /// earcut's _t: a convex corner with no other ring vertex inside its triangle.
    fn is_ear(&self, ear: usize) -> bool {
        let (a, b, c) = (self.prev(ear), ear, self.next(ear));
        if self.st(a, b, c) >= 0.0 {
            return false;
        }
        let (pa, pb, pc) = (self.v[a], self.v[b], self.v[c]);
        let (l, r) = (pa.x.min(pb.x).min(pc.x), pa.x.max(pb.x).max(pc.x));
        let (d, f) = (pa.y.min(pb.y).min(pc.y), pa.y.max(pb.y).max(pc.y));
        let mut p = self.next(c);
        while p != a {
            let q = self.v[p];
            if q.x >= l
                && q.x <= r
                && q.y >= d
                && q.y <= f
                && in_triangle(pa, pb, pc, q)
                && self.st(self.prev(p), p, self.next(p)) >= 0.0
            {
                return false;
            }
            p = self.next(p);
        }
        true
    }

    /// earcut's mt: removes a self-crossing a-p, p-n, n-b when the diagonal lies inside the ring.
    fn cure(&mut self, start: usize) -> usize {
        let mut anchor = start;
        let mut i = start;
        loop {
            let (n, o) = (self.prev(i), self.next(self.next(i)));
            if !self.equals(n, o) && self.intersects(n, i, self.next(i), o) && self.inside(n, o) && self.inside(o, n) {
                let nx = self.next(i);
                self.tris.push([self.coords(n), self.coords(i), self.coords(o)]);
                self.remove(i);
                self.remove(nx);
                i = o;
                anchor = o;
            }
            i = self.next(i);
            if i == anchor {
                break;
            }
        }
        self.filter(i, NIL)
    }

    /// earcut's Et: splits the ring at the first valid diagonal and clips both halves.
    fn split(&mut self, start: usize) {
        let mut s = start;
        loop {
            let mut a = self.next(self.next(s));
            while a != self.prev(s) {
                if self.v[s].i != self.v[a].i && self.valid_diagonal(s, a) {
                    let h = self.split_at(s, a);
                    let s2 = self.filter(s, self.next(s));
                    let h2 = self.filter(h, self.next(h));
                    self.clip(s2, 0);
                    self.clip(h2, 0);
                    return;
                }
                a = self.next(a);
            }
            s = self.next(s);
            if s == start {
                break;
            }
        }
    }

    /// earcut's At.
    fn valid_diagonal(&self, a: usize, b: usize) -> bool {
        if self.v[self.next(a)].i == self.v[b].i || self.v[self.prev(a)].i == self.v[b].i {
            return false;
        }
        if self.crosses_ring(a, b) {
            return false;
        }
        (self.inside(a, b)
            && self.inside(b, a)
            && self.middle_inside(a, b)
            && (self.st(self.prev(a), a, self.prev(b)) != 0.0 || self.st(a, self.prev(b), b) != 0.0))
            || (self.equals(a, b) && self.st(self.prev(a), a, self.next(a)) > 0.0 && self.st(self.prev(b), b, self.next(b)) > 0.0)
    }

    fn crosses_ring(&self, a: usize, b: usize) -> bool {
        let mut r = a;
        loop {
            let rn = self.next(r);
            let (ri, ni) = (self.v[r].i, self.v[rn].i);
            if ri != self.v[a].i
                && ni != self.v[a].i
                && ri != self.v[b].i
                && ni != self.v[b].i
                && self.intersects(r, rn, a, b)
            {
                return true;
            }
            r = rn;
            if r == a {
                return false;
            }
        }
    }

    /// earcut's Dt: whether the diagonal from a toward b starts inside the ring.
    fn inside(&self, a: usize, b: usize) -> bool {
        let (pa, na) = (self.prev(a), self.next(a));
        if self.st(pa, a, na) < 0.0 {
            self.st(a, b, na) >= 0.0 && self.st(a, pa, b) >= 0.0
        } else {
            self.st(a, b, pa) < 0.0 || self.st(a, na, b) < 0.0
        }
    }

    fn middle_inside(&self, a: usize, b: usize) -> bool {
        let (mx, my) = ((self.v[a].x + self.v[b].x) / 2.0, (self.v[a].y + self.v[b].y) / 2.0);
        let mut inside = false;
        let mut r = a;
        loop {
            let rn = self.next(r);
            let (r0, r1) = (self.v[r], self.v[rn]);
            if (r0.y > my) != (r1.y > my) && r1.y != r0.y && mx < (r1.x - r0.x) * (my - r0.y) / (r1.y - r0.y) + r0.x {
                inside = !inside;
            }
            r = rn;
            if r == a {
                return inside;
            }
        }
    }

    /// earcut's It: whether segment p1-q1 meets segment p2-q2 (touching counts).
    fn intersects(&self, p1: usize, q1: usize, p2: usize, q2: usize) -> bool {
        let n = sign(self.st(p1, q1, p2));
        let o = sign(self.st(p1, q1, q2));
        let s = sign(self.st(p2, q2, p1));
        let a = sign(self.st(p2, q2, q1));
        if n != o && s != a {
            return true;
        }
        (n == 0 && self.on_segment(p1, p2, q1))
            || (o == 0 && self.on_segment(p1, q2, q1))
            || (s == 0 && self.on_segment(p2, p1, q2))
            || (a == 0 && self.on_segment(p2, q1, q2))
    }

    /// earcut's Mt: whether q lies in the bounding box of p-r (collinear by the caller's check).
    fn on_segment(&self, p: usize, q: usize, r: usize) -> bool {
        let (p, q, r) = (self.v[p], self.v[q], self.v[r]);
        q.x <= p.x.max(r.x) && q.x >= p.x.min(r.x) && q.y <= p.y.max(r.y) && q.y >= p.y.min(r.y)
    }

    /// earcut's Nt: splits at a-b. Returns the copy of b that starts the second ring.
    fn split_at(&mut self, a: usize, b: usize) -> usize {
        let r = self.copy(a);
        let i = self.copy(b);
        let (n, o) = (self.next(a), self.prev(b));
        self.v[a].next = b;
        self.v[b].prev = a;
        self.v[r].next = n;
        self.v[n].prev = r;
        self.v[i].next = r;
        self.v[r].prev = i;
        self.v[o].next = i;
        self.v[i].prev = o;
        i
    }
}

fn sign(x: f64) -> i32 {
    if x > 0.0 {
        1
    } else if x < 0.0 {
        -1
    } else {
        0
    }
}

/// earcut's xt: point p inside (boundary included) triangle a, b, c.
fn in_triangle(a: Node, b: Node, c: Node, p: Node) -> bool {
    (c.x - p.x) * (a.y - p.y) >= (a.x - p.x) * (c.y - p.y)
        && (a.x - p.x) * (b.y - p.y) >= (b.x - p.x) * (a.y - p.y)
        && (b.x - p.x) * (c.y - p.y) >= (c.x - p.x) * (b.y - p.y)
}

/// Fills one ring the way PIXI does: reverse when the shoelace sum is positive (`Fs`), then earcut. Triangles go to
/// `out`, three points each.
fn fill_ring(pts: &[[f64; 2]], out: &mut Vec<[f64; 2]>) {
    let n = pts.len();
    if n < 3 {
        return;
    }
    let mut pts = pts.to_vec();
    let mut o = 0.0;
    let mut prev = pts[n - 1];
    for p in &pts {
        o += (p[0] - prev[0]) * (p[1] + prev[1]);
        prev = *p;
    }
    if o > 0.0 {
        pts.reverse();
    }
    let mut e = Earcut { v: Vec::with_capacity(n), tris: Vec::new() };
    let last = e.linked_list(&pts);
    if last == NIL || e.next(last) == e.prev(last) {
        return;
    }
    e.clip(last, 0);
    for t in &e.tris {
        out.extend_from_slice(t);
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

/// An aim angle at `t`: the atan2 of the lerped sine and cosine (the original's launcher
/// update), so a turn across ±π takes the short way.
fn lerp_aim(a: f64, b: f64, t: f64) -> f64 {
    let ((s0, c0), (s1, c1)) = (a.sin_cos(), b.sin_cos());
    lerp(s0, s1, t).atan2(lerp(c0, c1, t))
}

impl FrameBuilder {
    fn meshes(&mut self, def: &std::sync::Arc<BodyDef>) -> &Vec<Mesh> {
        let key = std::sync::Arc::as_ptr(def) as usize;
        if self.cache.len() > 4096 {
            self.cache.clear();
        }
        let (_, meshes) = self.cache.entry(key).or_insert_with(|| {
            let mut v: Vec<Mesh> = def
                .shapes
                .iter()
                .map(|s| {
                    let c = if def.source_player > -1.0 { self.colours.of(def.source_player, s.color) } else { s.color as u32 & 0xffffff };
                    shape_mesh(s, c)
                })
                .collect();
            v.sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
            (def.clone(), v)
        });
        meshes
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
        let (x, y, a) = body_pose(prev, cur, t);
        let key = std::sync::Arc::as_ptr(&cur.def) as usize;
        self.meshes(&cur.def);
        let (_, meshes) = &self.cache[&key];
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
                let c = rgba(self.colours.of(e.player, e.team), 0.55 * fade);
                self.quad_line(e.x, e.y, e.x2, e.y2, 0.12, c);
            }
            43 => {
                let r = 0.6 + (4.0 - e.ttl).max(0.0) * 0.5;
                self.ring(e.x, e.y, r, 0.08, rgba(self.colours.of(e.player, e.team), 0.5 * fade));
            }
            18 => self.ring(e.x, e.y, 0.25 + (15.0 - e.ttl).max(0.0) * 0.03, 0.06, rgba(0xffffff, 0.6 * fade)),
            0 => {
                let r = e.volume.max(0.2);
                self.disc(e.x, e.y, r * (1.0 - e.ttl / 10.0).max(0.3), rgba(0xffb347, 0.45 * fade));
            }
            _ => {}
        }
    }

    /// The bat head (the original's `gu`): a brown wedge and head swung at the aim. It starts
    /// behind the player during the windup, and a dashed trail shows while it winds up.
    fn bat_head(&mut self, prev: Option<&Player>, p: &Player, t: f64, gs: &GameSettings, px: f64, py: f64) {
        if p.bat_frame < 0.0 || !gs.bat_enabled || p.ghost {
            return;
        }
        let (prev_frame, prev_aim) = prev.map_or((p.bat_frame, p.bat_aim), |pp| (pp.bat_frame, pp.bat_aim));
        // the original interpolates the frame counter and runs one frame ahead of it
        let frame = lerp(prev_frame, p.bat_frame, t) + 1.0;
        let (fire, hold, hide) = (gs.bat_fire_on, gs.bat_hold_until, gs.bat_hide_after);
        if !(frame > -1.0 && frame < fire + hide) {
            return;
        }
        let rotation = lerp_aim(prev_aim, p.bat_aim, t) + if frame < fire { std::f64::consts::PI } else { 0.0 };
        // the head grows from 0.4 to 1 over the hold window (the original's `cs` easing)
        let o = 1.0 - 0.6 * (frame.min(hold) / hold * std::f64::consts::FRAC_PI_2).cos();
        let flip = if (std::f64::consts::FRAC_PI_2..=1.5 * std::f64::consts::PI).contains(&rotation) { -1.0 } else { 1.0 };
        let d = (gs.bat_range - 0.125) * o;
        let r = 0.25 * o;
        let g = 0.12 * o;
        let at = |x: f64, y: f64| {
            let (rx, ry) = rotate(x, y, rotation);
            (px + rx, py + ry)
        };
        let (a, b, c, e) = ([0.0, -g / 2.0], [d, -r / 2.0], [d, r / 2.0], [0.0, g / 2.0]);
        let head = [a, b, c, a, c, e].map(|v| [v[0] as f32, v[1] as f32]);
        self.push_tri_list(&head, px, py, rotation, rgba(0x683d14, 1.0));
        let (hx, hy) = at(d, 0.0);
        self.disc(hx, hy, r / 2.0, rgba(0x683d14, 1.0));
        if frame >= hold && frame < fire {
            for f in (0..10).step_by(2) {
                let f = f as f64;
                let (ax, ay) = at(-0.15 * f, 0.0);
                let (bx, by) = at(-0.15 * (f + 1.0), 0.0);
                self.quad_line(ax, ay, bx, by, 0.03, rgba(0xdddddd, 0.5));
            }
        }
        let (ex, ey) = at(d + r / 5.0, -r / 3.0 * flip);
        self.quad_line(px, py, ex, ey, 0.08 * o, rgba(0xffffff, 0.07));
    }

    /// Build the frame for `cur`, interpolating from `prev` by `t` in [0, 1].
    pub fn build(&mut self, prev: &State, cur: &State, t: f64, gs: &GameSettings, meta: Meta, feed: &Feed) {
        self.verts.clear();
        // Extent of the static bodies' drawn triangles (min x, min y, max x, max y): the map's fixed geometry, which the
        // camera frames. Moving bodies, projectiles, effects and aim lines are left out, so they never move a fixed view.
        let mut fixed = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
        self.bars.clear();
        // bodies, back to front by z-index (stable)
        let mut order: Vec<(f64, u32)> = cur.bodies.iter().map(|(k, b)| (b.def.z_index, k)).collect();
        order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, id) in order {
            let b = cur.bodies.get(id).expect("body");
            let pb = prev.bodies.get(id);
            let from = self.verts.len();
            self.body(pb, b, t);
            if b.def.motion == BODY_STATIC {
                for v in self.verts[from..].chunks_exact(3) {
                    let (x, y) = (f32::from_bits(v[0]), f32::from_bits(v[1]));
                    fixed = [fixed[0].min(x), fixed[1].min(y), fixed[2].max(x), fixed[3].max(y)];
                }
            }
            let bar = if b.def.invisible { None } else { damage_bar(b.damage, b.def.dynamic_threshold, b.def.removal_threshold) };
            if let Some((frac, colour)) = bar {
                let (x, y, _) = body_pose(pb, b, t);
                self.bars.extend([(x as f32).to_bits(), (y as f32).to_bits(), (frac as f32).to_bits(), colour]);
            }
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
                let col = rgba(self.colours.of(p.id, p.team), 0.85);
                self.push_tri_list(&tris, c.x, c.y, c.angle, col);
                self.quad_line(px, py, c.x - w * c.angle.cos(), c.y - w * c.angle.sin(), 0.04, rgba(0xdddddd, 0.7));
                self.quad_line(px, py, c.x + w * c.angle.cos(), c.y + w * c.angle.sin(), 0.04, rgba(0xdddddd, 0.7));
            }
            // grab lines (the original's `Lm`): from each held grab point on the player to the
            // grabbed body's anchor
            let pa = interp_angle(pp, p, t);
            let (hu, eu) = (gs.player_width / 2.0, gs.player_height / 2.0);
            for (dir, a) in p.grabs.iter().enumerate() {
                if a.state != ATTACH_ON || a.kind != kind::BODY as f64 || a.target < 0.0 {
                    continue;
                }
                let Some(body) = cur.bodies.get(a.target as u32) else { continue };
                let (bx, by, ba) = body_pose(prev.bodies.get(a.target as u32), body, t);
                let (sx, sy) = GRAB_DIR[dir];
                let (ox, oy) = rotate(sx * hu, sy * eu, pa);
                let (tx, ty) = rotate(a.ax, a.ay, ba);
                let (ex, ey) = (bx + tx, by + ty);
                self.quad_line(px + ox, py + oy, ex, ey, 0.04, rgba(0xbbbbbb, 0.7));
                self.ring(ex, ey, 0.02, 0.04, rgba(0xbbbbbb, 0.7));
            }
            self.bat_head(pp, p, t, gs, px, py);
            if p.bat_frame >= 0.0 && p.bat_frame < gs.bat_fire_on + gs.bat_fire_frames {
                let a = pp.map_or(p.bat_aim, |pp| lerp_aim(pp.bat_aim, p.bat_aim, t));
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
        for (id, q) in cur.projectiles.iter() {
            self.projectile(prev.projectiles.get(id), q, t);
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
            let angle = interp_angle(prev.players.get(id), p, t);
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
            if p.air_jump {
                flags |= 256;
            }
            let (rocket, rocket_rot) = interp_rocket(prev.players.get(id), p, t);
            let rocket = if p.rocket_frame == -1.0 { -1.0 } else { rocket };
            let egg = egg_charge(p.egg_frame, gs.egg_delay1, gs.egg_delay2);
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
                f(rocket),
                f(rocket_rot),
                f(egg),
                f(interp_egg_aim(prev.players.get(id), p, t)),
            ]);
        }
        w[5] = feed.sounds.len() as u32;
        w[6] = w.len() as u32;
        for s in &feed.sounds {
            w.extend([s.kind, s.x.to_bits(), s.y.to_bits(), s.volume.to_bits(), s.player as u32]);
        }
        w[7] = cur.round.players.len() as u32;
        w[8] = w.len() as u32;
        // scores and lives can go negative in the original rules (kept for
        // identical gameplay); they are shown clamped at 0 (DEVIATIONS.md S5)
        let shown = |v: f64| f(v.max(0.0));
        for (id, r) in cur.round.players.iter() {
            let killed_by = if r.killed_by >= 0.0 { r.killed_by as u32 } else { u32::MAX };
            let spawn = if r.spawn >= 0.0 { cur.spawns.get(r.spawn as u32) } else { None };
            let (spawn_x, spawn_y) = spawn.map_or((f64::NAN, f64::NAN), |s| (s.x, s.y));
            let last_victim = if r.last_victim >= 0.0 { r.last_victim as u32 } else { u32::MAX };
            w.extend([
                id,
                r.team.max(0.0) as u32,
                shown(r.kills),
                shown(r.wins),
                shown(r.lives),
                r.alive as u32,
                f(r.respawn),
                f(r.eliminated),
                killed_by,
                last_victim,
                f(r.kill_timer),
                f(r.death_timer),
                f(r.suicide_timer),
                f(spawn_x),
                f(spawn_y),
            ]);
        }
        w[30] = (feed.kills.len() / 3) as u32;
        w[31] = w.len() as u32;
        w.extend_from_slice(&feed.kills);
        w[32] = (self.bars.len() / BAR_WORDS) as u32;
        w[33] = w.len() as u32;
        w.extend_from_slice(&self.bars);
        w[34] = (feed.hits.len() / 3) as u32;
        w[35] = w.len() as u32;
        w.extend_from_slice(&feed.hits);
        w[36] = (feed.log_hits.len() / 4) as u32;
        w[37] = w.len() as u32;
        w.extend_from_slice(&feed.log_hits);
        let st = &cur.settings;
        w[9] = f(st.screen_width);
        w[10] = f(st.width);
        w[11] = f(st.height);
        w[12] = st.color_top as u32 & 0xffffff;
        w[13] = st.color_bottom as u32 & 0xffffff;
        w[42] = f(st.view_aspect());
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
        // static geometry extent (all infinite when the map has no visible static body)
        for (i, v) in fixed.iter().enumerate() {
            w[38 + i] = v.to_bits();
        }
    }
}

fn body_pose(prev: Option<&Body>, cur: &Body, t: f64) -> (f64, f64, f64) {
    match prev {
        Some(p) if !cur.teleported && std::sync::Arc::ptr_eq(&p.def, &cur.def) => {
            (lerp(p.x, cur.x, t), lerp(p.y, cur.y, t), lerp_angle(p.angle, cur.angle, t))
        }
        _ => (cur.x, cur.y, cur.angle),
    }
}

/// The original's damage bar (`Md`): the fraction shown (0..1) and its colour, or None while
/// hidden. The nearer threshold ahead sets the colour: yellow for dynamic, red for removal.
/// A body with neither threshold has no bar.
fn damage_bar(damage: f64, dynamic: f64, removal: f64) -> Option<(f64, u32)> {
    if !(dynamic > 0.0 || removal > 0.0) {
        return None;
    }
    let to_dynamic = dynamic - damage;
    let to_removal = removal - damage;
    let (frac, colour) = if to_dynamic > 0.0 && (to_dynamic < to_removal || to_removal <= 0.0) {
        (1.0 - damage / dynamic, DAMAGE_DYNAMIC_RGB)
    } else if to_removal > 0.0 {
        let frac = if dynamic > 0.0 && dynamic < removal {
            1.0 - (damage - dynamic) / (removal - dynamic)
        } else {
            1.0 - damage / removal
        };
        (frac, DAMAGE_REMOVAL_RGB)
    } else {
        return None;
    };
    let frac = frac.max(0.0);
    (frac != 0.0).then_some((frac, colour))
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

/// Angle of `p` at `t`, matching `interp_player`; a teleported player snaps.
fn interp_angle(prev: Option<&Player>, p: &Player, t: f64) -> f64 {
    match prev {
        Some(pp) if !p.teleported => lerp_angle(pp.angle, p.angle, t),
        _ => p.angle,
    }
}

/// Rocket charge and aim of `p` at `t` (the original's launcher update): the charge is lerped and
/// floored at 0, the aim follows `lerp_aim`. The caller maps idle (-1) to hidden.
fn interp_rocket(prev: Option<&Player>, p: &Player, t: f64) -> (f64, f64) {
    let (pf, pa) = prev.map_or((p.rocket_frame, p.rocket_aim), |pp| (pp.rocket_frame, pp.rocket_aim));
    (lerp(pf, p.rocket_frame, t).max(0.0), lerp_aim(pa, p.rocket_aim, t))
}

/// Egg aim of `p` at `t`, like the rocket's.
fn interp_egg_aim(prev: Option<&Player>, p: &Player, t: f64) -> f64 {
    prev.map_or(p.egg_aim, |pp| lerp_aim(pp.egg_aim, p.egg_aim, t))
}

/// Length fraction of the egg aim line (0 until the charge passes `delay1`, full after `delay1 + delay2`).
fn egg_charge(frame: f64, delay1: f64, delay2: f64) -> f64 {
    let c = ((frame - delay1) / delay2).min(1.0);
    if c > 0.0 { c } else { 0.0 }
}

/// Grab directions as signs of the player box corners and edge midpoints; mirrors the sim's
/// `grab_anchor` for `outer == false`.
const GRAB_DIR: [(f64, f64); 8] = [(1.0, -1.0), (1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)];

fn rotate(x: f64, y: f64, angle: f64) -> (f64, f64) {
    let (s, c) = angle.sin_cos();
    (x * c - y * s, x * s + y * c)
}

/// Events of the ticks a frame covers. Two streams: predicted ticks (sounds and bat hits, which
/// drive the presentation at once; a rollback may undo them) and confirmed ticks (kills and bat
/// hits, the event log that every client agrees on).
#[derive(Default)]
pub struct Feed {
    /// sounds of predicted ticks
    pub sounds: Vec<SoundOut>,
    /// (swinger, victim kind, victim index) triples of bat hits of predicted ticks: the hit visuals
    pub hits: Vec<u32>,
    /// (killer, victim, tick) triples of confirmed ticks
    pub kills: Vec<u32>,
    /// (swinger, victim kind, victim index, tick) quadruples of bat hits of confirmed ticks: the event log
    pub log_hits: Vec<u32>,
    /// predicted sounds already fed, per tick: a rollback feeds the recomputed ticks again
    fed_sounds: FedKeys<(u32, i32, i32, i32)>,
    /// predicted bat hits already fed, per tick
    fed_hits: FedKeys<(u32, u32, u32)>,
}

impl Feed {
    pub fn clear(&mut self) {
        self.sounds.clear();
        self.hits.clear();
        self.kills.clear();
        self.log_hits.clear();
    }
    /// Forget the dedupe keys of the ticks before `tick` (rollbacks never reach below it).
    pub fn forget_before(&mut self, tick: u32) {
        self.fed_sounds.forget_before(tick);
        self.fed_hits.forget_before(tick);
    }
    /// Add the sounds and bat hits of predicted tick `tick`, `prev` to `cur`; a record fed before
    /// (the tick was recomputed by a rollback) is not fed again.
    pub fn add_predicted(&mut self, tick: u32, prev: &State, cur: &State) {
        let mut sounds = Vec::new();
        new_sounds(prev, cur, &mut sounds);
        for s in sounds {
            // a player's sound is one per kind per tick; a world sound is placed to the nearest 16 units. A rollback
            // recomputes positions, so the exact bits of x and y do not identify a sound
            let cell = |v: f32| (v / 16.0).round() as i32;
            let key = if s.player >= 0 { (s.kind, s.player, 0, 0) } else { (s.kind, s.player, cell(s.x), cell(s.y)) };
            if self.fed_sounds.first(tick, key) {
                self.sounds.push(s);
            }
        }
        let mut hits = Vec::new();
        new_hits(prev, cur, None, &mut hits);
        for h in hits.chunks_exact(3) {
            if self.fed_hits.first(tick, (h[0], h[1], h[2])) {
                self.hits.extend_from_slice(h);
            }
        }
    }
    /// Add the kills and bat hits of one confirmed tick `tick` (`cur`'s tick), `prev` to `cur`.
    pub fn add_confirmed(&mut self, tick: u32, prev: &State, cur: &State) {
        new_kills(tick, prev, cur, &mut self.kills);
        new_hits(prev, cur, Some(tick), &mut self.log_hits);
    }
    /// Add the events of one tick that is final (replays, offline games): both streams, each once.
    pub fn add(&mut self, tick: u32, prev: &State, cur: &State) {
        new_sounds(prev, cur, &mut self.sounds);
        new_hits(prev, cur, None, &mut self.hits);
        self.add_confirmed(tick, prev, cur);
    }
}

/// New sounds of `cur` relative to `prev` (sounds append after survivors), then the client-only
/// cues the sim does not emit: a push click when a push runs out of stamina, and the fanfare
/// when the game ends.
pub fn new_sounds(prev: &State, cur: &State, out: &mut Vec<SoundOut>) {
    let survivors = prev.sounds.iter().filter(|s| s.ttl - 1.0 > 0.0).count();
    for s in cur.sounds.iter().skip(survivors) {
        out.push(SoundOut { kind: s.kind as u32, x: s.x as f32, y: s.y as f32, volume: s.volume as f32, player: s.player as i32 });
    }
    for (id, p) in cur.players.iter() {
        let Some(pp) = prev.players.get(id) else { continue };
        if pp.stamina > 0.0 && p.stamina <= 0.0 && p.push_frames > 0.0 {
            out.push(SoundOut { kind: SOUND_PUSH_CLICK, x: p.x as f32, y: p.y as f32, volume: 0.6, player: id as i32 });
        }
    }
    if prev.round.game_over < 0.0 && cur.round.game_over >= 0.0 {
        out.push(SoundOut { kind: SOUND_FANFARE, x: 0.0, y: 0.0, volume: 1.0, player: -1 });
    }
}

/// (killer, victim, tick) triples of the kills `cur` has over `prev`; `tick` is `cur`'s tick.
pub fn new_kills(tick: u32, prev: &State, cur: &State, out: &mut Vec<u32>) {
    for (id, r) in cur.round.players.iter() {
        let before = prev.round.players.get(id).map_or(0.0, |pr| pr.kills);
        if r.kills > before && r.last_victim >= 0.0 {
            out.extend([id as u32, r.last_victim as u32, tick]);
        }
    }
}

/// (swinger, victim kind, victim index) triples of the bat hits that landed on `cur` after `prev`,
/// each followed by `tick` when given (confirmed hits). `bat_hits` grows during a swing and is
/// cleared when the swing resets.
pub fn new_hits(prev: &State, cur: &State, tick: Option<u32>, out: &mut Vec<u32>) {
    for (id, p) in cur.players.iter() {
        let before = prev.players.get(id).map_or(0, |pp| pp.bat_hits.len());
        let from = if p.bat_hits.len() >= before { before } else { 0 };
        for pair in p.bat_hits[from..].chunks_exact(2) {
            out.extend([id as u32, pair[0] as u32, pair[1] as u32]);
            out.extend(tick);
        }
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

    fn area2(p: &[[f32; 2]]) -> f32 {
        let mut a = 0.0;
        for i in 0..p.len() {
            let j = (i + 1) % p.len();
            a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
        }
        a
    }

    /// Ray-casting point-in-polygon test.
    fn inside_ring(ring: &[[f32; 2]], p: [f32; 2]) -> bool {
        let mut inside = false;
        for i in 0..ring.len() {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
        }
        inside
    }

    /// The non-degenerate triangles cover the ring's area, and each one lies inside the ring.
    fn assert_fills(ring: &[[f32; 2]]) {
        let mut out = Vec::new();
        triangulate(ring, &mut out);
        let total: f32 = out.chunks(3).map(|t| area2(t).abs() / 2.0).sum();
        let area = area2(ring).abs() / 2.0;
        assert!((total - area).abs() < 1e-3 * area, "triangles cover {total}, polygon has {area}");
        for t in out.chunks(3).filter(|t| area2(t) != 0.0) {
            let c = [(t[0][0] + t[1][0] + t[2][0]) / 3.0, (t[0][1] + t[1][1] + t[2][1]) / 3.0];
            assert!(inside_ring(ring, c), "triangle centroid {c:?} outside the polygon");
        }
    }

    #[test]
    fn concave_shapes_fill_their_area_without_spilling() {
        let u = [[0.0, 0.0], [3.0, 0.0], [3.0, 2.0], [2.0, 2.0], [2.0, 1.0], [1.0, 1.0], [1.0, 2.0], [0.0, 2.0]];
        let comb = [
            [0.0, 0.0],
            [5.0, 0.0],
            [5.0, 2.0],
            [4.0, 2.0],
            [4.0, 1.0],
            [3.0, 1.0],
            [3.0, 2.0],
            [2.0, 2.0],
            [2.0, 1.0],
            [1.0, 1.0],
            [1.0, 2.0],
            [0.0, 2.0],
        ];
        let mut clockwise = u;
        clockwise.reverse();
        for ring in [&u[..], &comb[..], &clockwise[..]] {
            assert_fills(ring);
        }
    }

    #[test]
    fn db20xx_timer_glyph_fills_its_area() {
        // one ring that touches itself (db20xx body 99, shape 10): earcut joins its pieces with bridges
        let glyph = [
            [10.4000, -9.3750], [10.4000, -8.0250], [11.9500, -8.0250], [11.9500, -9.3750], [11.7500, -9.3750], [11.7500, -9.2750],
            [11.8500, -9.1750], [11.8500, -8.7750], [11.8000, -8.7250], [11.8500, -8.6750], [11.8500, -8.2250], [11.7500, -8.1250],
            [11.3500, -8.1250], [11.2500, -8.2250], [11.7500, -8.2250], [11.7500, -8.6750], [11.3500, -8.6750], [11.3500, -8.2250],
            [11.2500, -8.2250], [11.2500, -8.6750], [11.3000, -8.7250], [11.2500, -8.7750], [11.7500, -8.7750], [11.7500, -9.1750],
            [11.3500, -9.1750], [11.3500, -8.7750], [11.2500, -8.7750], [11.2500, -9.1750], [11.3500, -9.2750], [11.7500, -9.2750],
            [11.7500, -9.3750], [11.0000, -9.3750], [11.0000, -9.2750], [11.1000, -9.1750], [11.1000, -8.7750], [11.0500, -8.7250],
            [11.1000, -8.6750], [11.1000, -8.2250], [11.0000, -8.1250], [10.6000, -8.1250], [10.5000, -8.2250], [11.0000, -8.2250],
            [11.0000, -8.6750], [10.6000, -8.6750], [10.6000, -8.2250], [10.5000, -8.2250], [10.5000, -8.6750], [10.5500, -8.7250],
            [10.5000, -8.7750], [11.0000, -8.7750], [11.0000, -9.1750], [10.6000, -9.1750], [10.6000, -8.7750], [10.5000, -8.7750],
            [10.5000, -9.1750], [10.6000, -9.2750], [11.0000, -9.2750], [11.0000, -9.3750],
        ];
        assert_fills(&glyph);
    }

    #[test]
    fn damage_bar_follows_the_original() {
        // 10 to become dynamic, 20 to be removed
        assert_eq!(damage_bar(5.0, 10.0, 20.0), Some((0.5, DAMAGE_DYNAMIC_RGB)));
        assert_eq!(damage_bar(15.0, 10.0, 20.0), Some((0.5, DAMAGE_REMOVAL_RGB)));
        assert_eq!(damage_bar(25.0, 10.0, 20.0), None);
        assert_eq!(damage_bar(5.0, 0.0, 0.0), None);
    }

    fn square_def() -> std::sync::Arc<BodyDef> {
        let points = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let shape = MapShape { kind: 0.0, color: 0x00ff00 as f64, points, ..MapShape::default() };
        let mut def = BodyDef::default();
        def.shapes = vec![shape];
        std::sync::Arc::new(def)
    }

    fn triangle_def() -> std::sync::Arc<BodyDef> {
        let points = vec![[0.0, 0.0], [2.0, 0.0], [0.0, 2.0]];
        let shape = MapShape { kind: 0.0, color: 0xff0000 as f64, points, ..MapShape::default() };
        let mut def = BodyDef::default();
        def.shapes = vec![shape];
        std::sync::Arc::new(def)
    }

    fn mesh_summary(ms: &[Mesh]) -> Vec<(Vec<[f32; 2]>, u32)> {
        ms.iter().map(|m| (m.tris.clone(), m.color)).collect()
    }

    #[test]
    fn freed_definition_does_not_leak_its_geometry_to_a_new_one() {
        // Each square is freed right after being cached; the allocator tends to
        // hand its address to the next definition, which must still get its own
        // triangles, never the square's.
        let mut warm = FrameBuilder::default();
        for _ in 0..64 {
            let old = square_def();
            warm.meshes(&old);
            drop(old);
            let new = triangle_def();
            let cold = mesh_summary(FrameBuilder::default().meshes(&new));
            assert_eq!(mesh_summary(warm.meshes(&new)), cold);
        }
    }

    #[test]
    fn player_owned_shapes_take_the_client_colour_of_their_player() {
        // a dead player's debris: the shape carries the team, the body the player id
        let debris = |id: f64, team: f64| {
            let mut def = BodyDef::default();
            def.source_player = id;
            def.shapes = vec![MapShape { kind: 0.0, color: team, points: vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]], ..MapShape::default() }];
            std::sync::Arc::new(def)
        };
        let colour = |f: &mut FrameBuilder, def: &std::sync::Arc<BodyDef>| f.meshes(def)[0].color;
        let mut f = FrameBuilder::default();
        // the room gave player 40 its own FFA colour; other FFA ids cycle the palette
        f.set_colours(PlayerColours::from_words(&[0xff5252, 0x4d9bff, 2, 0x111111, 0x222222, 1, 40, 0xabcdef]).expect("valid colours"));
        assert_eq!(colour(&mut f, &debris(40.0, 1.0)), 0xabcdef);
        assert_eq!(colour(&mut f, &debris(41.0, 1.0)), 0x222222);
        assert_eq!(colour(&mut f, &debris(40.0, 2.0)), 0xff5252);
        assert_eq!(colour(&mut f, &debris(40.0, 3.0)), 0x4d9bff);
        // a new palette replaces the colours of meshes already cached
        f.set_colours(PlayerColours::from_words(&[0x010101, 0x020202, 1, 0x030303, 0]).expect("valid colours"));
        assert_eq!(colour(&mut f, &debris(40.0, 1.0)), 0x030303);
        assert_eq!(colour(&mut f, &debris(40.0, 2.0)), 0x010101);
    }

    #[test]
    fn a_charging_launcher_is_drawn_once_by_the_client() {
        // the client draws the launcher and the egg aim line (geometry.ts): the frame adds no player-coloured line for them
        let mut s = State::default();
        s.players.insert(2, Player { id: 2.0, team: 1.0, rocket_frame: 4.0, rocket_aim: 0.5, egg_frame: 3.0, egg_aim: 0.5, ..Player::default() });
        let mut f = FrameBuilder::default();
        f.build(&s, &s, 0.5, &GameSettings::default(), Meta::default(), &Feed::default());
        let line = rgba(PlayerColours::default().of(2.0, 1.0), 0.75);
        assert!(f.verts.chunks(3).all(|v| v[2] != line));
    }

    #[test]
    fn projectiles_are_drawn_between_ticks() {
        let at = |x: f64| {
            let mut s = State::default();
            s.projectiles.insert(3, Projectile { x, y: 0.0, size: 1.0, shape: 0.0, ..Projectile::default() });
            s
        };
        let (prev, cur) = (at(0.0), at(10.0));
        let mut f = FrameBuilder::default();
        f.build(&prev, &cur, 0.5, &GameSettings::default(), Meta::default(), &Feed::default());
        let xs: Vec<f32> = f.verts.chunks(3).map(|v| f32::from_bits(v[0])).collect();
        assert!(!xs.is_empty());
        let mid = xs.iter().sum::<f32>() / xs.len() as f32;
        assert!((mid - 5.0).abs() < 0.01, "projectile centre {mid}, expected 5");
    }

    #[test]
    fn rollback_that_moves_a_sound_does_not_feed_it_again() {
        let sound = |x: f64, player: f64| {
            let mut s = State::default();
            s.sounds.push(neobox_sim::state::Sound { x, y: 0.0, kind: 3.0, ttl: 5.0, volume: 0.5, player, effect_row: false });
            s
        };
        let mut feed = Feed::default();
        // a player's sound: recomputed by a rollback at a moved position, it is not fed again
        feed.add_predicted(7, &State::default(), &sound(100.0, 2.0));
        assert_eq!(feed.sounds.len(), 1);
        feed.clear();
        feed.add_predicted(7, &State::default(), &sound(101.0, 2.0));
        assert!(feed.sounds.is_empty());
        // a world sound keeps its cell: a move inside the same 16-unit cell is not fed again
        feed.add_predicted(8, &State::default(), &sound(100.0, -1.0));
        assert_eq!(feed.sounds.len(), 1);
        feed.clear();
        feed.add_predicted(8, &State::default(), &sound(102.0, -1.0));
        assert!(feed.sounds.is_empty());
        // another tick is a new sound
        feed.add_predicted(9, &State::default(), &sound(101.0, 2.0));
        assert_eq!(feed.sounds.len(), 1);
    }
}
