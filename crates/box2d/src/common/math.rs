//! Port of `Box2D.Common.Math` (b2Vec2, b2Vec3, b2Mat22, b2Mat33, b2Transform,
//! b2Sweep, b2Math). Every function keeps the operation order of the archived
//! JavaScript so results are bit-identical.
//!
//! Naming: JS `Foo.prototype.Bar` becomes `Foo::bar` for in-place mutators
//! keeping the JS semantics (`self`), and JS static `b2Math.X` becomes the free
//! function [`math::x`](self) (e.g. `b2Math.MulMV` -> [`mul_mv`]).

use libm::{cos as lm_cos, sin as lm_sin};

/// `Math.round` (ties toward +inf, `-0` preserved for `-0.5 <= x < 0`).
#[inline]
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && (x < 0.0 || (x == 0.0 && x.is_sign_negative())) {
        -0.0
    } else {
        r
    }
}

/// `Math.min(a, b)` for two numbers (NaN-propagating, `-0 < +0`).
#[inline]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { a } else { b };
    }
    if a < b { a } else { b }
}

/// `Math.max(a, b)` for two numbers (NaN-propagating, `+0 > -0`).
#[inline]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { b } else { a };
    }
    if a > b { a } else { b }
}

/// `SafeTrig.safeSin` of the archived library: `Math.round(Math.sin(t)*1e7)/1e7`.
#[inline]
pub fn safe_sin(t: f64) -> f64 {
    let mut t = lm_sin(t);
    t *= 1e7;
    t = js_round(t);
    t / 1e7
}

/// `SafeTrig.safeCos` of the archived library: `Math.round(Math.cos(t)*1e7)/1e7`.
#[inline]
pub fn safe_cos(t: f64) -> f64 {
    let mut t = lm_cos(t);
    t *= 1e7;
    t = js_round(t);
    t / 1e7
}

/// `Number.MIN_VALUE` (smallest positive subnormal).
pub const MIN_VALUE: f64 = f64::from_bits(1);

/// `b2Math.IsValid`.
#[inline]
pub fn is_valid(x: f64) -> bool {
    x.is_finite()
}

/// `b2Math.Abs` for a scalar (`t > 0 ? t : -t`, so `abs(0) == -0`, `abs(NaN) == -NaN`).
#[inline]
pub fn abs_f(t: f64) -> f64 {
    if t > 0.0 { t } else { -t }
}

/// `b2Math.Min` for scalars: `t < o ? t : o`.
#[inline]
pub fn min_f(t: f64, o: f64) -> f64 {
    if t < o { t } else { o }
}

/// `b2Math.Max` for scalars: `t > o ? t : o`.
#[inline]
pub fn max_f(t: f64, o: f64) -> f64 {
    if t > o { t } else { o }
}

/// `b2Math.Clamp`: `t < o ? o : t > e ? e : t`.
#[inline]
pub fn clamp(t: f64, o: f64, e: f64) -> f64 {
    if t < o {
        o
    } else if t > e {
        e
    } else {
        t
    }
}

/// `b2Math.NextPowerOfTwo` (32-bit JS integer semantics).
pub fn next_power_of_two(t: i32) -> i32 {
    let mut t = t;
    t |= (t >> 1) & 2147483647;
    t |= (t >> 2) & 1073741823;
    t |= (t >> 4) & 268435455;
    t |= (t >> 8) & 16777215;
    t |= (t >> 16) & 65535;
    t.wrapping_add(1)
}

/// `b2Math.IsPowerOfTwo`.
pub fn is_power_of_two(t: i32) -> bool {
    t > 0 && (t & (t - 1)) == 0
}

/// `b2Vec2`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    #[inline]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    #[inline]
    pub const fn zero() -> Self {
        Self { x: 0.0, y: 0.0 }
    }
    #[inline]
    pub fn set_zero(&mut self) {
        self.x = 0.0;
        self.y = 0.0;
    }
    #[inline]
    pub fn set(&mut self, x: f64, y: f64) {
        self.x = x;
        self.y = y;
    }
    #[inline]
    pub fn set_v(&mut self, v: Vec2) {
        self.x = v.x;
        self.y = v.y;
    }
    #[inline]
    pub fn get_negative(&self) -> Vec2 {
        Vec2::new(-self.x, -self.y)
    }
    #[inline]
    pub fn negative_self(&mut self) {
        self.x = -self.x;
        self.y = -self.y;
    }
    #[inline]
    pub fn copy(&self) -> Vec2 {
        *self
    }
    #[inline]
    pub fn add(&mut self, v: Vec2) {
        self.x += v.x;
        self.y += v.y;
    }
    #[inline]
    pub fn subtract(&mut self, v: Vec2) {
        self.x -= v.x;
        self.y -= v.y;
    }
    #[inline]
    pub fn multiply(&mut self, s: f64) {
        self.x *= s;
        self.y *= s;
    }
    /// `b2Vec2.prototype.MulM`: `this = M * this`.
    #[inline]
    pub fn mul_m(&mut self, m: &Mat22) {
        let ox = self.x;
        self.x = m.col1.x * ox + m.col2.x * self.y;
        self.y = m.col1.y * ox + m.col2.y * self.y;
    }
    /// `b2Vec2.prototype.MulTM`: `this = M^T * this`.
    #[inline]
    pub fn mul_tm(&mut self, m: &Mat22) {
        let ox = dot(*self, m.col1);
        self.y = dot(*self, m.col2);
        self.x = ox;
    }
    /// `b2Vec2.prototype.CrossVF`: `this = cross(this, s)`.
    #[inline]
    pub fn cross_vf(&mut self, s: f64) {
        let ox = self.x;
        self.x = s * self.y;
        self.y = -s * ox;
    }
    /// `b2Vec2.prototype.CrossFV`: `this = cross(s, this)`.
    #[inline]
    pub fn cross_fv(&mut self, s: f64) {
        let ox = self.x;
        self.x = -s * self.y;
        self.y = s * ox;
    }
    #[inline]
    pub fn min_v(&mut self, t: Vec2) {
        self.x = if self.x < t.x { self.x } else { t.x };
        self.y = if self.y < t.y { self.y } else { t.y };
    }
    #[inline]
    pub fn max_v(&mut self, t: Vec2) {
        self.x = if self.x > t.x { self.x } else { t.x };
        self.y = if self.y > t.y { self.y } else { t.y };
    }
    #[inline]
    pub fn abs(&mut self) {
        if self.x < 0.0 {
            self.x = -self.x;
        }
        if self.y < 0.0 {
            self.y = -self.y;
        }
    }
    #[inline]
    pub fn length(&self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
    #[inline]
    pub fn length_squared(&self) -> f64 {
        self.x * self.x + self.y * self.y
    }
    /// `b2Vec2.prototype.Normalize`: scales to unit length, returns the old length
    /// (`0` and no change if the length is below `Number.MIN_VALUE`).
    #[inline]
    pub fn normalize(&mut self) -> f64 {
        let len = (self.x * self.x + self.y * self.y).sqrt();
        if len < MIN_VALUE {
            return 0.0;
        }
        let inv = 1.0 / len;
        self.x *= inv;
        self.y *= inv;
        len
    }
    #[inline]
    pub fn is_valid(&self) -> bool {
        is_valid(self.x) && is_valid(self.y)
    }
}

/// `b2Math.Dot(a, b)` = `a.x*b.x + a.y*b.y`.
#[inline]
pub fn dot(a: Vec2, b: Vec2) -> f64 {
    a.x * b.x + a.y * b.y
}
/// `b2Math.CrossVV(a, b)` = `a.x*b.y - a.y*b.x`.
#[inline]
pub fn cross_vv(a: Vec2, b: Vec2) -> f64 {
    a.x * b.y - a.y * b.x
}
/// `b2Math.CrossVF(v, s)`.
#[inline]
pub fn cross_vf(v: Vec2, s: f64) -> Vec2 {
    Vec2::new(s * v.y, -s * v.x)
}
/// `b2Math.CrossFV(s, v)`.
#[inline]
pub fn cross_fv(s: f64, v: Vec2) -> Vec2 {
    Vec2::new(-s * v.y, s * v.x)
}
/// `b2Math.MulMV(M, v)`.
#[inline]
pub fn mul_mv(m: &Mat22, v: Vec2) -> Vec2 {
    Vec2::new(
        m.col1.x * v.x + m.col2.x * v.y,
        m.col1.y * v.x + m.col2.y * v.y,
    )
}
/// `b2Math.MulTMV(M, v)` = `M^T v`.
#[inline]
pub fn mul_tmv(m: &Mat22, v: Vec2) -> Vec2 {
    Vec2::new(dot(v, m.col1), dot(v, m.col2))
}
/// `b2Math.MulX(T, v)` = `R*v + p`.
#[inline]
pub fn mul_x(t: &Transform, v: Vec2) -> Vec2 {
    let mut n = mul_mv(&t.r, v);
    n.x += t.position.x;
    n.y += t.position.y;
    n
}
/// `b2Math.MulXT(T, v)` = `R^T (v - p)`.
#[inline]
pub fn mul_xt(t: &Transform, v: Vec2) -> Vec2 {
    let mut n = subtract_vv(v, t.position);
    let s = n.x * t.r.col1.x + n.y * t.r.col1.y;
    n.y = n.x * t.r.col2.x + n.y * t.r.col2.y;
    n.x = s;
    n
}
/// `b2Math.AddVV`.
#[inline]
pub fn add_vv(a: Vec2, b: Vec2) -> Vec2 {
    Vec2::new(a.x + b.x, a.y + b.y)
}
/// `b2Math.SubtractVV`.
#[inline]
pub fn subtract_vv(a: Vec2, b: Vec2) -> Vec2 {
    Vec2::new(a.x - b.x, a.y - b.y)
}
/// `b2Math.Distance(a, b)`.
#[inline]
pub fn distance(a: Vec2, b: Vec2) -> f64 {
    let x = a.x - b.x;
    let y = a.y - b.y;
    (x * x + y * y).sqrt()
}
/// `b2Math.DistanceSquared(a, b)`.
#[inline]
pub fn distance_squared(a: Vec2, b: Vec2) -> f64 {
    let x = a.x - b.x;
    let y = a.y - b.y;
    x * x + y * y
}
/// `b2Math.MulFV(s, v)`.
#[inline]
pub fn mul_fv(s: f64, v: Vec2) -> Vec2 {
    Vec2::new(s * v.x, s * v.y)
}
/// `b2Math.AddMM(A, B)`.
#[inline]
pub fn add_mm(a: &Mat22, b: &Mat22) -> Mat22 {
    Mat22::from_vv(add_vv(a.col1, b.col1), add_vv(a.col2, b.col2))
}
/// `b2Math.MulMM(A, B)`.
#[inline]
pub fn mul_mm(a: &Mat22, b: &Mat22) -> Mat22 {
    Mat22::from_vv(mul_mv(a, b.col1), mul_mv(a, b.col2))
}
/// `b2Math.MulTMM(A, B)` = `A^T B`.
#[inline]
pub fn mul_tmm(a: &Mat22, b: &Mat22) -> Mat22 {
    let c1 = Vec2::new(dot(a.col1, b.col1), dot(a.col2, b.col1));
    let c2 = Vec2::new(dot(a.col1, b.col2), dot(a.col2, b.col2));
    Mat22::from_vv(c1, c2)
}
/// `b2Math.AbsV`.
#[inline]
pub fn abs_v(v: Vec2) -> Vec2 {
    Vec2::new(abs_f(v.x), abs_f(v.y))
}
/// `b2Math.AbsM`.
#[inline]
pub fn abs_m(m: &Mat22) -> Mat22 {
    Mat22::from_vv(abs_v(m.col1), abs_v(m.col2))
}
/// `b2Math.MinV`.
#[inline]
pub fn min_v(a: Vec2, b: Vec2) -> Vec2 {
    Vec2::new(min_f(a.x, b.x), min_f(a.y, b.y))
}
/// `b2Math.MaxV`.
#[inline]
pub fn max_v(a: Vec2, b: Vec2) -> Vec2 {
    Vec2::new(max_f(a.x, b.x), max_f(a.y, b.y))
}
/// `b2Math.ClampV(t, lo, hi) = MaxV(lo, MinV(t, hi))`.
#[inline]
pub fn clamp_v(t: Vec2, lo: Vec2, hi: Vec2) -> Vec2 {
    max_v(lo, min_v(t, hi))
}

/// `b2Vec3`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    #[inline]
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }
    #[inline]
    pub fn set_zero(&mut self) {
        self.x = 0.0;
        self.y = 0.0;
        self.z = 0.0;
    }
    #[inline]
    pub fn set(&mut self, x: f64, y: f64, z: f64) {
        self.x = x;
        self.y = y;
        self.z = z;
    }
    #[inline]
    pub fn set_v(&mut self, v: Vec3) {
        *self = v;
    }
    #[inline]
    pub fn add(&mut self, v: Vec3) {
        self.x += v.x;
        self.y += v.y;
        self.z += v.z;
    }
    #[inline]
    pub fn subtract(&mut self, v: Vec3) {
        self.x -= v.x;
        self.y -= v.y;
        self.z -= v.z;
    }
    #[inline]
    pub fn multiply(&mut self, s: f64) {
        self.x *= s;
        self.y *= s;
        self.z *= s;
    }
}

/// `b2Mat22` (column-major 2x2).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Mat22 {
    pub col1: Vec2,
    pub col2: Vec2,
}

impl Mat22 {
    /// `new b2Mat22()` (identity via `SetIdentity`).
    #[inline]
    pub fn new() -> Self {
        let mut m = Self::default();
        m.set_identity();
        m
    }
    /// `b2Mat22.FromAngle(a)`.
    #[inline]
    pub fn from_angle(a: f64) -> Self {
        let mut m = Self::default();
        m.set(a);
        m
    }
    /// `b2Mat22.FromVV(c1, c2)`.
    #[inline]
    pub fn from_vv(c1: Vec2, c2: Vec2) -> Self {
        Self { col1: c1, col2: c2 }
    }
    /// `b2Mat22.prototype.Set(angle)` (uses the rounded `SafeTrig` sin/cos).
    #[inline]
    pub fn set(&mut self, t: f64) {
        let c = safe_cos(t);
        let s = safe_sin(t);
        self.col1.x = c;
        self.col2.x = -s;
        self.col1.y = s;
        self.col2.y = c;
    }
    #[inline]
    pub fn set_vv(&mut self, c1: Vec2, c2: Vec2) {
        self.col1.set_v(c1);
        self.col2.set_v(c2);
    }
    #[inline]
    pub fn set_m(&mut self, m: &Mat22) {
        self.col1.set_v(m.col1);
        self.col2.set_v(m.col2);
    }
    #[inline]
    pub fn add_m(&mut self, m: &Mat22) {
        self.col1.x += m.col1.x;
        self.col1.y += m.col1.y;
        self.col2.x += m.col2.x;
        self.col2.y += m.col2.y;
    }
    #[inline]
    pub fn set_identity(&mut self) {
        self.col1.x = 1.0;
        self.col2.x = 0.0;
        self.col1.y = 0.0;
        self.col2.y = 1.0;
    }
    #[inline]
    pub fn set_zero(&mut self) {
        self.col1.x = 0.0;
        self.col2.x = 0.0;
        self.col1.y = 0.0;
        self.col2.y = 0.0;
    }
    /// `b2Mat22.prototype.GetInverse(out)`; writes into `out` and returns it.
    #[inline]
    pub fn get_inverse(&self, out: &mut Mat22) {
        let a = self.col1.x;
        let b = self.col2.x;
        let c = self.col1.y;
        let d = self.col2.y;
        let mut det = a * d - b * c;
        if det != 0.0 {
            det = 1.0 / det;
        }
        out.col1.x = det * d;
        out.col2.x = -det * b;
        out.col1.y = -det * c;
        out.col2.y = det * a;
    }
    /// `b2Mat22.prototype.Solve(out, bx, by)`.
    #[inline]
    pub fn solve(&self, out: &mut Vec2, bx: f64, by: f64) {
        let a11 = self.col1.x;
        let a12 = self.col2.x;
        let a21 = self.col1.y;
        let a22 = self.col2.y;
        let mut det = a11 * a22 - a12 * a21;
        if det != 0.0 {
            det = 1.0 / det;
        }
        out.x = det * (a22 * bx - a12 * by);
        out.y = det * (a11 * by - a21 * bx);
    }
    #[inline]
    pub fn abs(&mut self) {
        self.col1.abs();
        self.col2.abs();
    }
}

/// `b2Mat33` (column-major 3x3).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Mat33 {
    pub col1: Vec3,
    pub col2: Vec3,
    pub col3: Vec3,
}

impl Mat33 {
    /// `new b2Mat33(c1, c2, c3)`; `None` columns mean zero (JS `null` arguments).
    pub fn new(c1: Option<Vec3>, c2: Option<Vec3>, c3: Option<Vec3>) -> Self {
        match (c1, c2, c3) {
            (None, None, None) => Self::default(),
            (a, b, c) => Self {
                col1: a.unwrap_or_default(),
                col2: b.unwrap_or_default(),
                col3: c.unwrap_or_default(),
            },
        }
    }
    #[inline]
    pub fn set_vvv(&mut self, c1: Vec3, c2: Vec3, c3: Vec3) {
        self.col1.set_v(c1);
        self.col2.set_v(c2);
        self.col3.set_v(c3);
    }
    #[inline]
    pub fn set_m(&mut self, m: &Mat33) {
        self.col1.set_v(m.col1);
        self.col2.set_v(m.col2);
        self.col3.set_v(m.col3);
    }
    #[inline]
    pub fn add_m(&mut self, m: &Mat33) {
        self.col1.x += m.col1.x;
        self.col1.y += m.col1.y;
        self.col1.z += m.col1.z;
        self.col2.x += m.col2.x;
        self.col2.y += m.col2.y;
        self.col2.z += m.col2.z;
        self.col3.x += m.col3.x;
        self.col3.y += m.col3.y;
        self.col3.z += m.col3.z;
    }
    #[inline]
    pub fn set_identity(&mut self) {
        self.col1.x = 1.0;
        self.col2.x = 0.0;
        self.col3.x = 0.0;
        self.col1.y = 0.0;
        self.col2.y = 1.0;
        self.col3.y = 0.0;
        self.col1.z = 0.0;
        self.col2.z = 0.0;
        self.col3.z = 1.0;
    }
    #[inline]
    pub fn set_zero(&mut self) {
        *self = Self::default();
    }
    /// `b2Mat33.prototype.Solve22(out, bx, by)`.
    #[inline]
    pub fn solve22(&self, out: &mut Vec2, bx: f64, by: f64) {
        let a11 = self.col1.x;
        let a12 = self.col2.x;
        let a21 = self.col1.y;
        let a22 = self.col2.y;
        let mut det = a11 * a22 - a12 * a21;
        if det != 0.0 {
            det = 1.0 / det;
        }
        out.x = det * (a22 * bx - a12 * by);
        out.y = det * (a11 * by - a21 * bx);
    }
    /// `b2Mat33.prototype.Solve33(out, bx, by, bz)`.
    #[inline]
    pub fn solve33(&self, out: &mut Vec3, bx: f64, by: f64, bz: f64) {
        let a11 = self.col1.x;
        let a21 = self.col1.y;
        let a31 = self.col1.z;
        let a12 = self.col2.x;
        let a22 = self.col2.y;
        let a32 = self.col2.z;
        let a13 = self.col3.x;
        let a23 = self.col3.y;
        let a33 = self.col3.z;
        let mut det = a11 * (a22 * a33 - a32 * a23) + a21 * (a32 * a13 - a12 * a33) + a31 * (a12 * a23 - a22 * a13);
        if det != 0.0 {
            det = 1.0 / det;
        }
        out.x = det * (bx * (a22 * a33 - a32 * a23) + by * (a32 * a13 - a12 * a33) + bz * (a12 * a23 - a22 * a13));
        out.y = det * (a11 * (by * a33 - bz * a23) + a21 * (bz * a13 - bx * a33) + a31 * (bx * a23 - by * a13));
        out.z = det * (a11 * (a22 * bz - a32 * by) + a21 * (a32 * bx - a12 * bz) + a31 * (a12 * by - a22 * bx));
    }
}

/// `b2Transform`: position + rotation matrix.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Transform {
    pub position: Vec2,
    pub r: Mat22,
}

impl Transform {
    /// `new b2Transform()` (zero position, zero matrix until SetIdentity).
    pub fn new() -> Self {
        Self::default()
    }
    /// `b2Transform.prototype.Initialize(p, R)`.
    #[inline]
    pub fn initialize(&mut self, p: Vec2, r: &Mat22) {
        self.position.set_v(p);
        self.r.set_m(r);
    }
    #[inline]
    pub fn set_identity(&mut self) {
        self.position.set_zero();
        self.r.set_identity();
    }
    #[inline]
    pub fn set_t(&mut self, t: &Transform) {
        self.position.set_v(t.position);
        self.r.set_m(&t.r);
    }
}

/// `b2Sweep`: motion of a body's center of mass over a time step.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sweep {
    pub local_center: Vec2,
    pub c0: Vec2,
    pub c: Vec2,
    pub a0: f64,
    pub a: f64,
    pub t0: f64,
}

impl Sweep {
    /// `b2Sweep.prototype.GetTransform(xf, beta)`.
    pub fn get_transform(&self, xf: &mut Transform, beta: f64) {
        xf.position.x = (1.0 - beta) * self.c0.x + beta * self.c.x;
        xf.position.y = (1.0 - beta) * self.c0.y + beta * self.c.y;
        let angle = (1.0 - beta) * self.a0 + beta * self.a;
        xf.r.set(angle);
        let r = xf.r;
        xf.position.x -= r.col1.x * self.local_center.x + r.col2.x * self.local_center.y;
        xf.position.y -= r.col1.y * self.local_center.x + r.col2.y * self.local_center.y;
    }
    /// `b2Sweep.prototype.Advance(alpha)`.
    pub fn advance(&mut self, alpha: f64) {
        if self.t0 < alpha && 1.0 - self.t0 > MIN_VALUE {
            let beta = (alpha - self.t0) / (1.0 - self.t0);
            self.c0.x = (1.0 - beta) * self.c0.x + beta * self.c.x;
            self.c0.y = (1.0 - beta) * self.c0.y + beta * self.c.y;
            self.a0 = (1.0 - beta) * self.a0 + beta * self.a;
            self.t0 = alpha;
        }
    }
    /// `b2Sweep.prototype.Normalize`-free copy: `Set(other)`.
    pub fn set(&mut self, o: &Sweep) {
        self.local_center.set_v(o.local_center);
        self.c0.set_v(o.c0);
        self.c.set_v(o.c);
        self.a0 = o.a0;
        self.a = o.a;
        self.t0 = o.t0;
    }
}
