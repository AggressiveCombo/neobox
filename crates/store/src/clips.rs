//! Clips: short replays of recorded matches, played behind the main menu.
//! The newest [`MAX_CLIPS`] are kept; older ones are dropped on upload.

use crate::{Error, Result, Store, now};
use rusqlite::{OptionalExtension, params};

/// Largest accepted clip (bytes of replay JSON).
pub const MAX_CLIP_BYTES: usize = 256 * 1024;
/// Clips kept; the oldest go first.
pub const MAX_CLIPS: usize = 500;

/// A clip without its data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipSummary {
    pub id: i64,
    pub recorder: String,
    pub map_name: String,
    /// Unix seconds.
    pub created: i64,
    /// Bytes of replay JSON.
    pub size: i64,
}

impl Store {
    /// Store a clip, dropping the oldest clips beyond [`MAX_CLIPS`]. Returns
    /// the new clip's id.
    pub fn add_clip(&self, account: Option<i64>, recorder: &str, map_name: &str, data: &[u8]) -> Result<i64> {
        if data.len() > MAX_CLIP_BYTES {
            return Err(Error::Limit("Clip is too large"));
        }
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            "INSERT INTO clips (account_id, recorder, map_name, data, created) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![account, recorder, map_name, data, now()],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "DELETE FROM clips WHERE id NOT IN (SELECT id FROM clips ORDER BY id DESC LIMIT ?1)",
            params![MAX_CLIPS as i64],
        )?;
        tx.commit()?;
        Ok(id)
    }

    /// Up to `limit` clips, newest first, with ids below `before` (all when
    /// `None`).
    pub fn clips(&self, before: Option<i64>, limit: usize) -> Result<Vec<ClipSummary>> {
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT id, recorder, map_name, created, length(data) FROM clips WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![before.unwrap_or(i64::MAX), limit as i64], |r| {
            Ok(ClipSummary {
                id: r.get(0)?,
                recorder: r.get(1)?,
                map_name: r.get(2)?,
                created: r.get(3)?,
                size: r.get(4)?,
            })
        })?;
        let clips = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(clips)
    }

    /// The replay JSON of a clip.
    pub fn clip_data(&self, id: i64) -> Result<Vec<u8>> {
        let data: Option<Vec<u8>> =
            self.db().query_row("SELECT data FROM clips WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
        data.ok_or(Error::NotFound)
    }

    pub fn delete_clip(&self, id: i64) -> Result<()> {
        let n = self.db().execute("DELETE FROM clips WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    #[test]
    fn clips_list_newest_first_in_pages() {
        let s = store();
        let a = raw_account(&s, "rec");
        let ids: Vec<i64> = (0..5).map(|i| s.add_clip(Some(a), "rec", &format!("map {i}"), b"{}").unwrap()).collect();
        let first = s.clips(None, 3).unwrap();
        assert_eq!(first.iter().map(|c| c.id).collect::<Vec<_>>(), vec![ids[4], ids[3], ids[2]]);
        assert_eq!((first[0].recorder.as_str(), first[0].map_name.as_str(), first[0].size), ("rec", "map 4", 2));
        let rest = s.clips(Some(ids[2]), 3).unwrap();
        assert_eq!(rest.iter().map(|c| c.id).collect::<Vec<_>>(), vec![ids[1], ids[0]]);
    }

    #[test]
    fn clip_data_round_trips_and_guests_may_upload() {
        let s = store();
        let id = s.add_clip(None, "guest", "Arena", b"replay json").unwrap();
        assert_eq!(s.clip_data(id).unwrap(), b"replay json");
        assert!(matches!(s.clip_data(id + 1), Err(Error::NotFound)));
    }

    #[test]
    fn delete_removes_the_clip() {
        let s = store();
        let id = s.add_clip(None, "x", "m", b"{}").unwrap();
        s.delete_clip(id).unwrap();
        assert!(s.clips(None, 10).unwrap().is_empty());
        assert!(matches!(s.delete_clip(id), Err(Error::NotFound)));
    }

    #[test]
    fn oversized_clips_are_refused() {
        let s = store();
        let big = vec![b'x'; MAX_CLIP_BYTES + 1];
        assert!(matches!(s.add_clip(None, "x", "m", &big), Err(Error::Limit(_))));
        assert!(s.clips(None, 10).unwrap().is_empty());
    }

    #[test]
    fn only_the_newest_clips_are_kept() {
        let s = store();
        let first = s.add_clip(None, "x", "m", b"{}").unwrap();
        for _ in 0..MAX_CLIPS {
            s.add_clip(None, "x", "m", b"{}").unwrap();
        }
        assert_eq!(s.clips(None, usize::MAX).unwrap().len(), MAX_CLIPS);
        assert!(matches!(s.clip_data(first), Err(Error::NotFound)));
    }
}
