//! Reports: a player or a map reported by someone else, kept with the evidence
//! the server captured when the report was made (the reported player's identity,
//! the reporter's identity and the room's recent chat). Admins review them.

use crate::{Error, Result, Store, now};
use rusqlite::{OptionalExtension, Row, params};

/// Longest reason, in characters.
pub const MAX_REASON_CHARS: usize = 500;
/// Chat lines kept as evidence with a report.
pub const MAX_REPORT_CHAT: usize = 30;

const COLUMNS: &str = "id, kind, status, reason, reporter_account, reporter_name, reporter_ip, room_code, room_name, \
     player_id, player_name, player_account, player_ip, map_id, map_name, map_author, chat, created, resolved, category";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportKind {
    Player,
    Map,
}

impl ReportKind {
    fn as_str(self) -> &'static str {
        match self {
            ReportKind::Player => "player",
            ReportKind::Map => "map",
        }
    }

    fn parse(s: &str) -> Option<ReportKind> {
        match s {
            "player" => Some(ReportKind::Player),
            "map" => Some(ReportKind::Map),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportStatus {
    Open,
    Resolved,
    Dismissed,
}

impl ReportStatus {
    fn as_str(self) -> &'static str {
        match self {
            ReportStatus::Open => "open",
            ReportStatus::Resolved => "resolved",
            ReportStatus::Dismissed => "dismissed",
        }
    }

    pub fn parse(s: &str) -> Option<ReportStatus> {
        match s {
            "open" => Some(ReportStatus::Open),
            "resolved" => Some(ReportStatus::Resolved),
            "dismissed" => Some(ReportStatus::Dismissed),
            _ => None,
        }
    }
}

/// Why the report was filed. Illegal content sorts first in the admin list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportCategory {
    Illegal,
    Harassment,
    Cheating,
    Spam,
    Inappropriate,
    Other,
}

impl ReportCategory {
    fn as_str(self) -> &'static str {
        match self {
            ReportCategory::Illegal => "illegal",
            ReportCategory::Harassment => "harassment",
            ReportCategory::Cheating => "cheating",
            ReportCategory::Spam => "spam",
            ReportCategory::Inappropriate => "inappropriate",
            ReportCategory::Other => "other",
        }
    }

    /// The category named by a client key, if any.
    pub fn parse(s: &str) -> Option<ReportCategory> {
        match s {
            "illegal" => Some(ReportCategory::Illegal),
            "harassment" => Some(ReportCategory::Harassment),
            "cheating" => Some(ReportCategory::Cheating),
            "spam" => Some(ReportCategory::Spam),
            "inappropriate" => Some(ReportCategory::Inappropriate),
            "other" => Some(ReportCategory::Other),
            _ => None,
        }
    }
}

/// Who filed the report. Guests have no account.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Reporter {
    pub account: Option<i64>,
    pub name: String,
    pub ip: String,
}

/// The reported player as they were in the room when reported.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReportedPlayer {
    /// The player's id in the room.
    pub id: i64,
    pub name: String,
    pub account: Option<i64>,
    pub ip: String,
}

/// The reported map. `id` is the library id, or `None` for a built-in map.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReportedMap {
    pub id: Option<i64>,
    pub name: String,
    pub author: String,
}

/// One line of room chat kept as evidence. `at` is Unix seconds.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReportChat {
    pub name: String,
    pub text: String,
    pub at: i64,
}

/// A report to file. A player report needs `player`, a map report needs `map`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewReport {
    pub kind: ReportKind,
    pub category: ReportCategory,
    pub reason: String,
    pub reporter: Reporter,
    /// Empty when the report is not made from inside a room.
    pub room_code: String,
    pub room_name: String,
    pub player: Option<ReportedPlayer>,
    pub map: Option<ReportedMap>,
    pub chat: Vec<ReportChat>,
}

/// A stored report.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Report {
    pub id: i64,
    pub kind: ReportKind,
    pub status: ReportStatus,
    pub category: ReportCategory,
    pub reason: String,
    pub reporter: Reporter,
    pub room_code: String,
    pub room_name: String,
    pub player: Option<ReportedPlayer>,
    pub map: Option<ReportedMap>,
    pub chat: Vec<ReportChat>,
    /// Unix seconds.
    pub created: i64,
    /// Unix seconds when it was resolved or dismissed; 0 while open.
    pub resolved: i64,
}

fn report_row(r: &Row<'_>) -> rusqlite::Result<Report> {
    let conv = |idx: usize, e: Box<dyn std::error::Error + Send + Sync>| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, e)
    };
    let kind_text: String = r.get(1)?;
    let kind = ReportKind::parse(&kind_text).ok_or_else(|| conv(1, format!("unknown kind {kind_text}").into()))?;
    let status_text: String = r.get(2)?;
    let status = ReportStatus::parse(&status_text).ok_or_else(|| conv(2, format!("unknown status {status_text}").into()))?;
    let category_text: String = r.get(19)?;
    let category =
        ReportCategory::parse(&category_text).ok_or_else(|| conv(19, format!("unknown category {category_text}").into()))?;
    let chat_text: String = r.get(16)?;
    let chat = serde_json::from_str(&chat_text).map_err(|e| conv(16, Box::new(e)))?;
    let player_name: Option<String> = r.get(10)?;
    let player = match player_name {
        Some(name) => Some(ReportedPlayer {
            id: r.get(9)?,
            name,
            account: r.get(11)?,
            ip: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
        }),
        None => None,
    };
    let map_name: Option<String> = r.get(14)?;
    let map = match map_name {
        Some(name) => Some(ReportedMap {
            id: r.get(13)?,
            name,
            author: r.get::<_, Option<String>>(15)?.unwrap_or_default(),
        }),
        None => None,
    };
    Ok(Report {
        id: r.get(0)?,
        kind,
        status,
        category,
        reason: r.get(3)?,
        reporter: Reporter { account: r.get(4)?, name: r.get(5)?, ip: r.get(6)? },
        room_code: r.get(7)?,
        room_name: r.get(8)?,
        player,
        map,
        chat,
        created: r.get(17)?,
        resolved: r.get(18)?,
    })
}

impl Store {
    /// File a report and return its id. The reason is 1 to 500 characters once
    /// trimmed; a player report needs the player and a map report the map.
    pub fn create_report(&self, report: &NewReport) -> Result<i64> {
        let reason = report.reason.trim();
        if !(1..=MAX_REASON_CHARS).contains(&reason.chars().count()) {
            return Err(Error::Invalid("Reasons are 1 to 500 characters"));
        }
        let named = match report.kind {
            ReportKind::Player => report.player.is_some(),
            ReportKind::Map => report.map.is_some(),
        };
        if !named {
            return Err(Error::Invalid("The report does not name what it reports"));
        }
        let chat_json = serde_json::to_string(&report.chat.iter().rev().take(MAX_REPORT_CHAT).rev().collect::<Vec<_>>())
            .map_err(|e| Error::Internal(e.to_string()))?;
        let (player_id, player_name, player_account, player_ip) = match &report.player {
            Some(p) => (Some(p.id), Some(p.name.as_str()), p.account, Some(p.ip.as_str())),
            None => (None, None, None, None),
        };
        let (map_id, map_name, map_author) = match &report.map {
            Some(m) => (m.id, Some(m.name.as_str()), Some(m.author.as_str())),
            None => (None, None, None),
        };
        let db = self.db();
        db.execute(
            "INSERT INTO reports (kind, status, reason, reporter_account, reporter_name, reporter_ip, room_code, room_name, \
             player_id, player_name, player_account, player_ip, map_id, map_name, map_author, chat, created, resolved, category) \
             VALUES (?1, 'open', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, ?17)",
            params![
                report.kind.as_str(),
                reason,
                report.reporter.account,
                report.reporter.name,
                report.reporter.ip,
                report.room_code,
                report.room_name,
                player_id,
                player_name,
                player_account,
                player_ip,
                map_id,
                map_name,
                map_author,
                chat_json,
                now(),
                report.category.as_str(),
            ],
        )?;
        Ok(db.last_insert_rowid())
    }

    /// One page of reports, optionally only those with `status`. Illegal
    /// content comes first, then newest first.
    pub fn reports(&self, status: Option<ReportStatus>, offset: usize, limit: usize) -> Result<Vec<Report>> {
        let db = self.db();
        let mut stmt = db.prepare(&format!(
            "SELECT {COLUMNS} FROM reports WHERE (?1 IS NULL OR status = ?1) \
             ORDER BY CASE WHEN category = 'illegal' THEN 0 ELSE 1 END, id DESC LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = stmt.query_map(
            params![status.map(ReportStatus::as_str), limit as i64, offset as i64],
            report_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// One report by id.
    pub fn report(&self, id: i64) -> Result<Option<Report>> {
        Ok(self
            .db()
            .query_row(&format!("SELECT {COLUMNS} FROM reports WHERE id = ?1"), [id], report_row)
            .optional()?)
    }

    /// Mark a report resolved or dismissed (or open again). Stamps the time
    /// unless it is reopened.
    pub fn set_report_status(&self, id: i64, status: ReportStatus) -> Result<()> {
        let resolved = if status == ReportStatus::Open { 0 } else { now() };
        let n = self
            .db()
            .execute("UPDATE reports SET status = ?1, resolved = ?2 WHERE id = ?3", params![status.as_str(), resolved, id])?;
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }

    /// Delete a report.
    pub fn delete_report(&self, id: i64) -> Result<()> {
        let n = self.db().execute("DELETE FROM reports WHERE id = ?1", [id])?;
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    fn player_report(reason: &str) -> NewReport {
        NewReport {
            kind: ReportKind::Player,
            category: ReportCategory::Other,
            reason: reason.to_owned(),
            reporter: Reporter { account: None, name: "guest".into(), ip: "10.0.0.1".into() },
            room_code: "ABCD".into(),
            room_name: "Room".into(),
            player: Some(ReportedPlayer { id: 3, name: "cheat".into(), account: Some(7), ip: "10.0.0.2".into() }),
            map: None,
            chat: vec![ReportChat { name: "cheat".into(), text: "hi".into(), at: 5 }],
        }
    }

    #[test]
    fn player_report_round_trips_with_evidence() {
        let s = store();
        let id = s.create_report(&player_report("  spam  ")).unwrap();
        let r = s.report(id).unwrap().unwrap();
        assert_eq!((r.kind, r.status, r.reason.as_str()), (ReportKind::Player, ReportStatus::Open, "spam"));
        assert_eq!(r.reporter, Reporter { account: None, name: "guest".into(), ip: "10.0.0.1".into() });
        assert_eq!(r.player.unwrap().name, "cheat");
        assert!(r.map.is_none());
        assert_eq!(r.chat, vec![ReportChat { name: "cheat".into(), text: "hi".into(), at: 5 }]);
        assert_eq!(r.resolved, 0);
    }

    #[test]
    fn map_report_keeps_built_in_maps_without_an_id() {
        let s = store();
        let r = NewReport {
            kind: ReportKind::Map,
            player: None,
            map: Some(ReportedMap { id: None, name: "Arena".into(), author: String::new() }),
            ..player_report("broken")
        };
        let id = s.create_report(&r).unwrap();
        let got = s.report(id).unwrap().unwrap();
        assert_eq!(got.map, Some(ReportedMap { id: None, name: "Arena".into(), author: String::new() }));
        assert!(got.player.is_none());
    }

    #[test]
    fn invalid_reports_are_refused() {
        let s = store();
        let long = "x".repeat(MAX_REASON_CHARS + 1);
        for reason in ["", "   ", long.as_str()] {
            assert_eq!(s.create_report(&player_report(reason)), Err(Error::Invalid("Reasons are 1 to 500 characters")));
        }
        let no_player = NewReport { player: None, ..player_report("x") };
        assert!(matches!(s.create_report(&no_player), Err(Error::Invalid(_))));
        assert!(s.create_report(&player_report(&"x".repeat(MAX_REASON_CHARS))).is_ok());
    }

    #[test]
    fn evidence_keeps_only_the_latest_chat_lines() {
        let s = store();
        let mut r = player_report("x");
        r.chat = (0..MAX_REPORT_CHAT as i64 + 5).map(|i| ReportChat { name: "a".into(), text: i.to_string(), at: i }).collect();
        let id = s.create_report(&r).unwrap();
        let chat = s.report(id).unwrap().unwrap().chat;
        assert_eq!(chat.len(), MAX_REPORT_CHAT);
        assert_eq!(chat.last().unwrap().at, MAX_REPORT_CHAT as i64 + 4);
    }

    #[test]
    fn listing_filters_pages_and_newest_first() {
        let s = store();
        let ids: Vec<i64> = (0..4).map(|_| s.create_report(&player_report("x")).unwrap()).collect();
        s.set_report_status(ids[1], ReportStatus::Dismissed).unwrap();
        let open = s.reports(Some(ReportStatus::Open), 0, 10).unwrap();
        assert_eq!(open.iter().map(|r| r.id).collect::<Vec<_>>(), vec![ids[3], ids[2], ids[0]]);
        let page = s.reports(None, 1, 2).unwrap();
        assert_eq!(page.iter().map(|r| r.id).collect::<Vec<_>>(), vec![ids[2], ids[1]]);
        assert_eq!(page[1].status, ReportStatus::Dismissed);
        assert!(page[1].resolved > 0);
    }

    #[test]
    fn status_and_delete_change_only_the_named_report() {
        let s = store();
        let id = s.create_report(&player_report("x")).unwrap();
        let other = s.create_report(&player_report("y")).unwrap();
        s.set_report_status(id, ReportStatus::Resolved).unwrap();
        s.set_report_status(id, ReportStatus::Open).unwrap();
        assert_eq!(s.report(id).unwrap().unwrap().status, ReportStatus::Open);
        assert_eq!(s.report(id).unwrap().unwrap().resolved, 0);
        s.delete_report(id).unwrap();
        assert!(s.report(id).unwrap().is_none());
        assert!(s.report(other).unwrap().is_some());
        assert_eq!(s.delete_report(id), Err(Error::NotFound));
        assert_eq!(s.set_report_status(id, ReportStatus::Dismissed), Err(Error::NotFound));
    }

    #[test]
    fn illegal_content_is_listed_first() {
        let s = store();
        let plain = s.create_report(&player_report("x")).unwrap();
        let illegal = s.create_report(&NewReport { category: ReportCategory::Illegal, ..player_report("y") }).unwrap();
        let newest = s.create_report(&player_report("z")).unwrap();
        let ids: Vec<i64> = s.reports(None, 0, 10).unwrap().iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![illegal, newest, plain]);
        assert_eq!(s.report(illegal).unwrap().unwrap().category, ReportCategory::Illegal);
        assert_eq!(ReportCategory::parse("spam"), Some(ReportCategory::Spam));
        assert_eq!(ReportCategory::parse("ILLEGAL"), None);
    }

    #[test]
    fn deleting_the_reporter_keeps_the_report() {
        let s = store();
        let a = raw_account(&s, "reporter");
        let mut r = player_report("x");
        r.reporter.account = Some(a);
        let id = s.create_report(&r).unwrap();
        s.admin_delete_account(a).unwrap();
        assert_eq!(s.report(id).unwrap().unwrap().reporter.account, None);
    }
}
