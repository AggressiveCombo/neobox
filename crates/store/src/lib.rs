//! Persistent state of the neobox server in one SQLite file: accounts with
//! argon2 password hashes, sign-in sessions, friends, the map library (votes,
//! favourites, moderation) and per-account player preferences.
//!
//! The API is synchronous: one connection behind a mutex, WAL journal. Async
//! callers run it on a blocking thread. Schema changes are numbered migrations
//! applied in order through `PRAGMA user_version`.

mod account;
mod clips;
mod friends;
mod library;
mod records;
mod session;
mod xp;

pub use account::{Account, MAX_PREFS_BYTES};
pub use clips::{ClipSummary, MAX_CLIPS, MAX_CLIP_BYTES};
pub use friends::{Friend, FriendState, MAX_FRIENDS, MAX_INCOMING_REQUESTS, MAX_OUTGOING_REQUESTS};
pub use library::{
    Listing, MapDetail, MapSummary, RoomMap, Sort, Status, Verdict, Visibility, MAX_CODE_BYTES, MAX_FAVOURITES,
    MAX_MAPS_PER_ACCOUNT, MAX_MAP_NAME_CHARS,
};
pub use session::{MAX_SESSIONS_PER_ACCOUNT, SESSION_TTL};
pub use xp::{XP_PER_DAY, XP_PER_HOUR, XpGrant, XpLimit};
pub use records::{Record, MAX_RECORDS};

use rusqlite::{Connection, ErrorCode};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// Why an operation failed. The text of the player-facing variants is shown
/// to players as is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The input is not acceptable.
    Invalid(&'static str),
    /// Sign-in failed. Unknown names and wrong passwords get the same answer.
    BadLogin,
    /// No such item, or one the caller may not see (hidden items look missing).
    NotFound,
    /// The item is visible to the caller but may not be changed by them.
    Forbidden(&'static str),
    /// The request clashes with existing state (for example a taken name).
    Conflict(&'static str),
    /// A per-account limit is reached.
    Limit(&'static str),
    /// Database or hashing failure; not for players.
    Internal(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Invalid(m) | Error::Forbidden(m) | Error::Conflict(m) | Error::Limit(m) => f.write_str(m),
            Error::BadLogin => f.write_str("Wrong name or password"),
            Error::NotFound => f.write_str("Not found"),
            Error::Internal(e) => write!(f, "internal error: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Error {
        Error::Internal(e.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// The database. Every method takes `&self`; the mutex serialises access, so
/// a method's read-check-write sequence is atomic with respect to others.
pub struct Store {
    conn: Mutex<Connection>,
}

/// Numbered schema migrations; `PRAGMA user_version` counts the applied ones.
/// Never edit an applied migration: append a new one.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created INTEGER NOT NULL
);

-- Only a SHA-256 digest of each session token is stored.
CREATE TABLE sessions (
    token_digest BLOB PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id, expires);
CREATE INDEX sessions_expires ON sessions (expires);

-- One row per relation: a pending request (accepted = 0) or a friendship.
CREATE TABLE friendships (
    from_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
    created INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id),
    CHECK (from_id <> to_id)
);
CREATE INDEX friendships_to ON friendships (to_id);

CREATE TABLE maps (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    size INTEGER NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    plays INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
);
CREATE INDEX maps_owner ON maps (owner_id);
CREATE INDEX maps_listing ON maps (visibility, status, created);
CREATE INDEX maps_status ON maps (status, created);

CREATE TABLE map_votes (
    map_id INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    PRIMARY KEY (map_id, account_id)
);
CREATE INDEX map_votes_account ON map_votes (account_id);

CREATE TABLE favourites (
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    map_id INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    created INTEGER NOT NULL,
    PRIMARY KEY (account_id, map_id)
);
CREATE INDEX favourites_map ON favourites (map_id);

CREATE TABLE prefs (
    account_id INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    json TEXT NOT NULL
);
"#, r#"
-- Experience: the account total, and recent grants for the farming limits.
ALTER TABLE accounts ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
CREATE TABLE xp_grants (
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    at INTEGER NOT NULL
);
CREATE INDEX xp_grants_account ON xp_grants (account_id, at);

-- Library: descriptions, staff picks (time picked, 0 = not picked), vote
-- times and a play log for the "hot" listing and the weekly top makers.
ALTER TABLE maps ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE maps ADD COLUMN pick INTEGER NOT NULL DEFAULT 0;
ALTER TABLE map_votes ADD COLUMN at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE map_plays (
    map_id INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    at INTEGER NOT NULL
);
CREATE INDEX map_plays_at ON map_plays (at);

-- Clips recorded with /record, played behind the main menu.
CREATE TABLE clips (
    id INTEGER PRIMARY KEY,
    account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
    recorder TEXT NOT NULL,
    map_name TEXT NOT NULL,
    data BLOB NOT NULL,
    created INTEGER NOT NULL
);
CREATE INDEX clips_created ON clips (created);
"#, r#"
-- Fastest Times: the best finish time (ticks) each account has on each map.
CREATE TABLE records (
    map_id INTEGER NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    ticks INTEGER NOT NULL CHECK (ticks > 0),
    at INTEGER NOT NULL,
    PRIMARY KEY (map_id, account_id)
);
CREATE INDEX records_rank ON records (map_id, ticks, at);
"#];

impl Store {
    /// Open (creating if needed) the database file and migrate it.
    pub fn open(path: &Path) -> Result<Store> {
        Self::from_connection(Connection::open(path)?)
    }

    /// A fresh database in memory, for tests.
    pub fn open_in_memory() -> Result<Store> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut conn: Connection) -> Result<Store> {
        // foreign keys carry the cascades (deleting an account removes its maps,
        // sessions, friendships, votes, favourites and preferences)
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        migrate(&mut conn)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    /// The connection. A panic in another call cannot leave the database
    /// inconsistent (every multi-statement change runs in a transaction), so a
    /// poisoned lock is recovered rather than propagated.
    pub(crate) fn db(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version > MIGRATIONS.len() as i64 {
        return Err(Error::Internal(format!("database schema version {version} is newer than this server")));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version.max(0) as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

/// Unix time in seconds.
pub(crate) fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// A unique-key or foreign-key violation (a name taken, a missing account).
pub(crate) fn is_constraint(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::ConstraintViolation)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use rusqlite::params;

    pub fn store() -> Store {
        Store::open_in_memory().expect("in-memory store")
    }

    /// An account inserted directly, with no password. For tests that only
    /// need ids, so they do not pay for argon2 on every account.
    pub fn raw_account(store: &Store, name: &str) -> i64 {
        let db = store.db();
        db.execute(
            "INSERT INTO accounts (name, name_key, password_hash, created) VALUES (?1, ?2, 'unusable', 0)",
            params![name, name.to_ascii_lowercase()],
        )
        .expect("insert account");
        db.last_insert_rowid()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_is_shared_across_threads() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Store>();
    }

    #[test]
    fn migrations_are_applied_once() {
        let s = Store::open_in_memory().unwrap();
        let version: i64 = s.db().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        // reopening an already migrated database does nothing
        let mut conn = s.db();
        migrate(&mut conn).unwrap();
    }

    #[test]
    fn newer_schema_is_refused() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", (MIGRATIONS.len() + 1) as i64).unwrap();
        assert!(matches!(migrate(&mut conn), Err(Error::Internal(_))));
    }
}
