//! Fastest Times: each account's best finish time on each library map, and the
//! ranked list a map's window shows. Only the best time is kept; a slower or
//! equal finish leaves the stored row alone.

use crate::library::{meta, viewable};
use crate::{Error, Result, Store, now};
use rusqlite::params;

/// Most rows a map's Fastest Times list returns. The window shows a short
/// table, so the query stops at the top fifty.
pub const MAX_RECORDS: usize = 50;

/// One row of a map's Fastest Times list.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Record {
    /// 1 for the fastest time.
    pub rank: u32,
    /// The account's display name.
    pub name: String,
    /// Finish time in ticks (30 per second).
    pub ticks: i64,
    /// When the time was set, in unix seconds.
    pub date: i64,
}

impl Store {
    /// Record a finish time for the account on the map. It replaces the stored
    /// time only when it is faster. Returns whether it did, which makes it a
    /// new personal best.
    pub fn record_time(&self, account: i64, map: i64, ticks: i64) -> Result<bool> {
        self.record_time_at(account, map, ticks, now())
    }

    fn record_time_at(&self, account: i64, map: i64, ticks: i64, at: i64) -> Result<bool> {
        if ticks <= 0 {
            return Err(Error::Invalid("A finish time must be positive"));
        }
        let changed = self.db().execute(
            "INSERT INTO records (map_id, account_id, ticks, at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (map_id, account_id) DO UPDATE SET ticks = excluded.ticks, at = excluded.at
             WHERE excluded.ticks < records.ticks",
            params![map, account, ticks, at],
        )?;
        Ok(changed > 0)
    }

    /// The top [`MAX_RECORDS`] times on a map, fastest first, with equal times
    /// ordered by who got there first. `NotFound` if the viewer may not open the map.
    pub fn records(&self, map: i64, viewer: Option<i64>, admin: bool) -> Result<Vec<Record>> {
        let db = self.db();
        let (owner, status, visibility) = meta(&db, map)?;
        if !viewable(owner, status, visibility, viewer, admin) {
            return Err(Error::NotFound);
        }
        let mut stmt = db.prepare(
            "SELECT a.name, r.ticks, r.at FROM records r JOIN accounts a ON a.id = r.account_id
             WHERE r.map_id = ?1 ORDER BY r.ticks ASC, r.at ASC, r.account_id ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![map, MAX_RECORDS as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?;
        let mut out = Vec::new();
        for (i, row) in rows.enumerate() {
            let (name, ticks, date) = row?;
            out.push(Record { rank: i as u32 + 1, name, ticks, date });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Visibility;
    use crate::test_support::{raw_account, store};

    fn live_public(s: &Store, owner: i64, name: &str) -> i64 {
        let id = s.upload(owner, name, "code", Visibility::Public, "").unwrap();
        s.moderate(id, crate::Verdict::Approve).unwrap();
        id
    }

    #[test]
    fn only_the_best_time_is_kept() {
        let s = store();
        let m = live_public(&s, raw_account(&s, "Owner"), "race");
        let a = raw_account(&s, "alice");
        assert!(s.record_time_at(a, m, 300, 1000).unwrap(), "the first time is a best");
        assert!(s.record_time_at(a, m, 200, 2000).unwrap());
        assert!(!s.record_time_at(a, m, 400, 3000).unwrap(), "a slower time is not");
        assert!(!s.record_time_at(a, m, 200, 4000).unwrap(), "an equal time is not");
        let list = s.records(m, None, true).unwrap();
        assert_eq!(list, vec![Record { rank: 1, name: "alice".into(), ticks: 200, date: 2000 }]);
    }

    #[test]
    fn ranks_by_time() {
        let s = store();
        let m = live_public(&s, raw_account(&s, "Owner"), "race");
        let a = raw_account(&s, "alice");
        let b = raw_account(&s, "bob");
        let c = raw_account(&s, "carol");
        s.record_time_at(b, m, 250, 10).unwrap();
        s.record_time_at(c, m, 900, 20).unwrap();
        s.record_time_at(a, m, 100, 30).unwrap();
        let names: Vec<(u32, String, i64)> =
            s.records(m, None, true).unwrap().into_iter().map(|r| (r.rank, r.name, r.ticks)).collect();
        assert_eq!(
            names,
            vec![(1, "alice".into(), 100), (2, "bob".into(), 250), (3, "carol".into(), 900)]
        );
    }

    #[test]
    fn a_tie_goes_to_the_earlier_date() {
        let s = store();
        let m = live_public(&s, raw_account(&s, "Owner"), "race");
        let late = raw_account(&s, "late");
        let early = raw_account(&s, "early");
        s.record_time_at(late, m, 150, 500).unwrap();
        s.record_time_at(early, m, 150, 400).unwrap();
        let list = s.records(m, None, true).unwrap();
        assert_eq!(list[0].name, "early");
        assert_eq!(list[1].name, "late");
    }

    #[test]
    fn the_list_is_capped() {
        let s = store();
        let m = live_public(&s, raw_account(&s, "Owner"), "race");
        for i in 0..(MAX_RECORDS as i64 + 5) {
            let a = raw_account(&s, &format!("racer{i}"));
            s.record_time_at(a, m, 100 + i, i).unwrap();
        }
        let list = s.records(m, None, true).unwrap();
        assert_eq!(list.len(), MAX_RECORDS);
        assert_eq!(list.last().unwrap().rank, MAX_RECORDS as u32);
    }

    #[test]
    fn non_positive_times_are_refused() {
        let s = store();
        let m = live_public(&s, raw_account(&s, "Owner"), "race");
        let a = raw_account(&s, "alice");
        assert!(matches!(s.record_time(a, m, 0), Err(Error::Invalid(_))));
        assert!(matches!(s.record_time(a, m, -5), Err(Error::Invalid(_))));
        assert!(s.records(m, None, true).unwrap().is_empty());
    }

    #[test]
    fn private_maps_are_hidden_from_strangers() {
        let s = store();
        let owner = raw_account(&s, "Owner");
        let m = s.upload(owner, "secret", "code", Visibility::Private, "").unwrap();
        let stranger = raw_account(&s, "stranger");
        assert!(matches!(s.records(m, Some(stranger), false), Err(Error::NotFound)));
        assert!(matches!(s.records(m, None, false), Err(Error::NotFound)));
        assert!(s.records(m, Some(owner), false).unwrap().is_empty());
        assert!(s.records(m, Some(stranger), true).unwrap().is_empty());
    }
}
