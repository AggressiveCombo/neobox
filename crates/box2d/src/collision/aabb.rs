//! `b2AABB` and the ray-cast input/output records (`b2RayCastInput`,
//! `b2RayCastOutput`) from `Box2D.Collision`.

use crate::common::math::{Vec2, js_max, js_min};

/// `Number.MIN_VALUE` (smallest positive subnormal double).
const MIN_VALUE: f64 = f64::from_bits(1);

/// `b2RayCastInput`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RayCastInput {
    pub p1: Vec2,
    pub p2: Vec2,
    pub max_fraction: f64,
}

/// `b2RayCastOutput`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RayCastOutput {
    pub normal: Vec2,
    pub fraction: f64,
}

/// `b2AABB`: axis-aligned bounding box.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AABB {
    pub lower_bound: Vec2,
    pub upper_bound: Vec2,
}

impl AABB {
    pub fn new() -> Self {
        Self::default()
    }

    /// `b2AABB.prototype.IsValid`.
    pub fn is_valid(&self) -> bool {
        let dx = self.upper_bound.x - self.lower_bound.x;
        let dy = self.upper_bound.y - self.lower_bound.y;
        let valid = dx >= 0.0 && dy >= 0.0;
        valid && self.lower_bound.is_valid() && self.upper_bound.is_valid()
    }

    /// `b2AABB.prototype.GetCenter`.
    pub fn get_center(&self) -> Vec2 {
        Vec2 {
            x: (self.lower_bound.x + self.upper_bound.x) / 2.0,
            y: (self.lower_bound.y + self.upper_bound.y) / 2.0,
        }
    }

    /// `b2AABB.prototype.GetExtents`.
    pub fn get_extents(&self) -> Vec2 {
        Vec2 {
            x: (self.upper_bound.x - self.lower_bound.x) / 2.0,
            y: (self.upper_bound.y - self.lower_bound.y) / 2.0,
        }
    }

    /// `b2AABB.prototype.Contains(other)`: true if `other` lies inside `self`.
    pub fn contains(&self, other: &AABB) -> bool {
        self.lower_bound.x <= other.lower_bound.x
            && self.lower_bound.y <= other.lower_bound.y
            && other.upper_bound.x <= self.upper_bound.x
            && other.upper_bound.y <= self.upper_bound.y
    }

    /// `b2AABB.prototype.RayCast(output, input)` (slab test, JS operation order).
    pub fn ray_cast(&self, output: &mut RayCastOutput, input: &RayCastInput) -> bool {
        let mut tmin = -f64::MAX;
        let mut tmax = f64::MAX;

        let p_x = input.p1.x;
        let p_y = input.p1.y;
        let d_x = input.p2.x - input.p1.x;
        let d_y = input.p2.y - input.p1.y;
        let mut normal = output.normal;
        let mut inv_d: f64;
        let mut t1: f64;
        let mut t2: f64;
        let mut tmp: f64;
        let mut side: f64;

        // x slab
        if d_x.abs() < MIN_VALUE {
            if p_x < self.lower_bound.x || self.upper_bound.x < p_x {
                return false;
            }
        } else {
            inv_d = 1.0 / d_x;
            t1 = (self.lower_bound.x - p_x) * inv_d;
            t2 = (self.upper_bound.x - p_x) * inv_d;
            side = -1.0;
            if t1 > t2 {
                tmp = t1;
                t1 = t2;
                t2 = tmp;
                side = 1.0;
            }
            if t1 > tmin {
                normal.y = 0.0;
                normal.x = side;
                tmin = t1;
            }
            tmax = js_min(tmax, t2);
            if tmin > tmax {
                output.normal = normal;
                return false;
            }
        }

        // y slab
        if d_y.abs() < MIN_VALUE {
            if p_y < self.lower_bound.y || self.upper_bound.y < p_y {
                output.normal = normal;
                return false;
            }
        } else {
            inv_d = 1.0 / d_y;
            t1 = (self.lower_bound.y - p_y) * inv_d;
            t2 = (self.upper_bound.y - p_y) * inv_d;
            side = -1.0;
            if t1 > t2 {
                tmp = t1;
                t1 = t2;
                t2 = tmp;
                side = 1.0;
            }
            if t1 > tmin {
                normal.x = 0.0;
                normal.y = side;
                tmin = t1;
            }
            tmax = js_min(tmax, t2);
            if tmin > tmax {
                output.normal = normal;
                return false;
            }
        }

        output.normal = normal;
        output.fraction = tmin;
        true
    }

    /// `b2AABB.prototype.TestOverlap(other)`.
    pub fn test_overlap(&self, other: &AABB) -> bool {
        let d1x = other.lower_bound.x - self.upper_bound.x;
        let d1y = other.lower_bound.y - self.upper_bound.y;
        let d2x = self.lower_bound.x - other.upper_bound.x;
        let d2y = self.lower_bound.y - other.upper_bound.y;
        !(d1x > 0.0 || d1y > 0.0 || d2x > 0.0 || d2y > 0.0)
    }

    /// `b2AABB.prototype.Combine(a, b)`: sets `self` to the union of `a` and `b`.
    pub fn combine_from(&mut self, a: &AABB, b: &AABB) {
        self.lower_bound.x = js_min(a.lower_bound.x, b.lower_bound.x);
        self.lower_bound.y = js_min(a.lower_bound.y, b.lower_bound.y);
        self.upper_bound.x = js_max(a.upper_bound.x, b.upper_bound.x);
        self.upper_bound.y = js_max(a.upper_bound.y, b.upper_bound.y);
    }

    /// `b2AABB.Combine(a, b)` (static): union of `a` and `b`.
    pub fn combine(a: &AABB, b: &AABB) -> AABB {
        let mut out = AABB::new();
        out.combine_from(a, b);
        out
    }
}
