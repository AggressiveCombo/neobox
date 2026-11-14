//! Experience: each account's total, and the farming limits. Every grant is
//! logged for a day so the hourly and daily caps can be checked; a grant is
//! cut to what still fits under both.

use crate::{Result, Store, now};
use rusqlite::{OptionalExtension, params};

/// Most experience an account gains in any rolling hour.
pub const XP_PER_HOUR: i64 = 2000;
/// Most experience an account gains in any rolling 24 hours.
pub const XP_PER_DAY: i64 = 12000;

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;

/// Which cap cut a grant short.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XpLimit {
    /// The hourly cap.
    Short,
    /// The daily cap.
    Long,
}

/// Result of [`Store::grant_xp`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XpGrant {
    /// Experience actually added.
    pub granted: u32,
    /// The account's total after the grant.
    pub total: u64,
    /// Set when a cap cut the grant (`granted` < asked).
    pub limit: Option<XpLimit>,
}

impl Store {
    /// The account's experience total (0 for an unknown account).
    pub fn account_xp(&self, account: i64) -> Result<u64> {
        let xp: Option<i64> =
            self.db().query_row("SELECT xp FROM accounts WHERE id = ?1", params![account], |r| r.get(0)).optional()?;
        Ok(xp.unwrap_or(0).max(0) as u64)
    }

    /// Add up to `amount` experience to the account, within the hourly and
    /// daily caps.
    pub fn grant_xp(&self, account: i64, amount: u32) -> Result<XpGrant> {
        self.grant_xp_at(account, amount, now())
    }

    fn grant_xp_at(&self, account: i64, amount: u32, at: i64) -> Result<XpGrant> {
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM xp_grants WHERE account_id = ?1 AND at <= ?2", params![account, at - DAY])?;
        let sum = |since: i64| -> rusqlite::Result<i64> {
            tx.query_row(
                "SELECT COALESCE(SUM(amount), 0) FROM xp_grants WHERE account_id = ?1 AND at > ?2",
                params![account, since],
                |r| r.get(0),
            )
        };
        let room_hour = (XP_PER_HOUR - sum(at - HOUR)?).max(0);
        let room_day = (XP_PER_DAY - sum(at - DAY)?).max(0);
        let asked = amount as i64;
        let granted = asked.min(room_hour).min(room_day);
        let limit = if granted >= asked {
            None
        } else if room_day <= room_hour {
            Some(XpLimit::Long)
        } else {
            Some(XpLimit::Short)
        };
        if granted > 0 {
            tx.execute("INSERT INTO xp_grants (account_id, amount, at) VALUES (?1, ?2, ?3)", params![account, granted, at])?;
            tx.execute("UPDATE accounts SET xp = xp + ?2 WHERE id = ?1", params![account, granted])?;
        }
        let total: Option<i64> =
            tx.query_row("SELECT xp FROM accounts WHERE id = ?1", params![account], |r| r.get(0)).optional()?;
        tx.commit()?;
        Ok(XpGrant { granted: granted as u32, total: total.unwrap_or(0).max(0) as u64, limit })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    #[test]
    fn grants_add_up() {
        let s = store();
        let a = raw_account(&s, "alice");
        assert_eq!(s.account_xp(a).unwrap(), 0);
        let g = s.grant_xp_at(a, 100, 1_000_000).unwrap();
        assert_eq!(g, XpGrant { granted: 100, total: 100, limit: None });
        let g = s.grant_xp_at(a, 75, 1_000_010).unwrap();
        assert_eq!(g.total, 175);
        assert_eq!(s.account_xp(a).unwrap(), 175);
    }

    #[test]
    fn hourly_cap_cuts_and_then_frees_up() {
        let s = store();
        let a = raw_account(&s, "farmer");
        let t = 5_000_000;
        assert_eq!(s.grant_xp_at(a, 1900, t).unwrap().granted, 1900);
        let g = s.grant_xp_at(a, 400, t + 60).unwrap();
        assert_eq!(g, XpGrant { granted: 100, total: 2000, limit: Some(XpLimit::Short) });
        let g = s.grant_xp_at(a, 50, t + 120).unwrap();
        assert_eq!(g, XpGrant { granted: 0, total: 2000, limit: Some(XpLimit::Short) });
        // an hour after the first grant its share is free again
        assert_eq!(s.grant_xp_at(a, 400, t + HOUR + 1).unwrap().granted, 400);
    }

    #[test]
    fn daily_cap_applies_across_hours() {
        let s = store();
        let a = raw_account(&s, "grinder");
        let t = 9_000_000;
        for h in 0..6 {
            assert_eq!(s.grant_xp_at(a, 2000, t + h * HOUR).unwrap().granted, 2000);
        }
        let g = s.grant_xp_at(a, 2000, t + 6 * HOUR).unwrap();
        assert_eq!(g, XpGrant { granted: 0, total: 12000, limit: Some(XpLimit::Long) });
        // the first grant leaves the 24-hour window
        assert_eq!(s.grant_xp_at(a, 2000, t + DAY + 1).unwrap().granted, 2000);
    }

    #[test]
    fn accounts_are_independent() {
        let s = store();
        let a = raw_account(&s, "one");
        let b = raw_account(&s, "two");
        s.grant_xp_at(a, 2000, 100).unwrap();
        assert_eq!(s.grant_xp_at(b, 300, 101).unwrap().granted, 300);
        assert_eq!(s.account_xp(b).unwrap(), 300);
    }
}
