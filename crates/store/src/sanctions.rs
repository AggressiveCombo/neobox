//! Sanctions: account suspensions and global IP bans. Each one ends at a time,
//! or never (permanent). Suspending an account also signs it out everywhere.

use crate::{DAY, Error, Result, Store, now};
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::net::IpAddr;

/// `until` stored for a permanent sanction.
const PERMANENT: i64 = i64::MAX;
/// Longest timed sanction, in days.
pub const MAX_SANCTION_DAYS: i64 = 3650;
/// Longest sanction reason, in characters.
const MAX_REASON_CHARS: usize = 500;

/// A sanction in force. `until` is `None` when it is permanent.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Sanction {
    pub until: Option<i64>,
    pub reason: String,
}

/// An active account suspension, for the admin page.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SuspensionEntry {
    pub id: i64,
    pub account_id: i64,
    pub name: String,
    pub reason: String,
    pub created: i64,
    pub until: Option<i64>,
}

/// An active IP ban, for the admin page.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IpBanEntry {
    pub id: i64,
    pub ip: String,
    pub reason: String,
    pub created: i64,
    pub until: Option<i64>,
}

/// Every sanction in force.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Sanctions {
    pub suspensions: Vec<SuspensionEntry>,
    pub ip_bans: Vec<IpBanEntry>,
}

/// "permanently", or the end time as UTC, for the player-facing messages.
pub fn until_text(until: Option<i64>) -> String {
    match until {
        None => "permanently".to_owned(),
        Some(t) => utc_text(t),
    }
}

/// `YYYY-MM-DD HH:MM UTC` for a unix time (proleptic Gregorian calendar).
fn utc_text(t: i64) -> String {
    let days = t.div_euclid(DAY) + 719_468;
    let secs = t.rem_euclid(DAY);
    let era = days.div_euclid(146_097);
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02} UTC", secs / 3600, secs % 3600 / 60)
}

fn end_time(days: Option<i64>, from: i64) -> Result<i64> {
    match days {
        None => Ok(PERMANENT),
        Some(d) if (1..=MAX_SANCTION_DAYS).contains(&d) => Ok(from + d * DAY),
        Some(_) => Err(Error::Invalid("Timed sanctions last 1 to 3650 days")),
    }
}

fn reason_text(reason: &str) -> Result<&str> {
    let reason = reason.trim();
    if (1..=MAX_REASON_CHARS).contains(&reason.chars().count()) {
        Ok(reason)
    } else {
        Err(Error::Invalid("Reasons are 1 to 500 characters"))
    }
}

fn to_option(until: i64) -> Option<i64> {
    (until != PERMANENT).then_some(until)
}

/// The canonical text of an IP address, so `2001:DB8::1` and `2001:db8::1` match.
fn canonical_ip(ip: &str) -> Option<String> {
    ip.trim().parse::<IpAddr>().ok().map(|a| a.to_string())
}

fn sanction_row(r: &Row<'_>) -> rusqlite::Result<Sanction> {
    Ok(Sanction { until: to_option(r.get(0)?), reason: r.get(1)? })
}

/// The suspension in force for the account that lasts longest, if any.
pub(crate) fn active_suspension(db: &Connection, account: i64, t: i64) -> Result<Option<Sanction>> {
    Ok(db
        .query_row(
            "SELECT until, reason FROM suspensions WHERE account_id = ?1 AND until > ?2 ORDER BY until DESC LIMIT 1",
            params![account, t],
            sanction_row,
        )
        .optional()?)
}

impl Store {
    /// Suspend an account for `days` days, or for good when `days` is `None`.
    /// Its sessions are signed out at once.
    pub fn suspend(&self, account: i64, days: Option<i64>, reason: &str) -> Result<()> {
        let reason = reason_text(reason)?;
        let t = now();
        let until = end_time(days, t)?;
        let mut db = self.db();
        let tx = db.transaction()?;
        let exists = tx
            .query_row("SELECT 1 FROM accounts WHERE id = ?1", [account], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Err(Error::NotFound);
        }
        tx.execute(
            "INSERT INTO suspensions (account_id, reason, created, until) VALUES (?1, ?2, ?3, ?4)",
            params![account, reason, t, until],
        )?;
        tx.execute("DELETE FROM sessions WHERE account_id = ?1", [account])?;
        tx.commit()?;
        Ok(())
    }

    /// End every suspension in force for the account now.
    pub fn lift_suspension(&self, account: i64) -> Result<()> {
        let t = now();
        let n = self
            .db()
            .execute("UPDATE suspensions SET until = ?1 WHERE account_id = ?2 AND until > ?1", params![t, account])?;
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }

    /// The suspension in force for the account, if any.
    pub fn active_suspension(&self, account: i64) -> Result<Option<Sanction>> {
        active_suspension(&self.db(), account, now())
    }

    /// Ban an IP address for `days` days, or for good when `days` is `None`.
    pub fn ban_ip(&self, ip: &str, days: Option<i64>, reason: &str) -> Result<()> {
        let ip = canonical_ip(ip).ok_or(Error::Invalid("That is not an IP address"))?;
        let reason = reason_text(reason)?;
        let t = now();
        let until = end_time(days, t)?;
        self.db().execute(
            "INSERT INTO ip_bans (ip, reason, created, until) VALUES (?1, ?2, ?3, ?4)",
            params![ip, reason, t, until],
        )?;
        Ok(())
    }

    /// End every ban in force for the IP address now.
    pub fn lift_ip_ban(&self, ip: &str) -> Result<()> {
        let ip = canonical_ip(ip).ok_or(Error::NotFound)?;
        let t = now();
        let n = self.db().execute("UPDATE ip_bans SET until = ?1 WHERE ip = ?2 AND until > ?1", params![t, ip])?;
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }

    /// The ban in force for the IP address, if any.
    pub fn ip_ban(&self, ip: &str) -> Result<Option<Sanction>> {
        let Some(ip) = canonical_ip(ip) else { return Ok(None) };
        Ok(self
            .db()
            .query_row(
                "SELECT until, reason FROM ip_bans WHERE ip = ?1 AND until > ?2 ORDER BY until DESC LIMIT 1",
                params![ip, now()],
                sanction_row,
            )
            .optional()?)
    }

    /// Every suspension and IP ban in force, newest first. Admin page only.
    pub fn sanctions(&self) -> Result<Sanctions> {
        let t = now();
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT s.id, s.account_id, a.name, s.reason, s.created, s.until FROM suspensions s \
             JOIN accounts a ON a.id = s.account_id WHERE s.until > ?1 ORDER BY s.created DESC, s.id DESC",
        )?;
        let suspensions = stmt
            .query_map([t], |r| {
                Ok(SuspensionEntry {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    name: r.get(2)?,
                    reason: r.get(3)?,
                    created: r.get(4)?,
                    until: to_option(r.get(5)?),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = db.prepare(
            "SELECT id, ip, reason, created, until FROM ip_bans WHERE until > ?1 ORDER BY created DESC, id DESC",
        )?;
        let ip_bans = stmt
            .query_map([t], |r| {
                Ok(IpBanEntry {
                    id: r.get(0)?,
                    ip: r.get(1)?,
                    reason: r.get(2)?,
                    created: r.get(3)?,
                    until: to_option(r.get(4)?),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Sanctions { suspensions, ip_bans })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    #[test]
    fn until_text_is_utc_calendar_time() {
        assert_eq!(until_text(None), "permanently");
        assert_eq!(until_text(Some(0)), "1970-01-01 00:00 UTC");
        assert_eq!(until_text(Some(951_782_400)), "2000-02-29 00:00 UTC");
        assert_eq!(until_text(Some(1_767_225_599)), "2025-12-31 23:59 UTC");
    }

    #[test]
    fn suspension_revokes_sessions_and_blocks_until_it_ends() {
        let s = store();
        let id = raw_account(&s, "Sam");
        let token = s.create_session(id).unwrap();
        s.suspend(id, Some(2), "  spamming  ").unwrap();
        assert_eq!(s.session_account(&token).unwrap(), None);
        let sanction = s.active_suspension(id).unwrap().unwrap();
        assert_eq!(sanction.reason, "spamming");
        assert!(sanction.until.unwrap() > now() + DAY);
        s.lift_suspension(id).unwrap();
        assert_eq!(s.active_suspension(id).unwrap(), None);
        assert_eq!(s.lift_suspension(id), Err(Error::NotFound));
    }

    #[test]
    fn expired_suspensions_do_not_apply() {
        let s = store();
        let id = raw_account(&s, "Old");
        s.db()
            .execute(
                "INSERT INTO suspensions (account_id, reason, created, until) VALUES (?1, 'x', 0, ?2)",
                params![id, now() - 1],
            )
            .unwrap();
        assert_eq!(s.active_suspension(id).unwrap(), None);
        assert!(s.sanctions().unwrap().suspensions.is_empty());
    }

    #[test]
    fn permanent_suspensions_have_no_end() {
        let s = store();
        let id = raw_account(&s, "Gone");
        s.suspend(id, None, "cheating").unwrap();
        assert_eq!(s.active_suspension(id).unwrap().unwrap().until, None);
        assert_eq!(s.sanctions().unwrap().suspensions[0].until, None);
    }

    #[test]
    fn suspension_needs_an_account_a_reason_and_a_sane_length() {
        let s = store();
        let id = raw_account(&s, "Pat");
        assert_eq!(s.suspend(999, Some(1), "x"), Err(Error::NotFound));
        assert!(matches!(s.suspend(id, Some(1), "  "), Err(Error::Invalid(_))));
        assert!(matches!(s.suspend(id, Some(0), "x"), Err(Error::Invalid(_))));
        assert!(matches!(s.suspend(id, Some(MAX_SANCTION_DAYS + 1), "x"), Err(Error::Invalid(_))));
    }

    #[test]
    fn ip_bans_match_the_canonical_address() {
        let s = store();
        s.ban_ip("2001:DB8:0::1", Some(1), "abuse").unwrap();
        let ban = s.ip_ban("2001:db8::1").unwrap().unwrap();
        assert_eq!(ban.reason, "abuse");
        assert!(s.ip_ban("10.0.0.1").unwrap().is_none());
        assert_eq!(s.sanctions().unwrap().ip_bans[0].ip, "2001:db8::1");
        s.lift_ip_ban("2001:db8::1").unwrap();
        assert!(s.ip_ban("2001:db8::1").unwrap().is_none());
        assert_eq!(s.lift_ip_ban("2001:db8::1"), Err(Error::NotFound));
        assert!(matches!(s.ban_ip("not an ip", None, "x"), Err(Error::Invalid(_))));
    }

    #[test]
    fn permanent_ip_bans_never_expire() {
        let s = store();
        s.ban_ip("10.0.0.2", None, "botnet").unwrap();
        let ban = s.ip_ban("10.0.0.2").unwrap().unwrap();
        assert_eq!(ban.until, None);
    }
}
