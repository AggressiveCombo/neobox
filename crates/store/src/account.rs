//! Accounts: the name a player signs in with, its argon2id password hash, and
//! the per-account player preferences.

use crate::{Error, Result, Store, is_constraint, now};
use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use rusqlite::{OptionalExtension, Row, params};
use std::sync::LazyLock;

/// Largest saved preferences document, in bytes.
pub const MAX_PREFS_BYTES: usize = 16 * 1024;
const PASSWORD_MIN_CHARS: usize = 8;
const PASSWORD_MAX_CHARS: usize = 128;

/// A registered account. `name` is the player name as registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: i64,
    pub name: String,
}

/// An account as the admin account search lists it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AccountSummary {
    pub id: i64,
    pub name: String,
    /// Experience total.
    pub xp: u64,
    /// Unix seconds.
    pub created: i64,
}

/// Reads `id, name` (in that order).
pub(crate) fn account_row(r: &Row<'_>) -> rusqlite::Result<Account> {
    Ok(Account { id: r.get(0)?, name: r.get(1)? })
}

/// Names are unique ignoring ASCII case; names are ASCII, so this is the key.
pub(crate) fn name_key(name: &str) -> String {
    name.to_ascii_lowercase()
}

fn check_name(name: &str) -> Result<()> {
    if neobox_net::valid_name(name) {
        Ok(())
    } else {
        Err(Error::Invalid("Names are 1 to 15 letters, digits, spaces or underscores"))
    }
}

fn check_password(password: &str) -> Result<()> {
    let n = password.chars().count();
    if (PASSWORD_MIN_CHARS..=PASSWORD_MAX_CHARS).contains(&n) {
        Ok(())
    } else {
        Err(Error::Invalid("Passwords are 8 to 128 characters"))
    }
}

fn hash_password(password: &str) -> Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| Error::Internal(e.to_string()))
}

fn verify(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

/// Verified against when a name is unknown, so an unknown name costs as much as a wrong password.
static DUMMY_HASH: LazyLock<String> =
    LazyLock::new(|| hash_password("neobox-dummy-password").expect("argon2 with default parameters"));

impl Store {
    /// Create an account. Hashing runs outside the lock: argon2 takes tens of
    /// milliseconds and must not stall other requests.
    pub fn register(&self, name: &str, password: &str) -> Result<Account> {
        check_name(name)?;
        check_password(password)?;
        let hash = hash_password(password)?;
        let db = self.db();
        match db.execute(
            "INSERT INTO accounts (name, name_key, password_hash, created) VALUES (?1, ?2, ?3, ?4)",
            params![name, name_key(name), hash, now()],
        ) {
            Ok(_) => Ok(Account { id: db.last_insert_rowid(), name: name.to_owned() }),
            Err(e) if is_constraint(&e) => Err(Error::Conflict("That name is taken")),
            Err(e) => Err(e.into()),
        }
    }

    /// Check a name and password. An unknown name takes the same time and gets
    /// the same error as a wrong password, so the name cannot be probed.
    pub fn login(&self, name: &str, password: &str) -> Result<Account> {
        let row = self
            .db()
            .query_row(
                "SELECT id, name, password_hash FROM accounts WHERE name_key = ?1",
                params![name_key(name)],
                |r| Ok((account_row(r)?, r.get::<_, String>(2)?)),
            )
            .optional()?;
        match row {
            Some((account, hash)) if verify(&hash, password) => Ok(account),
            Some(_) => Err(Error::BadLogin),
            None => {
                verify(&DUMMY_HASH, password);
                Err(Error::BadLogin)
            }
        }
    }

    /// The account with this name (ignoring case), if any.
    pub fn find_account(&self, name: &str) -> Result<Option<Account>> {
        Ok(self
            .db()
            .query_row("SELECT id, name FROM accounts WHERE name_key = ?1", params![name_key(name)], account_row)
            .optional()?)
    }

    /// Set a new password, checked against the old one. Every session of the
    /// account is signed out, so the caller must start a new one.
    pub fn change_password(&self, id: i64, old: &str, new: &str) -> Result<()> {
        check_password(new)?;
        let current = self.password_hash_of(id)?;
        if !verify(&current, old) {
            return Err(Error::Forbidden("Your current password is wrong"));
        }
        let next = hash_password(new)?;
        let mut db = self.db();
        let tx = db.transaction()?;
        // compare-and-set: a concurrent password change is not silently overwritten
        let changed = tx.execute(
            "UPDATE accounts SET password_hash = ?1 WHERE id = ?2 AND password_hash = ?3",
            params![next, id, current],
        )?;
        if changed == 0 {
            return Err(Error::Conflict("The password changed; try again"));
        }
        tx.execute("DELETE FROM sessions WHERE account_id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Delete the account and everything it owns. Needs the password, so a
    /// stolen session alone cannot delete it.
    pub fn delete_account(&self, id: i64, password: &str) -> Result<()> {
        let current = self.password_hash_of(id)?;
        if !verify(&current, password) {
            return Err(Error::Forbidden("Your password is wrong"));
        }
        self.remove_account(id)
    }

    /// Delete an account without a password check. Admin action only.
    pub fn admin_delete_account(&self, id: i64) -> Result<()> {
        self.remove_account(id)
    }

    fn remove_account(&self, id: i64) -> Result<()> {
        // cascades remove sessions, friendships, votes, favourites, prefs and maps
        let n = self.db().execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }

    fn password_hash_of(&self, id: i64) -> Result<String> {
        self.db()
            .query_row("SELECT password_hash FROM accounts WHERE id = ?1", [id], |r| r.get::<_, String>(0))
            .optional()?
            .ok_or(Error::NotFound)
    }

    /// Set an account's password without the old one. Admin action only. Every
    /// session of the account is signed out, so the player must sign in again.
    pub fn admin_set_password(&self, id: i64, password: &str) -> Result<()> {
        check_password(password)?;
        let hash = hash_password(password)?;
        let mut db = self.db();
        let tx = db.transaction()?;
        let n = tx.execute("UPDATE accounts SET password_hash = ?1 WHERE id = ?2", params![hash, id])?;
        if n == 0 {
            return Err(Error::NotFound);
        }
        tx.execute("DELETE FROM sessions WHERE account_id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Accounts whose name contains `query` (ignoring case), newest first; every
    /// account when `query` is empty. Admin search only.
    pub fn find_accounts(&self, query: &str, limit: usize) -> Result<Vec<AccountSummary>> {
        let escaped = query.chars().take(40).collect::<String>().to_ascii_lowercase();
        let escaped = escaped.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT id, name, xp, created FROM accounts WHERE name_key LIKE ?1 ESCAPE '\\' \
             ORDER BY created DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![format!("%{escaped}%"), limit as i64], |r| {
            Ok(AccountSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                xp: r.get::<_, i64>(2)?.max(0) as u64,
                created: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The saved preferences document, or `{}` if none was saved.
    pub fn get_prefs(&self, id: i64) -> Result<String> {
        Ok(self
            .db()
            .query_row("SELECT json FROM prefs WHERE account_id = ?1", [id], |r| r.get::<_, String>(0))
            .optional()?
            .unwrap_or_else(|| "{}".to_owned()))
    }

    /// Replace the preferences document. It must be a JSON object of at most 16 KiB.
    pub fn set_prefs(&self, id: i64, json: &str) -> Result<()> {
        if json.len() > MAX_PREFS_BYTES {
            return Err(Error::Invalid("Preferences are too large"));
        }
        match serde_json::from_str::<serde_json::Value>(json) {
            Ok(v) if v.is_object() => {}
            _ => return Err(Error::Invalid("Preferences must be a JSON object")),
        }
        self.db()
            .execute(
                "INSERT INTO prefs (account_id, json) VALUES (?1, ?2) \
                 ON CONFLICT (account_id) DO UPDATE SET json = excluded.json",
                params![id, json],
            )
            .map_err(|e| if is_constraint(&e) { Error::NotFound } else { e.into() })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};
    use crate::Visibility;

    const PASSWORD: &str = "correct horse";

    #[test]
    fn names_follow_player_rules() {
        let s = store();
        let long = "a".repeat(16);
        for bad in ["", "bob!", "a-b", "é", "a.b", long.as_str()] {
            assert!(matches!(s.register(bad, PASSWORD), Err(Error::Invalid(_))), "{bad:?}");
        }
        s.register(&"a".repeat(15), PASSWORD).unwrap();
        s.register("a b_c 9", PASSWORD).unwrap();
    }

    #[test]
    fn names_are_unique_ignoring_case() {
        let s = store();
        s.register("Bob", PASSWORD).unwrap();
        assert_eq!(s.register("bOB", PASSWORD), Err(Error::Conflict("That name is taken")));
        assert!(s.login("BOB", PASSWORD).is_ok());
    }

    #[test]
    fn password_length_counts_characters() {
        let s = store();
        assert!(matches!(s.register("a1", "1234567"), Err(Error::Invalid(_))));
        s.register("ok1", "12345678").unwrap();
        s.register("ok2", &"é".repeat(8)).unwrap(); // 8 characters, 16 bytes
        assert!(matches!(s.register("ok3", &"é".repeat(7)), Err(Error::Invalid(_))));
        s.register("ok4", &"x".repeat(128)).unwrap();
        assert!(matches!(s.register("ok5", &"x".repeat(129)), Err(Error::Invalid(_))));
    }

    #[test]
    fn failed_logins_look_the_same() {
        let s = store();
        s.register("Carol", PASSWORD).unwrap();
        let wrong = s.login("Carol", "wrong password").unwrap_err();
        let unknown = s.login("Nobody", PASSWORD).unwrap_err();
        assert_eq!(wrong, Error::BadLogin);
        assert_eq!(unknown, Error::BadLogin);
        assert_eq!(wrong.to_string(), "Wrong name or password");
    }

    #[test]
    fn passwords_are_stored_as_argon2_hashes() {
        let s = store();
        s.register("Dan", PASSWORD).unwrap();
        let hash: String = s
            .db()
            .query_row("SELECT password_hash FROM accounts WHERE name_key = 'dan'", [], |r| r.get(0))
            .unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(!hash.contains(PASSWORD));
    }

    #[test]
    fn change_password_checks_the_old_one_and_signs_out_everywhere() {
        let s = store();
        let a = s.register("Eve", PASSWORD).unwrap();
        let token = s.create_session(a.id).unwrap();
        assert_eq!(
            s.change_password(a.id, "not the password", "new password"),
            Err(Error::Forbidden("Your current password is wrong"))
        );
        assert!(matches!(s.change_password(a.id, PASSWORD, "short"), Err(Error::Invalid(_))));
        s.change_password(a.id, PASSWORD, "new password").unwrap();
        assert_eq!(s.login("Eve", PASSWORD), Err(Error::BadLogin));
        assert_eq!(s.login("Eve", "new password").unwrap(), a);
        assert_eq!(s.session_account(&token).unwrap(), None);
    }

    #[test]
    fn delete_account_needs_the_password_and_removes_everything() {
        let s = store();
        let a = s.register("Fay", PASSWORD).unwrap();
        let b = s.register("Gus", PASSWORD).unwrap();
        let token = s.create_session(a.id).unwrap();
        let map = s.upload(a.id, "Mine", &neobox_sim::MapData::default().to_code(), Visibility::Unlisted, "").unwrap();
        s.vote(b.id, map, 1).unwrap();
        s.favourite(b.id, map, true).unwrap();
        s.set_prefs(a.id, "{}").unwrap();
        s.request(a.id, "Gus").unwrap();

        assert_eq!(s.delete_account(a.id, "wrong password"), Err(Error::Forbidden("Your password is wrong")));
        assert!(s.login("Fay", PASSWORD).is_ok());

        s.delete_account(a.id, PASSWORD).unwrap();
        assert_eq!(s.session_account(&token).unwrap(), None);
        assert_eq!(s.login("Fay", PASSWORD), Err(Error::BadLogin));
        assert!(matches!(s.get(map, Some(b.id), false), Err(Error::NotFound)));
        assert!(s.friends(b.id).unwrap().is_empty());
        assert_eq!(s.delete_account(a.id, PASSWORD), Err(Error::NotFound));
        for table in ["maps", "map_votes", "favourites", "prefs", "sessions", "friendships"] {
            let n: i64 = s.db().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table}");
        }
        // the name is free again
        s.register("Fay", PASSWORD).unwrap();
    }

    #[test]
    fn admin_delete_needs_an_existing_account() {
        let s = store();
        let id = raw_account(&s, "Hal");
        s.admin_delete_account(id).unwrap();
        assert_eq!(s.admin_delete_account(id), Err(Error::NotFound));
    }

    #[test]
    fn prefs_are_an_object_of_at_most_16_kib() {
        let s = store();
        let a = s.register("Ivy", PASSWORD).unwrap();
        assert_eq!(s.get_prefs(a.id).unwrap(), "{}");
        s.set_prefs(a.id, r#"{"volume":0.5}"#).unwrap();
        assert_eq!(s.get_prefs(a.id).unwrap(), r#"{"volume":0.5}"#);
        for bad in ["[]", "3", "{", "\"x\""] {
            assert!(matches!(s.set_prefs(a.id, bad), Err(Error::Invalid(_))), "{bad}");
        }
        let pad = "a".repeat(MAX_PREFS_BYTES - r#"{"x":""}"#.len());
        let exact = format!(r#"{{"x":"{pad}"}}"#);
        assert_eq!(exact.len(), MAX_PREFS_BYTES);
        s.set_prefs(a.id, &exact).unwrap();
        let over = format!(r#"{{"x":"{pad}a"}}"#);
        assert!(matches!(s.set_prefs(a.id, &over), Err(Error::Invalid(_))));
        assert_eq!(s.set_prefs(999, "{}"), Err(Error::NotFound));
    }

    #[test]
    fn admin_password_reset_signs_every_session_out() {
        let s = store();
        let id = s.register("forgetful", PASSWORD).unwrap().id;
        let token = s.create_session(id).unwrap();
        let other = s.create_session(id).unwrap();
        assert!(s.session_account(&token).unwrap().is_some());
        s.admin_set_password(id, "new password").unwrap();
        assert!(s.session_account(&token).unwrap().is_none());
        assert!(s.session_account(&other).unwrap().is_none());
        assert!(s.login("forgetful", "new password").is_ok());
        assert_eq!(s.login("forgetful", PASSWORD), Err(Error::BadLogin));
    }

    #[test]
    fn admin_password_reset_checks_length_and_account() {
        let s = store();
        let id = raw_account(&s, "ghost");
        assert!(matches!(s.admin_set_password(id, "short"), Err(Error::Invalid(_))));
        assert_eq!(s.admin_set_password(id + 99, "long enough"), Err(Error::NotFound));
    }

    #[test]
    fn account_search_matches_names_literally() {
        let s = store();
        raw_account(&s, "Ada_1");
        raw_account(&s, "adam");
        raw_account(&s, "Bob");
        let names = |q: &str| s.find_accounts(q, 10).unwrap().into_iter().map(|a| a.name).collect::<Vec<_>>();
        assert_eq!(names("ad"), vec!["adam", "Ada_1"]);
        assert_eq!(names("_"), vec!["Ada_1"]);
        assert_eq!(names("%"), Vec::<String>::new());
        assert_eq!(names(""), vec!["Bob", "adam", "Ada_1"]);
    }
}
