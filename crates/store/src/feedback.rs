//! Player feedback: bug reports and suggestions submitted from anywhere in the game.
//! Admins review, resolve, dismiss or delete them in the admin panel.

use crate::{Error, Result, Store, now};
use rusqlite::{Row, params};

/// Longest feedback message, in characters.
pub const MAX_FEEDBACK_CHARS: usize = 1000;
/// Longest auto-captured context string, in characters.
pub const MAX_CONTEXT_CHARS: usize = 500;
/// Longest screen identifier, in characters.
pub const MAX_SCREEN_CHARS: usize = 48;

const COLUMNS: &str = "id, kind, status, message, screen, context, author_account, author_name, author_ip, created, resolved";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackKind {
    Bug,
    Suggestion,
}

impl FeedbackKind {
    fn as_str(self) -> &'static str {
        match self {
            FeedbackKind::Bug => "bug",
            FeedbackKind::Suggestion => "suggestion",
        }
    }

    fn parse(s: &str) -> Option<FeedbackKind> {
        match s {
            "bug" => Some(FeedbackKind::Bug),
            "suggestion" => Some(FeedbackKind::Suggestion),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackStatus {
    Open,
    Resolved,
    Dismissed,
}

impl FeedbackStatus {
    fn as_str(self) -> &'static str {
        match self {
            FeedbackStatus::Open => "open",
            FeedbackStatus::Resolved => "resolved",
            FeedbackStatus::Dismissed => "dismissed",
        }
    }

    fn parse(s: &str) -> Option<FeedbackStatus> {
        match s {
            "open" => Some(FeedbackStatus::Open),
            "resolved" => Some(FeedbackStatus::Resolved),
            "dismissed" => Some(FeedbackStatus::Dismissed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewFeedback {
    pub kind: FeedbackKind,
    pub message: String,
    pub screen: String,
    pub context: String,
    pub author_account: Option<i64>,
    pub author_name: String,
    pub author_ip: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Feedback {
    pub id: i64,
    pub kind: FeedbackKind,
    pub status: FeedbackStatus,
    pub message: String,
    pub screen: String,
    pub context: String,
    pub author_account: Option<i64>,
    pub author_name: String,
    pub author_ip: String,
    pub created: i64,
    pub resolved: i64,
}

fn read_row(r: &Row<'_>) -> rusqlite::Result<Feedback> {
    let kind_str: String = r.get(1)?;
    let status_str: String = r.get(2)?;
    Ok(Feedback {
        id: r.get(0)?,
        kind: FeedbackKind::parse(&kind_str).unwrap_or(FeedbackKind::Bug),
        status: FeedbackStatus::parse(&status_str).unwrap_or(FeedbackStatus::Open),
        message: r.get(3)?,
        screen: r.get(4)?,
        context: r.get(5)?,
        author_account: r.get(6)?,
        author_name: r.get(7)?,
        author_ip: r.get(8)?,
        created: r.get(9)?,
        resolved: r.get(10)?,
    })
}

fn trim_chars(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

impl Store {
    /// Save a new bug report or suggestion. Returns its id.
    pub fn create_feedback(&self, f: &NewFeedback) -> Result<i64> {
        let message = f.message.trim();
        if message.is_empty() {
            return Err(Error::Invalid("Please write a short description before sending"));
        }
        if message.chars().count() > MAX_FEEDBACK_CHARS {
            return Err(Error::Invalid("Message is too long (max 1000 characters)"));
        }
        let screen = trim_chars(&f.screen, MAX_SCREEN_CHARS);
        let context = trim_chars(&f.context, MAX_CONTEXT_CHARS);
        let author_name = {
            let n = trim_chars(&f.author_name, 32);
            if n.is_empty() { "Guest".to_string() } else { n }
        };
        let db = self.db();
        db.execute(
            "INSERT INTO feedback (kind, status, message, screen, context, author_account, author_name, author_ip, created, resolved) \
             VALUES (?1, 'open', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)",
            params![
                f.kind.as_str(),
                message,
                screen,
                context,
                f.author_account,
                author_name,
                f.author_ip,
                now()
            ],
        )?;
        Ok(db.last_insert_rowid())
    }

    /// Feedback newest first, optionally filtered by `kind` and/or `status`, paged by `before` id.
    pub fn list_feedback(
        &self,
        kind: Option<FeedbackKind>,
        status: Option<FeedbackStatus>,
        before: Option<i64>,
        limit: usize,
    ) -> Result<Vec<Feedback>> {
        let db = self.db();
        let kind_s = kind.map(FeedbackKind::as_str);
        let status_s = status.map(FeedbackStatus::as_str);
        let sql = format!(
            "SELECT {COLUMNS} FROM feedback \
             WHERE (?1 IS NULL OR kind = ?1) \
               AND (?2 IS NULL OR status = ?2) \
               AND (?3 IS NULL OR id < ?3) \
             ORDER BY id DESC LIMIT ?4"
        );
        let mut stmt = db.prepare(&sql)?;
        let rows = stmt.query_map(params![kind_s, status_s, before, limit as i64], read_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Change a feedback item's status (`open`, `resolved`, `dismissed`).
    pub fn set_feedback_status(&self, id: i64, status: FeedbackStatus) -> Result<()> {
        let resolved = if status == FeedbackStatus::Open { 0 } else { now() };
        let changed = self.db().execute(
            "UPDATE feedback SET status = ?1, resolved = ?2 WHERE id = ?3",
            params![status.as_str(), resolved, id],
        )?;
        if changed == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    /// Permanently delete a feedback item.
    pub fn delete_feedback(&self, id: i64) -> Result<()> {
        let changed = self.db().execute("DELETE FROM feedback WHERE id = ?1", params![id])?;
        if changed == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    fn sample(kind: FeedbackKind, msg: &str) -> NewFeedback {
        NewFeedback {
            kind,
            message: msg.into(),
            screen: "match".into(),
            context: "room=ABC123 map=Arena".into(),
            author_account: None,
            author_name: "Tester".into(),
            author_ip: "127.0.0.1".into(),
        }
    }

    #[test]
    fn create_filter_status_and_delete() {
        let s = store();
        assert!(matches!(s.create_feedback(&sample(FeedbackKind::Bug, "   ")), Err(Error::Invalid(_))));
        assert!(matches!(
            s.create_feedback(&sample(FeedbackKind::Bug, &"x".repeat(MAX_FEEDBACK_CHARS + 1))),
            Err(Error::Invalid(_))
        ));

        let acc = raw_account(&s, "alice");
        let mut b = sample(FeedbackKind::Bug, "Ball clips through corner");
        b.author_account = Some(acc);
        let id1 = s.create_feedback(&b).unwrap();
        let id2 = s.create_feedback(&sample(FeedbackKind::Suggestion, "Add spectator zoom")).unwrap();

        let all = s.list_feedback(None, Some(FeedbackStatus::Open), None, 20).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, id2);
        assert_eq!(all[1].id, id1);

        let bugs = s.list_feedback(Some(FeedbackKind::Bug), None, None, 20).unwrap();
        assert_eq!(bugs.len(), 1);
        assert_eq!(bugs[0].author_account, Some(acc));

        let counts = s.admin_counts().unwrap();
        assert_eq!(counts.open_bugs, 1);
        assert_eq!(counts.open_suggestions, 1);

        s.set_feedback_status(id1, FeedbackStatus::Resolved).unwrap();
        let counts = s.admin_counts().unwrap();
        assert_eq!(counts.open_bugs, 0);
        assert_eq!(counts.open_suggestions, 1);

        let paged = s.list_feedback(None, None, Some(id2), 20).unwrap();
        assert_eq!(paged.len(), 1);
        assert_eq!(paged[0].id, id1);

        s.delete_feedback(id2).unwrap();
        assert!(matches!(s.delete_feedback(id2), Err(Error::NotFound)));
    }
}
