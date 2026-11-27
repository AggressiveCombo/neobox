//! Data export (GDPR Art. 15 and 20): everything stored about one account, as
//! a JSON document the account's owner can download.

use crate::{Error, Result, Store};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

/// Every row of `query` as a JSON object keyed by column name. `query` takes
/// the account id as `?1`.
fn rows(db: &Connection, query: &str, account: i64) -> Result<Vec<Value>> {
    let mut stmt = db.prepare(query)?;
    let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    let mapped = stmt.query_map(params![account], |r| {
        let mut obj = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let v: rusqlite::types::Value = r.get(i)?;
            obj.insert(name.clone(), sql_json(v));
        }
        Ok(Value::Object(obj))
    })?;
    Ok(mapped.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn sql_json(v: rusqlite::types::Value) -> Value {
    use rusqlite::types::Value as S;
    match v {
        S::Null => Value::Null,
        S::Integer(i) => json!(i),
        S::Real(f) => json!(f),
        S::Text(t) => Value::String(t),
        S::Blob(b) => json!(b.len()),
    }
}

impl Store {
    /// Everything stored about the account. Sections with no rows are empty
    /// arrays. Clips are listed by metadata only: their data is the game's
    /// replay format and is not included.
    pub fn export_account(&self, id: i64) -> Result<Value> {
        let db = self.db();
        let account = db
            .query_row(
                "SELECT id, name, created, xp, games, wins, rounds_won, kills, deaths, play_seconds \
                 FROM accounts WHERE id = ?1",
                [id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "created": r.get::<_, i64>(2)?,
                        "xp": r.get::<_, i64>(3)?,
                        "games": r.get::<_, i64>(4)?,
                        "wins": r.get::<_, i64>(5)?,
                        "rounds_won": r.get::<_, i64>(6)?,
                        "kills": r.get::<_, i64>(7)?,
                        "deaths": r.get::<_, i64>(8)?,
                        "play_seconds": r.get::<_, i64>(9)?,
                    }))
                },
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let prefs = db
            .query_row("SELECT json FROM prefs WHERE account_id = ?1", [id], |r| r.get::<_, String>(0))
            .optional()?
            .map(|j| serde_json::from_str::<Value>(&j).unwrap_or(Value::String(j)))
            .unwrap_or(Value::Null);
        Ok(json!({
            "format": "neobox-export-1",
            "account": account,
            "prefs": prefs,
            "friends": rows(
                &db,
                "SELECT CASE WHEN f.from_id = ?1 THEN f.to_id ELSE f.from_id END AS account_id, \
                 a.name AS name, f.accepted AS accepted, f.created AS created, \
                 CASE WHEN f.from_id = ?1 THEN 'sent' ELSE 'received' END AS direction \
                 FROM friendships f JOIN accounts a ON a.id = CASE WHEN f.from_id = ?1 THEN f.to_id ELSE f.from_id END \
                 WHERE f.from_id = ?1 OR f.to_id = ?1",
                id,
            )?,
            "votes": rows(&db, "SELECT map_id, value, at FROM map_votes WHERE account_id = ?1", id)?,
            "favourites": rows(&db, "SELECT map_id, created FROM favourites WHERE account_id = ?1", id)?,
            "maps": rows(
                &db,
                "SELECT id, name, code, description, visibility, status, reject_reason, plays, created, updated \
                 FROM maps WHERE owner_id = ?1 ORDER BY id",
                id,
            )?,
            "records": rows(&db, "SELECT map_id, ticks, at FROM records WHERE account_id = ?1", id)?,
            "xp_grants": rows(&db, "SELECT amount, at FROM xp_grants WHERE account_id = ?1 ORDER BY at", id)?,
            "clips": rows(
                &db,
                "SELECT id, recorder, map_name, length(data) AS bytes, created FROM clips WHERE account_id = ?1",
                id,
            )?,
            "suspensions": rows(
                &db,
                "SELECT id, reason, created, until FROM suspensions WHERE account_id = ?1 ORDER BY id",
                id,
            )?,
            "feedback": rows(
                &db,
                "SELECT id, kind, status, message, screen, context, author_name, author_ip, created, resolved \
                 FROM feedback WHERE author_account = ?1 ORDER BY id",
                id,
            )?,
            "reports": rows(
                &db,
                "SELECT id, kind, status, category, reason, room_code, room_name, player_name, player_account, \
                 map_name, reporter_name, reporter_ip, created, resolved FROM reports \
                 WHERE reporter_account = ?1 ORDER BY id",
                id,
            )?,
        }))
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::{raw_account, store};
    use crate::{FeedbackKind, NewFeedback, NewReport, ReportCategory, ReportChat, ReportKind, ReportedPlayer, Reporter};
    use rusqlite::params;

    #[test]
    fn export_has_every_section_for_the_account() {
        let s = store();
        let me = raw_account(&s, "Me");
        let other = raw_account(&s, "Other");
        s.db().execute("INSERT INTO prefs (account_id, json) VALUES (?1, '{\"sound\":1}')", [me]).unwrap();
        s.db()
            .execute("INSERT INTO friendships (from_id, to_id, accepted, created) VALUES (?1, ?2, 1, 5)", params![me, other])
            .unwrap();
        s.db()
            .execute("INSERT INTO maps (owner_id, name, code, size, visibility, status, created, updated) VALUES (?1, 'M', 'c', 1, 'private', 'approved', 1, 1)", [me])
            .unwrap();
        let map = s.db().last_insert_rowid();
        s.db().execute("INSERT INTO map_votes (map_id, account_id, value, at) VALUES (?1, ?2, 1, 1)", params![map, me]).unwrap();
        s.db().execute("INSERT INTO favourites (account_id, map_id, created) VALUES (?1, ?2, 1)", params![me, map]).unwrap();
        s.db().execute("INSERT INTO records (map_id, account_id, ticks, at) VALUES (?1, ?2, 9, 1)", params![map, me]).unwrap();
        s.db().execute("INSERT INTO xp_grants (account_id, amount, at) VALUES (?1, 3, 1)", params![me]).unwrap();
        s.db().execute("INSERT INTO clips (account_id, recorder, map_name, data, created) VALUES (?1, 'Me', 'M', x'0102', 1)", [me]).unwrap();
        s.db().execute("INSERT INTO suspensions (account_id, reason, created, until) VALUES (?1, 'spam', 1, 2)", [me]).unwrap();
        s.create_feedback(&NewFeedback {
            kind: FeedbackKind::Suggestion,
            message: "more maps".into(),
            screen: String::new(),
            context: String::new(),
            author_account: Some(me),
            author_name: "Me".into(),
            author_ip: "10.0.0.5".into(),
        })
        .unwrap();
        s.create_report(&NewReport {
            kind: ReportKind::Player,
            category: ReportCategory::Spam,
            reason: "spam".into(),
            reporter: Reporter { account: Some(me), name: "Me".into(), ip: "10.0.0.5".into() },
            room_code: "ABCD".into(),
            room_name: "R".into(),
            player: Some(ReportedPlayer { id: 1, name: "Other".into(), account: Some(other), ip: "10.0.0.6".into() }),
            map: None,
            chat: vec![ReportChat { name: "Other".into(), text: "hi".into(), at: 1 }],
        })
        .unwrap();

        let v = s.export_account(me).unwrap();
        assert_eq!(v["account"]["name"], "Me");
        assert_eq!(v["prefs"]["sound"], 1);
        assert_eq!(v["friends"][0]["name"], "Other");
        assert_eq!(v["friends"][0]["direction"], "sent");
        assert_eq!(v["votes"][0]["value"], 1);
        assert_eq!(v["favourites"].as_array().unwrap().len(), 1);
        assert_eq!(v["maps"][0]["code"], "c");
        assert_eq!(v["records"][0]["ticks"], 9);
        assert_eq!(v["xp_grants"][0]["amount"], 3);
        assert_eq!(v["clips"][0]["bytes"], 2);
        assert_eq!(v["suspensions"][0]["reason"], "spam");
        assert_eq!(v["feedback"][0]["message"], "more maps");
        assert_eq!(v["reports"][0]["category"], "spam");
        assert_eq!(v["reports"][0]["player_name"], "Other");
        assert!(s.export_account(9999).is_err());
    }
}
