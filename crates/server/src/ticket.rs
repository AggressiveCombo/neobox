//! Signed-in player tickets: the main server vouches for an account to a
//! regional game node. Format: `base64url(json claims) + "." + base64url(HMAC-SHA256)`.

use crate::hub::AccountRef;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

/// Seconds a ticket stays valid.
pub const LIFETIME: u64 = 60;

#[derive(Serialize, Deserialize)]
struct Claims {
    /// account id
    a: i64,
    /// account name
    n: String,
    /// account XP
    x: u64,
    /// expiry, unix seconds
    e: u64,
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn mac(secret: &str) -> HmacSha256 {
    HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts keys of any length")
}

/// A ticket for `account`, valid for [`LIFETIME`] seconds from `now`.
pub fn issue(secret: &str, account: &AccountRef, xp: u64, now: u64) -> String {
    let claims = Claims { a: account.id, n: account.name.clone(), x: xp, e: now + LIFETIME };
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap_or_default());
    let mut m = mac(secret);
    m.update(payload.as_bytes());
    format!("{payload}.{}", URL_SAFE_NO_PAD.encode(m.finalize().into_bytes()))
}

/// The account and its XP behind a ticket, if the signature is genuine and the
/// ticket has not expired.
pub fn verify(secret: &str, ticket: &str, now: u64) -> Option<(AccountRef, u64)> {
    let (payload, sig) = ticket.split_once('.')?;
    let sig = URL_SAFE_NO_PAD.decode(sig).ok()?;
    let mut m = mac(secret);
    m.update(payload.as_bytes());
    // constant-time comparison
    m.verify_slice(&sig).ok()?;
    let claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    if claims.e < now {
        return None;
    }
    Some((AccountRef { id: claims.a, name: claims.n }, claims.x))
}
