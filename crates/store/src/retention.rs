//! Retention: reports and feedback are deleted 180 days after they were made,
//! their IP addresses are cleared after 30 days, and expired sanctions are
//! deleted 180 days after they ended. The clock is a parameter so the limits
//! can be tested at their edges.

use crate::{DAY, Result, Store};

/// How long reports and feedback are kept, and how long ended sanctions are kept.
pub const KEEP_DAYS: i64 = 180;
/// How long reports and feedback keep their IP addresses.
pub const KEEP_IP_DAYS: i64 = 30;

/// What one purge removed or cleared.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Purged {
    /// Reports deleted.
    pub reports: usize,
    /// Feedback deleted.
    pub feedback: usize,
    /// IP addresses cleared on reports and feedback.
    pub ips_cleared: usize,
    /// Suspensions and IP bans deleted.
    pub sanctions: usize,
}

impl Store {
    /// Apply the retention limits as of unix time `now`.
    pub fn purge(&self, now: i64) -> Result<Purged> {
        let keep_from = now - KEEP_DAYS * DAY;
        let ip_from = now - KEEP_IP_DAYS * DAY;
        let mut db = self.db();
        let tx = db.transaction()?;
        let reports = tx.execute("DELETE FROM reports WHERE created < ?1", [keep_from])?;
        let feedback = tx.execute("DELETE FROM feedback WHERE created < ?1", [keep_from])?;
        let ips_cleared = tx.execute(
            "UPDATE reports SET reporter_ip = '', player_ip = NULL \
             WHERE created < ?1 AND (reporter_ip <> '' OR player_ip IS NOT NULL)",
            [ip_from],
        )? + tx.execute("UPDATE feedback SET author_ip = '' WHERE created < ?1 AND author_ip <> ''", [ip_from])?;
        let sanctions = tx.execute("DELETE FROM suspensions WHERE until <= ?1", [keep_from])?
            + tx.execute("DELETE FROM ip_bans WHERE until <= ?1", [keep_from])?;
        tx.commit()?;
        Ok(Purged { reports, feedback, ips_cleared, sanctions })
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::{raw_account, store};
    use crate::{NewReport, ReportCategory, ReportChat, ReportKind, Reporter, Store};
    use crate::retention::KEEP_DAYS;
    use crate::DAY;
    use rusqlite::params;

    const NOW: i64 = 2_000_000_000;

    fn report_at(s: &Store, created: i64, ip: &str) -> i64 {
        let id = s
            .create_report(&NewReport {
                kind: ReportKind::Player,
                category: ReportCategory::Spam,
                reason: "x".into(),
                reporter: Reporter { account: None, name: "g".into(), ip: ip.into() },
                room_code: String::new(),
                room_name: String::new(),
                player: Some(crate::ReportedPlayer { id: 1, name: "p".into(), account: None, ip: ip.into() }),
                map: None,
                chat: vec![ReportChat { name: "p".into(), text: "t".into(), at: 0 }],
            })
            .unwrap();
        s.db().execute("UPDATE reports SET created = ?1 WHERE id = ?2", params![created, id]).unwrap();
        id
    }

    fn feedback_at(s: &Store, created: i64) -> i64 {
        let id = s
            .create_feedback(&crate::NewFeedback {
                kind: crate::FeedbackKind::Bug,
                message: "broken".into(),
                screen: String::new(),
                context: String::new(),
                author_account: None,
                author_name: "g".into(),
                author_ip: "10.1.1.1".into(),
            })
            .unwrap();
        s.db().execute("UPDATE feedback SET created = ?1 WHERE id = ?2", params![created, id]).unwrap();
        id
    }

    #[test]
    fn reports_and_feedback_are_deleted_after_180_days() {
        let s = store();
        let keep = report_at(&s, NOW - KEEP_DAYS * DAY, "10.0.0.1");
        let gone = report_at(&s, NOW - KEEP_DAYS * DAY - 1, "10.0.0.1");
        let fb_keep = feedback_at(&s, NOW - KEEP_DAYS * DAY);
        let fb_gone = feedback_at(&s, NOW - KEEP_DAYS * DAY - 1);
        let purged = s.purge(NOW).unwrap();
        assert_eq!((purged.reports, purged.feedback), (1, 1));
        assert!(s.report(keep).unwrap().is_some());
        assert!(s.report(gone).unwrap().is_none());
        assert!(s.list_feedback(None, None, None, 10).unwrap().iter().any(|f| f.id == fb_keep));
        assert!(!s.list_feedback(None, None, None, 10).unwrap().iter().any(|f| f.id == fb_gone));
    }

    #[test]
    fn ip_addresses_are_cleared_after_30_days_and_the_text_is_kept() {
        let s = store();
        let young = report_at(&s, NOW - 30 * DAY + 1, "10.0.0.2");
        let old = report_at(&s, NOW - 30 * DAY - 1, "10.0.0.2");
        let fb_old = feedback_at(&s, NOW - 30 * DAY - 1);
        let purged = s.purge(NOW).unwrap();
        assert_eq!(purged.ips_cleared, 2);
        assert_eq!(purged.reports + purged.feedback, 0);
        let kept = s.report(old).unwrap().unwrap();
        assert_eq!(kept.reporter.ip, "");
        assert_eq!(kept.player.unwrap().ip, "");
        assert_eq!(kept.reason, "x");
        assert_eq!(s.report(young).unwrap().unwrap().reporter.ip, "10.0.0.2");
        let fb = s.list_feedback(None, None, None, 10).unwrap();
        assert_eq!(fb.iter().find(|f| f.id == fb_old).unwrap().author_ip, "");
        assert_eq!(s.purge(NOW).unwrap().ips_cleared, 0, "clearing is idempotent");
    }

    #[test]
    fn ended_sanctions_are_deleted_180_days_after_they_end() {
        let s = store();
        let acc = raw_account(&s, "Sanctioned");
        let insert = |until: i64| {
            s.db()
                .execute("INSERT INTO suspensions (account_id, reason, created, until) VALUES (?1, 'x', 0, ?2)", params![acc, until])
                .unwrap();
            s.db().execute("INSERT INTO ip_bans (ip, reason, created, until) VALUES ('10.0.0.3', 'x', 0, ?1)", [until]).unwrap();
        };
        insert(NOW - KEEP_DAYS * DAY);
        insert(NOW - KEEP_DAYS * DAY + 1);
        insert(i64::MAX);
        let purged = s.purge(NOW).unwrap();
        assert_eq!(purged.sanctions, 2);
        let count = |sql: &str| -> i64 { s.db().query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM suspensions"), 2);
        assert_eq!(count("SELECT COUNT(*) FROM ip_bans"), 2);
    }
}
