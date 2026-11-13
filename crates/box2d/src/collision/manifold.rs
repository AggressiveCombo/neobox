//! Port of `Box2D.Collision.b2Manifold`, `b2ManifoldPoint`, `b2WorldManifold`
//! and `b2ContactID` (with its `features` view).

use crate::common::math::{MIN_VALUE, Transform, Vec2};
use crate::common::settings::MAX_MANIFOLD_POINTS;

/// `b2ContactID`. The JS object stores a single 32-bit `_key`; the four
/// `features` fields are bit fields of that key:
/// referenceEdge = bits 0..8, incidentEdge = bits 8..16,
/// incidentVertex = bits 16..24, flip = bits 24..32.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ContactFeature {
    pub key: u32,
}

impl ContactFeature {
    /// `features.referenceEdge` getter.
    #[inline]
    pub fn reference_edge(&self) -> u32 {
        self.key & 0xFF
    }
    /// `features.referenceEdge` setter.
    #[inline]
    pub fn set_reference_edge(&mut self, v: u32) {
        self.key = (self.key & 0xFFFF_FF00) | (v & 0xFF);
    }
    /// `features.incidentEdge` getter.
    #[inline]
    pub fn incident_edge(&self) -> u32 {
        (self.key >> 8) & 0xFF
    }
    /// `features.incidentEdge` setter.
    #[inline]
    pub fn set_incident_edge(&mut self, v: u32) {
        self.key = (self.key & 0xFFFF_00FF) | ((v << 8) & 0xFF00);
    }
    /// `features.incidentVertex` getter.
    #[inline]
    pub fn incident_vertex(&self) -> u32 {
        (self.key >> 16) & 0xFF
    }
    /// `features.incidentVertex` setter.
    #[inline]
    pub fn set_incident_vertex(&mut self, v: u32) {
        self.key = (self.key & 0xFF00_FFFF) | ((v << 16) & 0xFF_0000);
    }
    /// `features.flip` getter.
    #[inline]
    pub fn flip(&self) -> u32 {
        (self.key >> 24) & 0xFF
    }
    /// `features.flip` setter.
    #[inline]
    pub fn set_flip(&mut self, v: u32) {
        self.key = (self.key & 0x00FF_FFFF) | ((v << 24) & 0xFF00_0000);
    }
}

/// `b2Manifold.e_circles` / `e_faceA` / `e_faceB`. `Manifold::manifold_type`
/// is `None` where the JS `m_type` is still unset (`undefined`) or `0`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManifoldType {
    Circles,
    FaceA,
    FaceB,
}

/// `b2ManifoldPoint`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ManifoldPoint {
    pub local_point: Vec2,
    pub normal_impulse: f64,
    pub tangent_impulse: f64,
    pub id: ContactFeature,
}

/// `b2Manifold`. `local_point`/`local_normal` are `m_localPoint` / `m_localPlaneNormal`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Manifold {
    pub manifold_type: Option<ManifoldType>,
    pub local_normal: Vec2,
    pub local_point: Vec2,
    pub points: [ManifoldPoint; MAX_MANIFOLD_POINTS],
    pub point_count: usize,
}

/// `b2WorldManifold`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WorldManifold {
    pub normal: Vec2,
    pub points: [Vec2; MAX_MANIFOLD_POINTS],
}

impl WorldManifold {
    /// `b2WorldManifold.prototype.Initialize`. Leaves `self` untouched when
    /// the manifold has no points. Note the JS evaluates `p + a*x + b*y`
    /// without grouping, so the sums here are written the same way.
    pub fn initialize(
        &mut self,
        manifold: &Manifold,
        xf_a: &Transform,
        radius_a: f64,
        xf_b: &Transform,
        radius_b: f64,
    ) {
        if manifold.point_count == 0 {
            return;
        }
        match manifold.manifold_type {
            Some(ManifoldType::Circles) => {
                let a = xf_a.r;
                let r = manifold.local_point;
                let x = xf_a.position.x + a.col1.x * r.x + a.col2.x * r.y;
                let y = xf_a.position.y + a.col1.y * r.x + a.col2.y * r.y;
                let a = xf_b.r;
                let r = manifold.points[0].local_point;
                let f = xf_b.position.x + a.col1.x * r.x + a.col2.x * r.y;
                let d = xf_b.position.y + a.col1.y * r.x + a.col2.y * r.y;
                let b = f - x;
                let dd = d - y;
                let v = b * b + dd * dd;
                if v > MIN_VALUE * MIN_VALUE {
                    let len = v.sqrt();
                    self.normal.x = b / len;
                    self.normal.y = dd / len;
                } else {
                    self.normal.x = 1.0;
                    self.normal.y = 0.0;
                }
                let px = x + radius_a * self.normal.x;
                let py = y + radius_a * self.normal.y;
                let sx = f - radius_b * self.normal.x;
                let sy = d - radius_b * self.normal.y;
                self.points[0].x = 0.5 * (px + sx);
                self.points[0].y = 0.5 * (py + sy);
            }
            Some(ManifoldType::FaceA) => {
                let a = xf_a.r;
                let r = manifold.local_normal;
                let m = a.col1.x * r.x + a.col2.x * r.y;
                let c = a.col1.y * r.x + a.col2.y * r.y;
                let a = xf_a.r;
                let r = manifold.local_point;
                let h = xf_a.position.x + a.col1.x * r.x + a.col2.x * r.y;
                let p = xf_a.position.y + a.col1.y * r.x + a.col2.y * r.y;
                self.normal.x = m;
                self.normal.y = c;
                for l in 0..manifold.point_count {
                    let a = xf_b.r;
                    let r = manifold.points[l].local_point;
                    let y = xf_b.position.x + a.col1.x * r.x + a.col2.x * r.y;
                    let u = xf_b.position.y + a.col1.y * r.x + a.col2.y * r.y;
                    self.points[l].x =
                        y + 0.5 * (radius_a - (y - h) * m - (u - p) * c - radius_b) * m;
                    self.points[l].y =
                        u + 0.5 * (radius_a - (y - h) * m - (u - p) * c - radius_b) * c;
                }
            }
            Some(ManifoldType::FaceB) => {
                let a = xf_b.r;
                let r = manifold.local_normal;
                let m = a.col1.x * r.x + a.col2.x * r.y;
                let c = a.col1.y * r.x + a.col2.y * r.y;
                let a = xf_b.r;
                let r = manifold.local_point;
                let h = xf_b.position.x + a.col1.x * r.x + a.col2.x * r.y;
                let p = xf_b.position.y + a.col1.y * r.x + a.col2.y * r.y;
                self.normal.x = -m;
                self.normal.y = -c;
                for l in 0..manifold.point_count {
                    let a = xf_a.r;
                    let r = manifold.points[l].local_point;
                    let y = xf_a.position.x + a.col1.x * r.x + a.col2.x * r.y;
                    let u = xf_a.position.y + a.col1.y * r.x + a.col2.y * r.y;
                    self.points[l].x =
                        y + 0.5 * (radius_b - (y - h) * m - (u - p) * c - radius_a) * m;
                    self.points[l].y =
                        u + 0.5 * (radius_b - (y - h) * m - (u - p) * c - radius_a) * c;
                }
            }
            None => {}
        }
    }
}
