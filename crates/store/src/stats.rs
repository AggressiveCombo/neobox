//! Player statistics: what each signed-in player did in finished games, summed
//! on the account, and the public profile built from them with the account's
//! other totals.

use crate::account::name_key;
use crate::library::{LISTED, SCORE};
use crate::{Error, Result, Store};
use rusqlite::{OptionalExtension, params};

/// Most maps a profile lists.
const PROFILE_MAPS: i64 = 5;

/// What a player did in finished games. Used both as the totals an account
/// keeps and as one game's numbers when the server records it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MatchStats {
    /// Games finished: a custom match, or one game of a quick-play rotation.
    pub games: i64,
    /// Games won: first place, or a team win.
    pub wins: i64,
    /// Rounds won within those games.
    pub rounds_won: i64,
    pub kills: i64,
    pub deaths: i64,
    /// Time in play (not spectating), in seconds.
    pub play_seconds: i64,
}

/// A map listed on a profile.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProfileMap {
    pub id: i64,
    pub name: String,
    pub plays: i64,
    pub score: i64,
}

/// A player's public profile. Nothing private: no password, sessions,
/// preferences or friend names.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Profile {
    pub id: i64,
    pub name: String,
    /// Unix seconds when the account was made.
    pub joined: i64,
    /// Experience total.
    pub xp: u64,
    pub stats: MatchStats,
    /// Accepted friendships.
    pub friends: i64,
    /// Listed maps the player made.
    pub published: i64,
    /// The best listed maps: by votes, then plays.
    pub maps: Vec<ProfileMap>,
    /// Listed maps where the player holds the fastest time.
    pub records: i64,
}

impl Store {
    /// Add one finished game's numbers to the account's totals.
    pub fn record_stats(&self, account: i64, s: &MatchStats) -> Result<()> {
        let changed = self.db().execute(
            "UPDATE accounts SET games = games + ?2, wins = wins + ?3, rounds_won = rounds_won + ?4, \
             kills = kills + ?5, deaths = deaths + ?6, play_seconds = play_seconds + ?7 WHERE id = ?1",
            params![account, s.games, s.wins, s.rounds_won, s.kills, s.deaths, s.play_seconds],
        )?;
        if changed == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    /// The public profile of the account with this name (ignoring case), if any.
    pub fn profile(&self, name: &str) -> Result<Option<Profile>> {
        let db = self.db();
        let found = db
            .query_row(
                "SELECT id, name, created, xp, games, wins, rounds_won, kills, deaths, play_seconds \
                 FROM accounts WHERE name_key = ?1",
                params![name_key(name)],
                |r| {
                    Ok(Profile {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        joined: r.get(2)?,
                        xp: r.get::<_, i64>(3)? as u64,
                        stats: MatchStats {
                            games: r.get(4)?,
                            wins: r.get(5)?,
                            rounds_won: r.get(6)?,
                            kills: r.get(7)?,
                            deaths: r.get(8)?,
                            play_seconds: r.get(9)?,
                        },
                        friends: 0,
                        published: 0,
                        maps: Vec::new(),
                        records: 0,
                    })
                },
            )
            .optional()?;
        let Some(mut p) = found else { return Ok(None) };
        p.friends = db.query_row(
            "SELECT COUNT(*) FROM friendships WHERE accepted = 1 AND (from_id = ?1 OR to_id = ?1)",
            [p.id],
            |r| r.get(0),
        )?;
        p.published = db.query_row(
            &format!("SELECT COUNT(*) FROM maps m WHERE m.owner_id = ?1 AND {LISTED}"),
            [p.id],
            |r| r.get(0),
        )?;
        let mut stmt = db.prepare(&format!(
            "SELECT m.id, m.name, m.plays, {SCORE} FROM maps m WHERE m.owner_id = ?1 AND {LISTED} \
             ORDER BY {SCORE} DESC, m.plays DESC, m.id DESC LIMIT ?2"
        ))?;
        p.maps = stmt
            .query_map(params![p.id, PROFILE_MAPS], |r| {
                Ok(ProfileMap { id: r.get(0)?, name: r.get(1)?, plays: r.get(2)?, score: r.get(3)? })
            })?
            .collect::<rusqlite::Result<Vec<ProfileMap>>>()?;
        // the same order the map's Fastest Times list uses: time, then when it was set
        p.records = db.query_row(
            &format!(
                "SELECT COUNT(*) FROM records r JOIN maps m ON m.id = r.map_id \
                 WHERE r.account_id = ?1 AND {LISTED} AND NOT EXISTS (\
                 SELECT 1 FROM records o WHERE o.map_id = r.map_id \
                 AND (o.ticks < r.ticks OR (o.ticks = r.ticks AND o.at < r.at)))"
            ),
            [p.id],
            |r| r.get(0),
        )?;
        Ok(Some(p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    fn map(s: &Store, owner: i64, name: &str, visibility: &str, plays: i64) -> i64 {
        let db = s.db();
        db.execute(
            "INSERT INTO maps (owner_id, name, code, size, visibility, status, plays, created, updated) \
             VALUES (?1, ?2, 'code', 1, ?3, 'approved', ?4, 0, 0)",
            params![owner, name, visibility, plays],
        )
        .expect("insert map");
        db.last_insert_rowid()
    }

    #[test]
    fn game_numbers_are_added_to_the_totals() {
        let s = store();
        let id = raw_account(&s, "Ada");
        let game = MatchStats { games: 1, wins: 1, rounds_won: 2, kills: 3, deaths: 1, play_seconds: 60 };
        s.record_stats(id, &game).unwrap();
        s.record_stats(id, &game).unwrap();
        let p = s.profile("ADA").unwrap().unwrap();
        assert_eq!(p.name, "Ada");
        assert_eq!(p.stats, MatchStats { games: 2, wins: 2, rounds_won: 4, kills: 6, deaths: 2, play_seconds: 120 });
    }

    #[test]
    fn unknown_accounts_have_no_profile_or_stats() {
        let s = store();
        assert_eq!(s.record_stats(99, &MatchStats::default()), Err(Error::NotFound));
        assert!(s.profile("nobody").unwrap().is_none());
    }

    #[test]
    fn profile_lists_only_public_maps_and_counts_records() {
        let s = store();
        let ada = raw_account(&s, "Ada");
        let bo = raw_account(&s, "Bo");
        let listed = map(&s, ada, "Pit", "public", 7);
        let private = map(&s, ada, "Secret", "private", 99);
        map(&s, bo, "Bo's", "public", 1);
        s.record_time(ada, listed, 900).unwrap();
        s.record_time(bo, listed, 1000).unwrap();
        s.record_time(ada, private, 500).unwrap();
        s.db()
            .execute("INSERT INTO friendships (from_id, to_id, accepted, created) VALUES (?1, ?2, 1, 0)", params![ada, bo])
            .unwrap();

        let p = s.profile("ada").unwrap().unwrap();
        assert_eq!(p.published, 1);
        assert_eq!(p.maps, vec![ProfileMap { id: listed, name: "Pit".into(), plays: 7, score: 0 }]);
        assert_eq!(p.records, 1);
        assert_eq!(p.friends, 1);

        // Bo's slower time on the same map is not a record
        let bo_profile = s.profile("bo").unwrap().unwrap();
        assert_eq!(bo_profile.records, 0);
        assert_eq!(bo_profile.friends, 1);
    }
}
