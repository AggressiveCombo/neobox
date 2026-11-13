//! JavaScript-compatible numeric helpers.
//!
//! The original game runs on JavaScript numbers (IEEE-754 doubles). These
//! helpers reproduce the exact JS semantics the simulation depends on, and the
//! game's quantized trigonometry (results rounded to 7 decimal places so that
//! different browsers' `Math.sin` implementations agree).

use serde_json::Value;

/// JavaScript `Math.round`: round half toward +infinity, keep `-0`.
#[inline]
pub fn round(x: f64) -> f64 {
    neobox_box2d::math::js_round(x)
}

/// Quantized sine: `round(sin(x) * 1e7) / 1e7`.
#[inline]
pub fn qsin(x: f64) -> f64 {
    round(libm::sin(x) * 10000000.0) / 10000000.0
}

/// Quantized cosine: `round(cos(x) * 1e7) / 1e7`.
#[inline]
pub fn qcos(x: f64) -> f64 {
    round(libm::cos(x) * 1e7) / 10000000.0
}

/// Quantized `atan2(y, x)`.
#[inline]
pub fn qatan2(y: f64, x: f64) -> f64 {
    round(libm::atan2(y, x) * 10000000.0) / 10000000.0
}

/// JavaScript `Math.max(a, b)` (NaN-propagating).
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        // +0 wins over -0
        if a == 0.0 && (a.is_sign_negative() && b.is_sign_negative()) { a } else if a == 0.0 { 0.0 } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

/// JavaScript `Math.min(a, b)` (NaN-propagating).
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a == 0.0 && (a.is_sign_negative() || b.is_sign_negative()) { -0.0 } else { a }
    } else if a < b {
        a
    } else {
        b
    }
}

/// JavaScript `ToNumber` for values coming from map JSON.
pub fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => *b as u8 as f64,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// JavaScript truthiness for values coming from map JSON.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// JavaScript `ToInt32` (used by `|`, `>>` and `<<`).
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    let m = t.rem_euclid(4294967296.0);
    (m as u64 as u32) as i32
}
