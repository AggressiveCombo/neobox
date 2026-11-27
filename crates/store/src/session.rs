//! Sign-in sessions. A session is an opaque random token held in the browser
//! cookie; the database stores only its SHA-256, so a copied database cannot
//! be replayed.

use crate::account::account_row;
use crate::sanctions::active_suspension;
use crate::{Account, Error, Result, Store, is_constraint, now};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

/// How long a session lasts without use. Each use in the last half of this
/// window extends it, so an active player stays signed in.
pub const SESSION_TTL: i64 = 30 * 24 * 60 * 60;
/// How long an admin session lasts without use (30 days, sliding on use).
pub const ADMIN_SESSION_TTL: i64 = 30 * 24 * 60 * 60;
/// Live sessions per account. Beyond this, the least recently extended are dropped.
pub const MAX_SESSIONS_PER_ACCOUNT: i64 = 20;
/// Live admin sessions kept at once.
const MAX_ADMIN_SESSIONS: i64 = 20;
/// Longest token accepted. Real tokens are 43 characters.
const MAX_TOKEN_LEN: usize = 128;

fn digest(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// Admin token digest bound to the configured admin password, so rotating
/// `NEOBOX_ADMIN_PASSWORD` invalidates all older admin cookies automatically.
fn admin_digest(token: &str, password: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(password.as_bytes());
    h.update([0u8]);
    h.update(token.as_bytes());
    h.finalize().to_vec()
}

impl Store {
    /// Start a session for the account and return its token, for the cookie.
    pub fn create_session(&self, account_id: i64) -> Result<String> {
        let mut raw = [0u8; 32];
        rand::rng().fill_bytes(&mut raw);
        let token = URL_SAFE_NO_PAD.encode(raw);
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            "INSERT INTO sessions (token_digest, account_id, expires) VALUES (?1, ?2, ?3)",
            params![digest(&token), account_id, now() + SESSION_TTL],
        )
        .map_err(|e| if is_constraint(&e) { Error::NotFound } else { e.into() })?;
        tx.execute(
            "DELETE FROM sessions WHERE account_id = ?1 AND rowid NOT IN \
             (SELECT rowid FROM sessions WHERE account_id = ?1 ORDER BY expires DESC, rowid DESC LIMIT ?2)",
            params![account_id, MAX_SESSIONS_PER_ACCOUNT],
        )?;
        tx.commit()?;
        Ok(token)
    }

    /// The account a token belongs to, if the session is live.
    pub fn session_account(&self, token: &str) -> Result<Option<Account>> {
        if token.is_empty() || token.len() > MAX_TOKEN_LEN {
            return Ok(None);
        }
        let now = now();
        let db = self.db();
        let found = db
            .query_row(
                "SELECT a.id, a.name, s.expires FROM sessions s JOIN accounts a ON a.id = s.account_id \
                 WHERE s.token_digest = ?1 AND s.expires > ?2",
                params![digest(token), now],
                |r| Ok((account_row(r)?, r.get::<_, i64>(2)?)),
            )
            .optional()?;
        let Some((account, expires)) = found else {
            return Ok(None);
        };
        if let Some(sanction) = active_suspension(&db, account.id, now)? {
            return Err(Error::Suspended(sanction));
        }
        if expires - now < SESSION_TTL / 2 {
            db.execute(
                "UPDATE sessions SET expires = ?1 WHERE token_digest = ?2",
                params![now + SESSION_TTL, digest(token)],
            )?;
        }
        Ok(Some(account))
    }

    /// Sign out one session.
    pub fn delete_session(&self, token: &str) -> Result<()> {
        self.db().execute("DELETE FROM sessions WHERE token_digest = ?1", params![digest(token)])?;
        Ok(())
    }

    /// Sign out every session of the account.
    pub fn delete_all_sessions(&self, account_id: i64) -> Result<()> {
        self.db().execute("DELETE FROM sessions WHERE account_id = ?1", [account_id])?;
        Ok(())
    }

    /// Drop expired sessions. The server calls this periodically. Returns how many were dropped.
    pub fn prune_expired_sessions(&self) -> Result<usize> {
        let t = now();
        let db = self.db();
        let n = db.execute("DELETE FROM sessions WHERE expires <= ?1", [t])?;
        let m = db.execute("DELETE FROM admin_sessions WHERE expires <= ?1", [t])?;
        Ok(n + m)
    }

    /// Create a persistent admin session bound to `password` and return its opaque cookie token.
    pub fn create_admin_session(&self, password: &str) -> Result<String> {
        let mut raw = [0u8; 32];
        rand::rng().fill_bytes(&mut raw);
        let token = URL_SAFE_NO_PAD.encode(raw);
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            "INSERT INTO admin_sessions (token_digest, expires) VALUES (?1, ?2)",
            params![admin_digest(&token, password), now() + ADMIN_SESSION_TTL],
        )?;
        tx.execute(
            "DELETE FROM admin_sessions WHERE rowid NOT IN \
             (SELECT rowid FROM admin_sessions ORDER BY expires DESC, rowid DESC LIMIT ?1)",
            params![MAX_ADMIN_SESSIONS],
        )?;
        tx.commit()?;
        Ok(token)
    }

    /// Whether `token` is a live admin session for `password`. Slides its expiry when past halfway.
    pub fn check_admin_session(&self, token: &str, password: &str) -> Result<bool> {
        if token.is_empty() || token.len() > MAX_TOKEN_LEN || password.is_empty() {
            return Ok(false);
        }
        let t = now();
        let d = admin_digest(token, password);
        let db = self.db();
        let expires: Option<i64> = db
            .query_row("SELECT expires FROM admin_sessions WHERE token_digest = ?1 AND expires > ?2", params![&d, t], |r| r.get(0))
            .optional()?;
        let Some(expires) = expires else {
            return Ok(false);
        };
        if expires - t < ADMIN_SESSION_TTL / 2 {
            db.execute("UPDATE admin_sessions SET expires = ?1 WHERE token_digest = ?2", params![t + ADMIN_SESSION_TTL, &d])?;
        }
        Ok(true)
    }

    /// Sign out one admin session.
    pub fn delete_admin_session(&self, token: &str, password: &str) -> Result<()> {
        self.db().execute("DELETE FROM admin_sessions WHERE token_digest = ?1", params![admin_digest(token, password)])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    fn expiry(s: &Store, token: &str) -> i64 {
        s.db()
            .query_row("SELECT expires FROM sessions WHERE token_digest = ?1", params![digest(token)], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn token_resolves_to_its_account() {
        let s = store();
        let id = raw_account(&s, "Ann");
        let token = s.create_session(id).unwrap();
        assert_eq!(token.len(), 43);
        let account = s.session_account(&token).unwrap().unwrap();
        assert_eq!(account.id, id);
        assert_eq!(account.name, "Ann");
    }

    #[test]
    fn only_a_digest_is_stored() {
        let s = store();
        let id = raw_account(&s, "Ann");
        let token = s.create_session(id).unwrap();
        let raw_matches: i64 = s
            .db()
            .query_row("SELECT COUNT(*) FROM sessions WHERE token_digest = ?1", params![token.as_bytes()], |r| r.get(0))
            .unwrap();
        assert_eq!(raw_matches, 0);
        assert!(expiry(&s, &token) > now());
    }

    #[test]
    fn unknown_and_malformed_tokens_resolve_to_nothing() {
        let s = store();
        let id = raw_account(&s, "Ann");
        s.create_session(id).unwrap();
        assert_eq!(s.session_account("").unwrap(), None);
        assert_eq!(s.session_account("not a token").unwrap(), None);
        assert_eq!(s.session_account(&"a".repeat(MAX_TOKEN_LEN + 1)).unwrap(), None);
    }

    #[test]
    fn expired_sessions_stop_working_and_can_be_pruned() {
        let s = store();
        let id = raw_account(&s, "Ann");
        let token = s.create_session(id).unwrap();
        s.db().execute("UPDATE sessions SET expires = ?1", [now() - 1]).unwrap();
        assert_eq!(s.session_account(&token).unwrap(), None);
        assert_eq!(s.prune_expired_sessions().unwrap(), 1);
    }

    #[test]
    fn sessions_slide_only_in_the_last_half_of_their_life() {
        let s = store();
        let id = raw_account(&s, "Ann");
        let token = s.create_session(id).unwrap();
        let fresh = expiry(&s, &token);
        s.session_account(&token).unwrap();
        assert_eq!(expiry(&s, &token), fresh);
        s.db().execute("UPDATE sessions SET expires = ?1", [now() + SESSION_TTL / 4]).unwrap();
        s.session_account(&token).unwrap();
        assert!(expiry(&s, &token) >= now() + SESSION_TTL - 5);
    }

    #[test]
    fn admin_sessions_persist_slide_and_bind_to_password() {
        let s = store();
        let token = s.create_admin_session("secret1").unwrap();
        assert!(s.check_admin_session(&token, "secret1").unwrap());
        assert!(!s.check_admin_session(&token, "secret2").unwrap());
        s.db().execute("UPDATE admin_sessions SET expires = ?1", [now() + ADMIN_SESSION_TTL / 4]).unwrap();
        assert!(s.check_admin_session(&token, "secret1").unwrap());
        let exp: i64 = s.db().query_row("SELECT expires FROM admin_sessions", [], |r| r.get(0)).unwrap();
        assert!(exp >= now() + ADMIN_SESSION_TTL - 5);
        s.delete_admin_session(&token, "secret1").unwrap();
        assert!(!s.check_admin_session(&token, "secret1").unwrap());
    }

    #[test]
    fn sign_out_one_or_everywhere() {
        let s = store();
        let ann = raw_account(&s, "Ann");
        let bo = raw_account(&s, "Bo");
        let a1 = s.create_session(ann).unwrap();
        let a2 = s.create_session(ann).unwrap();
        let b1 = s.create_session(bo).unwrap();
        s.delete_session(&a1).unwrap();
        assert_eq!(s.session_account(&a1).unwrap(), None);
        assert!(s.session_account(&a2).unwrap().is_some());
        s.delete_all_sessions(ann).unwrap();
        assert_eq!(s.session_account(&a2).unwrap(), None);
        assert!(s.session_account(&b1).unwrap().is_some(), "other accounts keep their sessions");
    }

    #[test]
    fn each_account_keeps_only_its_newest_sessions() {
        let s = store();
        let id = raw_account(&s, "Ann");
        let tokens: Vec<String> = (0..=MAX_SESSIONS_PER_ACCOUNT).map(|_| s.create_session(id).unwrap()).collect();
        assert_eq!(s.session_account(&tokens[0]).unwrap(), None);
        assert!(s.session_account(tokens.last().unwrap()).unwrap().is_some());
        let count: i64 = s.db().query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap();
        assert_eq!(count, MAX_SESSIONS_PER_ACCOUNT);
    }

    #[test]
    fn sessions_need_an_account() {
        let s = store();
        assert_eq!(s.create_session(12345), Err(Error::NotFound));
    }
}
