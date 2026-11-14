//! The map library: maps players upload, with visibility, a review queue for
//! public maps, votes, favourites and play counts.
//!
//! Who may open a map: its owner and admins always; anyone else only when it is
//! approved and not private. A map hidden from a viewer looks missing to them.

use crate::{Account, Error, Result, Store, is_constraint, now};
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::collections::HashMap;

pub const MAX_CODE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_MAP_NAME_CHARS: usize = 40;
/// Maps per account, counting every visibility.
pub const MAX_MAPS_PER_ACCOUNT: i64 = 100;
/// Favourites per account.
pub const MAX_FAVOURITES: i64 = 500;
const MAX_PAGE_SIZE: usize = 50;
const MAX_SEARCH_CHARS: usize = 40;
/// Largest review queue returned at once.
const PENDING_LIMIT: i64 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    /// Listed for everyone once approved.
    Public,
    /// Open to anyone with the id; not listed.
    Unlisted,
    /// Owner and admins only.
    Private,
}

impl Visibility {
    fn as_str(self) -> &'static str {
        match self {
            Visibility::Public => "public",
            Visibility::Unlisted => "unlisted",
            Visibility::Private => "private",
        }
    }

    /// The database value. The schema CHECK keeps stored values valid; the
    /// safest reading of anything else is private.
    fn parse(s: &str) -> Visibility {
        match s {
            "public" => Visibility::Public,
            "unlisted" => Visibility::Unlisted,
            _ => Visibility::Private,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Public map waiting for an admin.
    Pending,
    Approved,
    /// Hidden from everyone but the owner. Stays rejected until the owner
    /// makes it public again with a new edit, which sends it back to review.
    Rejected,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Approved => "approved",
            Status::Rejected => "rejected",
        }
    }

    /// Unknown values are read as rejected, the more hidden of the two.
    fn parse(s: &str) -> Status {
        match s {
            "pending" => Status::Pending,
            "approved" => Status::Approved,
            _ => Status::Rejected,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    New,
    Top,
    Plays,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Approve,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapSummary {
    pub id: i64,
    pub name: String,
    pub author: Account,
    pub visibility: Visibility,
    pub status: Status,
    /// Length of the map code in bytes.
    pub size: i64,
    pub plays: i64,
    /// Sum of all votes.
    pub score: i64,
    pub created: i64,
    pub updated: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapDetail {
    pub map: MapSummary,
    pub code: String,
    /// The viewer's vote: -1, 0 or 1.
    pub vote: i64,
    pub favourite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub maps: Vec<MapSummary>,
    /// Matching maps across all pages.
    pub total: i64,
}

/// Columns read by `summary_row`, for a query over `MAP_FROM` aliased `m`/`a`.
const SUMMARY: &str = "m.id, m.name, a.id, a.name, m.visibility, m.status, m.size, m.plays, \
     (SELECT COALESCE(SUM(v.value), 0) FROM map_votes v WHERE v.map_id = m.id), m.created, m.updated";
const MAP_FROM: &str = "maps m JOIN accounts a ON a.id = m.owner_id";
const SCORE: &str = "(SELECT COALESCE(SUM(v.value), 0) FROM map_votes v WHERE v.map_id = m.id)";
/// Public, approved maps: the ones anyone may list.
const LISTED: &str = "m.visibility = 'public' AND m.status = 'approved'";

fn summary_row(r: &Row<'_>) -> rusqlite::Result<MapSummary> {
    Ok(MapSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        author: Account { id: r.get(2)?, name: r.get(3)? },
        visibility: Visibility::parse(&r.get::<_, String>(4)?),
        status: Status::parse(&r.get::<_, String>(5)?),
        size: r.get(6)?,
        plays: r.get(7)?,
        score: r.get(8)?,
        created: r.get(9)?,
        updated: r.get(10)?,
    })
}

/// Whether `viewer` may open a map with these fields.
fn viewable(owner: i64, status: Status, visibility: Visibility, viewer: Option<i64>, admin: bool) -> bool {
    admin || viewer == Some(owner) || (status == Status::Approved && visibility != Visibility::Private)
}

/// Owners and admins may change a map. Anyone else gets `Forbidden` if they
/// can see it, and `NotFound` if they cannot.
fn check_manage(owner: i64, status: Status, visibility: Visibility, by: i64, admin: bool) -> Result<()> {
    if owner == by || admin {
        Ok(())
    } else if viewable(owner, status, visibility, Some(by), false) {
        Err(Error::Forbidden("Only the owner can change this map"))
    } else {
        Err(Error::NotFound)
    }
}

/// The owner of a map the viewer may open; `NotFound` otherwise.
fn require_visible(db: &Connection, id: i64, viewer: i64) -> Result<i64> {
    let (owner, status, visibility) = meta(db, id)?;
    if viewable(owner, status, visibility, Some(viewer), false) {
        Ok(owner)
    } else {
        Err(Error::NotFound)
    }
}

/// Owner, status and visibility of a map.
fn meta(db: &Connection, id: i64) -> Result<(i64, Status, Visibility)> {
    db.query_row("SELECT owner_id, status, visibility FROM maps WHERE id = ?1", [id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            Status::parse(&r.get::<_, String>(1)?),
            Visibility::parse(&r.get::<_, String>(2)?),
        ))
    })
    .optional()?
    .ok_or(Error::NotFound)
}

fn summary(db: &Connection, id: i64) -> Result<MapSummary> {
    db.query_row(&format!("SELECT {SUMMARY} FROM {MAP_FROM} WHERE m.id = ?1"), [id], summary_row)
        .optional()?
        .ok_or(Error::NotFound)
}

fn check_map_name(name: &str) -> Result<String> {
    let name = name.trim();
    let n = name.chars().count();
    if n == 0 || n > MAX_MAP_NAME_CHARS {
        return Err(Error::Invalid("Map names are 1 to 40 characters"));
    }
    if name.chars().any(char::is_control) {
        return Err(Error::Invalid("Map names cannot contain control characters"));
    }
    Ok(name.to_owned())
}

fn check_code(code: &str) -> Result<()> {
    if code.is_empty() {
        Err(Error::Invalid("The map is empty"))
    } else if code.len() > MAX_CODE_BYTES {
        Err(Error::Invalid("The map is too large"))
    } else {
        Ok(())
    }
}

/// A LIKE pattern matching `search` anywhere, with `%`, `_` and `\` taken
/// literally. `None` for a blank search.
fn search_pattern(search: &str) -> Result<Option<String>> {
    let text = search.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.chars().count() > MAX_SEARCH_CHARS {
        return Err(Error::Invalid("Search is too long"));
    }
    let mut pattern = String::with_capacity(text.len() + 2);
    pattern.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    Ok(Some(pattern))
}

/// One page of the maps matching `filter` (SQL over `MAP_FROM`, aliases `m`
/// and `a`) and `search`, in `order`.
fn listing(db: &Connection, filter: &str, order: &str, search: &str, page: u32, page_size: usize) -> Result<Listing> {
    let page_size = page_size.clamp(1, MAX_PAGE_SIZE);
    let pattern = search_pattern(search)?;
    let filter = format!("{filter} AND (?1 IS NULL OR m.name LIKE ?1 ESCAPE '\\' OR a.name LIKE ?1 ESCAPE '\\')");
    let total: i64 = db.query_row(&format!("SELECT COUNT(*) FROM {MAP_FROM} WHERE {filter}"), params![pattern], |r| r.get(0))?;
    let offset = i64::from(page) * page_size as i64;
    let mut stmt = db.prepare(&format!(
        "SELECT {SUMMARY} FROM {MAP_FROM} WHERE {filter} ORDER BY {order} LIMIT ?2 OFFSET ?3"
    ))?;
    let maps = stmt
        .query_map(params![pattern, page_size as i64, offset], summary_row)?
        .collect::<rusqlite::Result<Vec<MapSummary>>>()?;
    Ok(Listing { maps, total })
}

impl Store {
    /// Add a map and return its id. Public maps wait for review; the others
    /// are live at once.
    pub fn upload(&self, owner: i64, name: &str, code: &str, visibility: Visibility) -> Result<i64> {
        let name = check_map_name(name)?;
        check_code(code)?;
        let status = if visibility == Visibility::Public { Status::Pending } else { Status::Approved };
        let now = now();
        let mut db = self.db();
        let tx = db.transaction()?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM maps WHERE owner_id = ?1", [owner], |r| r.get(0))?;
        if count >= MAX_MAPS_PER_ACCOUNT {
            return Err(Error::Limit("You have too many maps; delete one first"));
        }
        tx.execute(
            "INSERT INTO maps (owner_id, name, code, size, visibility, status, plays, created, updated) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            params![owner, name, code, code.len() as i64, visibility.as_str(), status.as_str(), now],
        )
        .map_err(|e| if is_constraint(&e) { Error::NotFound } else { e.into() })?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }

    /// Public, approved maps, newest, best voted or most played first. `search`
    /// matches the map name or its author's, ignoring case. `page` starts at 0;
    /// `page_size` is clamped to 1..=50.
    pub fn list(&self, sort: Sort, search: &str, page: u32, page_size: usize) -> Result<Listing> {
        let order = match sort {
            Sort::New => "m.created DESC, m.id DESC".to_owned(),
            Sort::Top => format!("{SCORE} DESC, m.created DESC, m.id DESC"),
            Sort::Plays => "m.plays DESC, m.created DESC, m.id DESC".to_owned(),
        };
        listing(&self.db(), LISTED, &order, search, page, page_size)
    }

    /// Every map, whatever its status or visibility, newest first. `search`
    /// and paging work as in `list`.
    pub fn admin_list(&self, search: &str, page: u32, page_size: usize) -> Result<Listing> {
        listing(&self.db(), "1 = 1", "m.created DESC, m.id DESC", search, page, page_size)
    }

    /// Every map the owner has, all visibilities, most recently changed first.
    pub fn mine(&self, owner: i64) -> Result<Vec<MapSummary>> {
        let db = self.db();
        let mut stmt = db.prepare(&format!(
            "SELECT {SUMMARY} FROM {MAP_FROM} WHERE m.owner_id = ?1 ORDER BY m.updated DESC, m.id DESC"
        ))?;
        Ok(stmt.query_map([owner], summary_row)?.collect::<rusqlite::Result<Vec<MapSummary>>>()?)
    }

    /// Public maps waiting for review, oldest first.
    pub fn pending(&self) -> Result<Vec<MapSummary>> {
        let db = self.db();
        let mut stmt = db.prepare(&format!(
            "SELECT {SUMMARY} FROM {MAP_FROM} WHERE m.status = 'pending' ORDER BY m.created ASC, m.id ASC LIMIT ?1"
        ))?;
        Ok(stmt.query_map([PENDING_LIMIT], summary_row)?.collect::<rusqlite::Result<Vec<MapSummary>>>()?)
    }

    /// One map with its code, if the viewer may open it. `admin` may open any map.
    pub fn get(&self, id: i64, viewer: Option<i64>, admin: bool) -> Result<MapDetail> {
        let db = self.db();
        let (owner, status, visibility) = meta(&db, id)?;
        if !viewable(owner, status, visibility, viewer, admin) {
            return Err(Error::NotFound);
        }
        let map = summary(&db, id)?;
        let code: String = db.query_row("SELECT code FROM maps WHERE id = ?1", [id], |r| r.get(0))?;
        let (vote, favourite) = match viewer {
            Some(v) => (
                db.query_row(
                    "SELECT value FROM map_votes WHERE map_id = ?1 AND account_id = ?2",
                    params![id, v],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0),
                db.query_row(
                    "SELECT 1 FROM favourites WHERE map_id = ?1 AND account_id = ?2",
                    params![id, v],
                    |_| Ok(()),
                )
                .optional()?
                .is_some(),
            ),
            None => (0, false),
        };
        Ok(MapDetail { map, code, vote, favourite })
    }

    /// Change a map its owner made. `code` of `None` keeps the code. Changing
    /// the name or code of a public map, or making a map public, sends it back
    /// to review. Rejected maps stay rejected unless they go public again.
    pub fn update(&self, owner: i64, id: i64, name: &str, code: Option<&str>, visibility: Visibility) -> Result<()> {
        let name = check_map_name(name)?;
        if let Some(code) = code {
            check_code(code)?;
        }
        let mut db = self.db();
        let tx = db.transaction()?;
        let (current_owner, status, old_visibility) = meta(&tx, id)?;
        check_manage(current_owner, status, old_visibility, owner, false)?;
        let (old_name, old_code): (String, String) =
            tx.query_row("SELECT name, code FROM maps WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let code = code.unwrap_or(old_code.as_str());
        let touched = name != old_name || code != old_code;
        let status = if visibility == Visibility::Public {
            if touched || visibility != old_visibility { Status::Pending } else { status }
        } else if status == Status::Rejected {
            Status::Rejected
        } else {
            Status::Approved
        };
        tx.execute(
            "UPDATE maps SET name = ?1, code = ?2, size = ?3, visibility = ?4, status = ?5, updated = ?6 WHERE id = ?7",
            params![name, code, code.len() as i64, visibility.as_str(), status.as_str(), now(), id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Hard-delete a map with its votes and favourites. Owners and admins only.
    pub fn delete_map(&self, by: i64, id: i64, admin: bool) -> Result<()> {
        let db = self.db();
        let (owner, status, visibility) = meta(&db, id)?;
        check_manage(owner, status, visibility, by, admin)?;
        db.execute("DELETE FROM maps WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Vote on a map the account may open and does not own: 1, -1, or 0 to
    /// take the vote back. One vote per account; a new vote replaces the old.
    pub fn vote(&self, account: i64, id: i64, value: i64) -> Result<()> {
        if !(-1..=1).contains(&value) {
            return Err(Error::Invalid("Votes are 1, -1, or 0 to remove"));
        }
        let db = self.db();
        let owner = require_visible(&db, id, account)?;
        if owner == account {
            return Err(Error::Forbidden("You cannot vote on your own map"));
        }
        if value == 0 {
            db.execute("DELETE FROM map_votes WHERE map_id = ?1 AND account_id = ?2", params![id, account])?;
        } else {
            db.execute(
                "INSERT INTO map_votes (map_id, account_id, value) VALUES (?1, ?2, ?3) \
                 ON CONFLICT (map_id, account_id) DO UPDATE SET value = excluded.value",
                params![id, account, value],
            )?;
        }
        Ok(())
    }

    /// Add or remove a favourite. Adding needs a map the account may open;
    /// removing works even after the map has become hidden.
    pub fn favourite(&self, account: i64, id: i64, on: bool) -> Result<()> {
        let db = self.db();
        if !on {
            db.execute("DELETE FROM favourites WHERE account_id = ?1 AND map_id = ?2", params![account, id])?;
            return Ok(());
        }
        require_visible(&db, id, account)?;
        let already: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM favourites WHERE map_id = ?1 AND account_id = ?2)",
            params![id, account],
            |r| r.get(0),
        )?;
        if already {
            return Ok(());
        }
        let count: i64 =
            db.query_row("SELECT COUNT(*) FROM favourites WHERE account_id = ?1", [account], |r| r.get(0))?;
        if count >= MAX_FAVOURITES {
            return Err(Error::Limit("You have too many favourites"));
        }
        db.execute(
            "INSERT INTO favourites (account_id, map_id, created) VALUES (?1, ?2, ?3)",
            params![account, id, now()],
        )?;
        Ok(())
    }

    /// The account's favourites that it may still open, newest favourite first.
    pub fn favourites(&self, account: i64) -> Result<Vec<MapSummary>> {
        let db = self.db();
        let mut stmt = db.prepare(&format!(
            "SELECT {SUMMARY} FROM {MAP_FROM} JOIN favourites f ON f.map_id = m.id \
             WHERE f.account_id = ?1 AND (m.owner_id = ?1 OR (m.status = 'approved' AND m.visibility <> 'private')) \
             ORDER BY f.created DESC, m.id DESC"
        ))?;
        Ok(stmt.query_map([account], summary_row)?.collect::<rusqlite::Result<Vec<MapSummary>>>()?)
    }

    /// The account's vote (-1, 0 or 1) and favourite flag on each of `ids`, for
    /// showing them in map lists. Maps the account never marked are left out.
    pub fn marks(&self, account: i64, ids: &[i64]) -> Result<HashMap<i64, (i64, bool)>> {
        let mut marks = HashMap::new();
        if ids.is_empty() {
            return Ok(marks);
        }
        // ids are integers, so listing them inline cannot inject SQL
        let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        let db = self.db();
        let mut votes = db.prepare(&format!("SELECT map_id, value FROM map_votes WHERE account_id = ?1 AND map_id IN ({list})"))?;
        for row in votes.query_map([account], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (id, vote) = row?;
            marks.entry(id).or_insert((0, false)).0 = vote;
        }
        let mut favs = db.prepare(&format!("SELECT map_id FROM favourites WHERE account_id = ?1 AND map_id IN ({list})"))?;
        for row in favs.query_map([account], |r| r.get::<_, i64>(0))? {
            marks.entry(row?).or_insert((0, false)).1 = true;
        }
        Ok(marks)
    }

    /// Count a play. Only maps anyone may open count; for any other id this does nothing.
    pub fn record_play(&self, id: i64) -> Result<()> {
        self.db().execute(
            "UPDATE maps SET plays = plays + 1 WHERE id = ?1 AND status = 'approved' AND visibility <> 'private'",
            [id],
        )?;
        Ok(())
    }

    /// Admin decision on a map.
    pub fn moderate(&self, id: i64, verdict: Verdict) -> Result<()> {
        let status = match verdict {
            Verdict::Approve => Status::Approved,
            Verdict::Reject => Status::Rejected,
        };
        let n = self.db().execute("UPDATE maps SET status = ?1 WHERE id = ?2", params![status.as_str(), id])?;
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    fn live_public(s: &Store, owner: i64, name: &str) -> i64 {
        let id = s.upload(owner, name, "code", Visibility::Public).unwrap();
        s.moderate(id, Verdict::Approve).unwrap();
        id
    }

    fn status_of(s: &Store, id: i64) -> Status {
        s.get(id, None, true).unwrap().map.status
    }

    fn score(s: &Store, id: i64) -> i64 {
        s.get(id, None, true).unwrap().map.score
    }

    #[test]
    fn upload_checks_name_code_and_owner() {
        let s = store();
        let o = raw_account(&s, "Owner");
        assert!(matches!(s.upload(o, "  ", "c", Visibility::Unlisted), Err(Error::Invalid(_))));
        let long = "n".repeat(MAX_MAP_NAME_CHARS + 1);
        assert!(matches!(s.upload(o, &long, "c", Visibility::Unlisted), Err(Error::Invalid(_))));
        assert!(matches!(s.upload(o, "bad\u{7}name", "c", Visibility::Unlisted), Err(Error::Invalid(_))));
        s.upload(o, &"n".repeat(MAX_MAP_NAME_CHARS), "c", Visibility::Unlisted).unwrap();
        assert!(matches!(s.upload(o, "x", "", Visibility::Unlisted), Err(Error::Invalid(_))));
        assert!(matches!(
            s.upload(o, "x", &"c".repeat(MAX_CODE_BYTES + 1), Visibility::Unlisted),
            Err(Error::Invalid(_))
        ));
        s.upload(o, "x", &"c".repeat(MAX_CODE_BYTES), Visibility::Unlisted).unwrap();
        assert!(matches!(s.upload(999, "x", "c", Visibility::Unlisted), Err(Error::NotFound)));
    }

    #[test]
    fn public_maps_start_pending_and_others_are_live() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let p = s.upload(o, "Pub", "code", Visibility::Public).unwrap();
        let u = s.upload(o, "Unl", "code", Visibility::Unlisted).unwrap();
        let v = s.upload(o, "Priv", "code", Visibility::Private).unwrap();
        assert_eq!(status_of(&s, p), Status::Pending);
        assert_eq!(status_of(&s, u), Status::Approved);
        assert_eq!(status_of(&s, v), Status::Approved);
    }

    #[test]
    fn visibility_decides_who_can_open_a_map() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let other = raw_account(&s, "Other");
        let pending = s.upload(o, "Pending", "code", Visibility::Public).unwrap();
        let unlisted = s.upload(o, "Link", "code", Visibility::Unlisted).unwrap();
        let private = s.upload(o, "Mine", "code", Visibility::Private).unwrap();
        let public = live_public(&s, o, "Live");
        let rejected = s.upload(o, "Bad", "code", Visibility::Public).unwrap();
        s.moderate(rejected, Verdict::Reject).unwrap();

        for hidden in [pending, private, rejected] {
            assert!(matches!(s.get(hidden, Some(other), false), Err(Error::NotFound)), "{hidden}");
            assert!(matches!(s.get(hidden, None, false), Err(Error::NotFound)), "{hidden}");
        }
        for id in [pending, unlisted, private, public, rejected] {
            assert!(s.get(id, Some(o), false).is_ok(), "owner sees {id}");
        }
        assert!(s.get(private, None, true).is_ok());
        assert!(s.get(pending, None, true).is_ok());
        assert!(s.get(unlisted, None, false).is_ok());
        assert!(s.get(public, Some(other), false).is_ok());
        assert!(matches!(s.get(999, None, true), Err(Error::NotFound)));
    }

    #[test]
    fn get_returns_the_code_and_the_viewers_vote() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let fan = raw_account(&s, "Fan");
        let m = live_public(&s, o, "Map");
        s.vote(fan, m, -1).unwrap();
        s.favourite(fan, m, true).unwrap();
        let d = s.get(m, Some(fan), false).unwrap();
        assert_eq!(d.code, "code");
        assert_eq!(d.vote, -1);
        assert!(d.favourite);
        assert_eq!(d.map.score, -1);
        let anon = s.get(m, None, false).unwrap();
        assert_eq!((anon.vote, anon.favourite), (0, false));
    }

    #[test]
    fn listing_shows_only_public_approved_maps() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let live = live_public(&s, o, "Live");
        s.upload(o, "Pending", "c", Visibility::Public).unwrap();
        s.upload(o, "Unlisted", "c", Visibility::Unlisted).unwrap();
        s.upload(o, "Private", "c", Visibility::Private).unwrap();
        let listing = s.list(Sort::New, "", 0, 20).unwrap();
        assert_eq!(listing.total, 1);
        assert_eq!(listing.maps[0].id, live);
    }

    #[test]
    fn admin_listing_shows_every_map_newest_first() {
        let s = store();
        let ann = raw_account(&s, "Ann");
        let a = s.upload(ann, "Pending", "c", Visibility::Public).unwrap();
        let b = s.upload(ann, "Private", "c", Visibility::Private).unwrap();
        let c = s.upload(ann, "Rejected", "c", Visibility::Public).unwrap();
        s.moderate(c, Verdict::Reject).unwrap();
        let bo = raw_account(&s, "Bo");
        let d = s.upload(bo, "Other", "c", Visibility::Unlisted).unwrap();
        let all = s.admin_list("", 0, 50).unwrap();
        assert_eq!(all.total, 4);
        assert_eq!(all.maps.iter().map(|m| m.id).collect::<Vec<_>>(), vec![d, c, b, a]);
        assert_eq!(all.maps.iter().find(|m| m.id == c).unwrap().status, Status::Rejected);
        let ids = |q: &str| -> Vec<i64> { s.admin_list(q, 0, 50).unwrap().maps.iter().map(|m| m.id).collect() };
        assert_eq!(ids("rejected"), vec![c]);
        assert_eq!(s.admin_list("ann", 0, 50).unwrap().total, 3, "author names are searched");
        assert_eq!(s.admin_list("", 1, 2).unwrap().maps.iter().map(|m| m.id).collect::<Vec<_>>(), vec![b, a]);
        assert!(matches!(s.admin_list(&"x".repeat(41), 0, 10), Err(Error::Invalid(_))));
    }

    #[test]
    fn search_matches_map_and_author_names_literally() {
        let s = store();
        let ann = raw_account(&s, "Ann");
        let bo = raw_account(&s, "Bo");
        live_public(&s, ann, "a_b");
        live_public(&s, ann, "axb");
        live_public(&s, bo, "Plain");
        let names = |q: &str| -> Vec<String> {
            s.list(Sort::New, q, 0, 50).unwrap().maps.into_iter().map(|m| m.name).collect()
        };
        assert_eq!(names("_"), vec!["a_b"]);
        assert!(names("%").is_empty());
        assert_eq!(names("plain"), vec!["Plain"]);
        assert_eq!(names("bo"), vec!["Plain"], "author names are searched");
        assert_eq!(names("ann").len(), 2);
        assert!(matches!(s.list(Sort::New, &"x".repeat(41), 0, 10), Err(Error::Invalid(_))));
    }

    #[test]
    fn sorts_and_pages() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let fan = raw_account(&s, "Fan");
        let fan2 = raw_account(&s, "Fan2");
        let a = live_public(&s, o, "A");
        let b = live_public(&s, o, "B");
        let c = live_public(&s, o, "C");
        s.vote(fan, b, 1).unwrap();
        s.vote(fan2, b, 1).unwrap();
        s.vote(fan, c, -1).unwrap();
        s.record_play(c).unwrap();
        s.record_play(c).unwrap();
        s.record_play(a).unwrap();
        let ids = |sort: Sort| -> Vec<i64> {
            s.list(sort, "", 0, 50).unwrap().maps.iter().map(|m| m.id).collect()
        };
        assert_eq!(ids(Sort::New), vec![c, b, a]);
        assert_eq!(ids(Sort::Top), vec![b, a, c]);
        assert_eq!(ids(Sort::Plays), vec![c, a, b]);

        let page = s.list(Sort::New, "", 1, 2).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.maps.iter().map(|m| m.id).collect::<Vec<_>>(), vec![a]);
        assert_eq!(s.list(Sort::New, "", 0, 0).unwrap().maps.len(), 1, "page size is at least 1");
        assert_eq!(s.list(Sort::New, "", 0, 500).unwrap().maps.len(), 3, "page size is at most 50");
    }

    #[test]
    fn mine_lists_every_visibility_of_the_owners_maps() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let other = raw_account(&s, "Other");
        s.upload(o, "A", "c", Visibility::Public).unwrap();
        s.upload(o, "B", "c", Visibility::Private).unwrap();
        s.upload(other, "C", "c", Visibility::Unlisted).unwrap();
        assert_eq!(s.mine(o).unwrap().len(), 2);
    }

    #[test]
    fn editing_a_public_map_sends_it_back_to_review() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let m = live_public(&s, o, "Map");
        s.update(o, m, "Map", Some("code"), Visibility::Public).unwrap();
        assert_eq!(status_of(&s, m), Status::Approved, "an unchanged save keeps the approval");
        s.update(o, m, "Map", Some("changed"), Visibility::Public).unwrap();
        assert_eq!(status_of(&s, m), Status::Pending);
        s.moderate(m, Verdict::Approve).unwrap();
        s.update(o, m, "Renamed", None, Visibility::Public).unwrap();
        assert_eq!(status_of(&s, m), Status::Pending, "a rename is an edit too");
        s.moderate(m, Verdict::Approve).unwrap();
        s.update(o, m, "Renamed", None, Visibility::Unlisted).unwrap();
        assert_eq!(status_of(&s, m), Status::Approved);
        s.update(o, m, "Renamed", None, Visibility::Public).unwrap();
        assert_eq!(status_of(&s, m), Status::Pending, "going public again is a review");
    }

    #[test]
    fn rejected_maps_stay_rejected_until_they_go_public_again() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let m = s.upload(o, "Map", "c", Visibility::Public).unwrap();
        s.moderate(m, Verdict::Reject).unwrap();
        s.update(o, m, "Map", None, Visibility::Public).unwrap();
        assert_eq!(status_of(&s, m), Status::Rejected);
        s.update(o, m, "Map", Some("fixed"), Visibility::Unlisted).unwrap();
        assert_eq!(status_of(&s, m), Status::Rejected, "hiding it and editing does not clear the rejection");
        assert!(matches!(s.get(m, None, false), Err(Error::NotFound)));
        s.update(o, m, "Map", Some("fixed again"), Visibility::Public).unwrap();
        assert_eq!(status_of(&s, m), Status::Pending);
    }

    #[test]
    fn only_the_owner_may_change_or_delete() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let other = raw_account(&s, "Other");
        let public = live_public(&s, o, "Map");
        let private = s.upload(o, "Hidden", "c", Visibility::Private).unwrap();
        assert!(matches!(s.update(other, public, "Map", None, Visibility::Unlisted), Err(Error::Forbidden(_))));
        assert!(matches!(s.update(other, private, "Hidden", None, Visibility::Unlisted), Err(Error::NotFound)));
        assert!(matches!(s.update(o, 999, "Map", None, Visibility::Unlisted), Err(Error::NotFound)));
        assert!(matches!(s.delete_map(other, public, false), Err(Error::Forbidden(_))));
        assert!(matches!(s.delete_map(other, private, false), Err(Error::NotFound)));
        s.delete_map(0, public, true).unwrap();
        assert!(matches!(s.get(public, None, true), Err(Error::NotFound)));
    }

    #[test]
    fn delete_removes_votes_and_favourites_too() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let fan = raw_account(&s, "Fan");
        let m = live_public(&s, o, "Map");
        s.vote(fan, m, 1).unwrap();
        s.favourite(fan, m, true).unwrap();
        s.delete_map(o, m, false).unwrap();
        for table in ["maps", "map_votes", "favourites"] {
            let n: i64 = s.db().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table}");
        }
        assert!(s.favourites(fan).unwrap().is_empty());
    }

    #[test]
    fn votes_are_one_per_account_and_not_on_your_own_map() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let a = raw_account(&s, "A");
        let b = raw_account(&s, "B");
        let m = live_public(&s, o, "Map");
        assert!(matches!(s.vote(a, m, 2), Err(Error::Invalid(_))));
        assert!(matches!(s.vote(o, m, 1), Err(Error::Forbidden(_))));
        s.vote(a, m, 1).unwrap();
        s.vote(a, m, -1).unwrap();
        s.vote(b, m, 1).unwrap();
        assert_eq!(score(&s, m), 0, "a changes its vote rather than adding one");
        s.vote(a, m, 0).unwrap();
        assert_eq!(score(&s, m), 1);
        let pending = s.upload(o, "P", "c", Visibility::Public).unwrap();
        let private = s.upload(o, "H", "c", Visibility::Private).unwrap();
        assert!(matches!(s.vote(a, pending, 1), Err(Error::NotFound)));
        assert!(matches!(s.vote(a, private, 1), Err(Error::NotFound)));
    }

    #[test]
    fn marks_report_only_this_accounts_votes_and_favourites() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let fan = raw_account(&s, "Fan");
        let other = raw_account(&s, "Other");
        let a = live_public(&s, o, "A");
        let b = live_public(&s, o, "B");
        let c = live_public(&s, o, "C");
        s.vote(fan, a, -1).unwrap();
        s.favourite(fan, b, true).unwrap();
        s.vote(other, c, 1).unwrap();
        s.favourite(other, c, true).unwrap();
        let marks = s.marks(fan, &[a, b, c]).unwrap();
        assert_eq!(marks.get(&a), Some(&(-1, false)));
        assert_eq!(marks.get(&b), Some(&(0, true)));
        assert_eq!(marks.get(&c), None, "another account's marks are not the fan's");
        assert!(s.marks(fan, &[]).unwrap().is_empty());
    }

    #[test]
    fn favourites_are_listed_only_while_visible_and_capped() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let fan = raw_account(&s, "Fan");
        let m = live_public(&s, o, "Map");
        s.favourite(fan, m, true).unwrap();
        s.favourite(fan, m, true).unwrap();
        assert_eq!(s.favourites(fan).unwrap().len(), 1);
        s.update(o, m, "Map", None, Visibility::Private).unwrap();
        assert!(s.favourites(fan).unwrap().is_empty(), "hidden maps drop out of favourites");
        assert!(matches!(s.favourite(fan, m, true), Err(Error::NotFound)));
        s.favourite(fan, m, false).unwrap();
        let n: i64 = s.db().query_row("SELECT COUNT(*) FROM favourites", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);

        let mut ids = Vec::new();
        {
            let db = s.db();
            for _ in 0..=MAX_FAVOURITES {
                db.execute(
                    "INSERT INTO maps (owner_id, name, code, size, visibility, status, plays, created, updated) \
                     VALUES (?1, 'Raw', 'c', 1, 'public', 'approved', 0, 0, 0)",
                    [o],
                )
                .unwrap();
                ids.push(db.last_insert_rowid());
            }
        }
        for id in &ids[..MAX_FAVOURITES as usize] {
            s.favourite(fan, *id, true).unwrap();
        }
        assert!(matches!(s.favourite(fan, ids[MAX_FAVOURITES as usize], true), Err(Error::Limit(_))));
    }

    #[test]
    fn plays_count_only_for_maps_anyone_may_open() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let live = live_public(&s, o, "Live");
        let pending = s.upload(o, "P", "c", Visibility::Public).unwrap();
        let private = s.upload(o, "H", "c", Visibility::Private).unwrap();
        let unlisted = s.upload(o, "U", "c", Visibility::Unlisted).unwrap();
        for id in [live, pending, private, unlisted, 999] {
            s.record_play(id).unwrap();
        }
        let plays = |id: i64| s.get(id, None, true).unwrap().map.plays;
        assert_eq!(plays(live), 1);
        assert_eq!(plays(unlisted), 1);
        assert_eq!(plays(pending), 0);
        assert_eq!(plays(private), 0);
    }

    #[test]
    fn moderators_work_the_review_queue() {
        let s = store();
        let o = raw_account(&s, "Owner");
        let a = s.upload(o, "A", "c", Visibility::Public).unwrap();
        let b = s.upload(o, "B", "c", Visibility::Public).unwrap();
        assert_eq!(s.pending().unwrap().iter().map(|m| m.id).collect::<Vec<_>>(), vec![a, b]);
        s.moderate(a, Verdict::Approve).unwrap();
        s.moderate(b, Verdict::Reject).unwrap();
        assert!(s.pending().unwrap().is_empty());
        assert_eq!(s.list(Sort::New, "", 0, 10).unwrap().total, 1);
        assert!(matches!(s.get(b, None, false), Err(Error::NotFound)));
        assert!(s.get(b, Some(o), false).is_ok());
        assert!(matches!(s.moderate(999, Verdict::Approve), Err(Error::NotFound)));
    }

    #[test]
    fn accounts_have_a_map_limit() {
        let s = store();
        let o = raw_account(&s, "Owner");
        for i in 0..MAX_MAPS_PER_ACCOUNT {
            s.upload(o, &format!("Map {i}"), "c", Visibility::Unlisted).unwrap();
        }
        assert!(matches!(s.upload(o, "one more", "c", Visibility::Unlisted), Err(Error::Limit(_))));
        let other = raw_account(&s, "Other");
        s.upload(other, "fine", "c", Visibility::Unlisted).unwrap();
    }
}
