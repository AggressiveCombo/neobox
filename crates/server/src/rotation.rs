//! Quick-play modes and their map rotation, in the format of the original's
//! `scripts/rotationmaps/maps2.json`: `meta` names the modes `qp_1`..`qp_10`
//! (title, description, room size, teams, game mode, objective limit) and
//! the defaults of custom rooms (`custom`); `maps` lists each map with the
//! modes that play it.
//!
//! As on hitbox.io the rotation is half fixed and half fresh: the fixed part
//! is `maps/rotation/maps2.json`, and the main server adds the best-rated
//! public library maps of the last week to every mode without teams. Regional
//! game nodes take the main server's rotation (`GET /api/rotation`).

use crate::hub::{BuiltinMap, Hub};
use neobox_store::RoomMap;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// Library maps published this recently can join the rotation.
const FRESH_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;
/// Library maps added to each mode without teams (hitbox.io adds four).
const FRESH_MAPS: usize = 4;
/// How long a built rotation is reused.
const CACHE_TTL: Duration = Duration::from_secs(60);
/// Modes are read as `qp_1`..`qp_10`, like the original client.
const MAX_MODES: usize = 10;

/// One map of the rotation file.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RotationMap {
    pub author: String,
    pub description: String,
    /// Hitbox map code.
    pub leveldata: String,
    pub name: String,
    /// Map id on the site that listed it (hitbox.io for the fixed maps, this
    /// server's library for the fresh ones).
    pub dbid: i64,
    /// `YYYY-MM-DD HH:MM:SS` (UTC), when known.
    pub published: Option<String>,
    /// Modes playing the map (`qp_1`, ..., `custom`).
    pub modes: Vec<String>,
}

/// A quick-play mode, or the custom-room defaults (`custom`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ModeMeta {
    pub title: String,
    pub description: String,
    #[serde(rename = "maxPlayers")]
    pub max_players: u8,
    pub teams: bool,
    #[serde(rename = "gameMode")]
    pub game_mode: i32,
    /// Objective limit (kills, lives or rounds to win).
    pub limit: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Rotation {
    pub maps: Vec<RotationMap>,
    /// `v` (format version) plus one [`ModeMeta`] per mode.
    pub meta: serde_json::Map<String, serde_json::Value>,
}

/// A quick-play mode with its id (`qp_N`).
#[derive(Clone, Debug, PartialEq)]
pub struct QuickMode {
    pub id: String,
    pub meta: ModeMeta,
}

impl Rotation {
    /// The rotation file; empty (no quick play, stock custom rooms) when it
    /// is missing or invalid.
    pub fn load(path: &Path) -> Rotation {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                warn!(file = %path.display(), "no quick-play rotation: {e}");
                return Rotation::default();
            }
        };
        match serde_json::from_str::<Rotation>(&text) {
            Ok(r) => {
                info!(maps = r.maps.len(), modes = r.modes().len(), "quick-play rotation loaded");
                r
            }
            Err(e) => {
                warn!(file = %path.display(), "invalid quick-play rotation: {e}");
                Rotation::default()
            }
        }
    }

    fn mode_meta(&self, id: &str) -> Option<ModeMeta> {
        self.meta.get(id).and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    /// Quick-play modes in order (`qp_1` first).
    pub fn modes(&self) -> Vec<QuickMode> {
        (1..=MAX_MODES)
            .filter_map(|i| {
                let id = format!("qp_{i}");
                self.mode_meta(&id).map(|meta| QuickMode { id, meta })
            })
            .collect()
    }

    pub fn mode(&self, id: &str) -> Option<QuickMode> {
        self.modes().into_iter().find(|m| m.id == id)
    }

    /// Defaults of new custom rooms.
    pub fn custom(&self) -> Option<ModeMeta> {
        self.mode_meta("custom")
    }

    /// Maps of a mode, in rotation order.
    pub fn maps_of(&self, mode: &str) -> Vec<BuiltinMap> {
        self.maps
            .iter()
            .filter(|m| m.modes.iter().any(|x| x == mode))
            .map(|m| BuiltinMap { name: m.name.clone(), code: m.leveldata.clone() })
            .collect()
    }

    /// Adds fresh library maps: team-only maps join the team modes, the rest
    /// the modes without teams. Maps that fail to decode are left out.
    fn with_fresh(mut self, fresh: Vec<RoomMap>) -> Rotation {
        let modes = self.modes();
        let ids = |teams: bool| -> Vec<String> { modes.iter().filter(|m| m.meta.teams == teams).map(|m| m.id.clone()).collect() };
        let (team_ids, free_ids) = (ids(true), ids(false));
        for m in fresh {
            let Ok(data) = neobox_sim::MapData::from_code(&m.code) else { continue };
            let join = if team_only(&data) { &team_ids } else { &free_ids };
            if join.is_empty() {
                continue;
            }
            self.maps.push(RotationMap {
                author: m.author,
                description: m.description,
                leveldata: m.code,
                name: m.name,
                dbid: m.id,
                published: Some(datetime(m.created)),
                modes: join.clone(),
            });
        }
        self
    }
}

/// A map whose objects only make sense in a team mode: red or blue spawns, or capture points.
fn team_only(map: &neobox_sim::MapData) -> bool {
    map.spawns.iter().any(|s| s.teams[2] || s.teams[3]) || !map.caps.is_empty()
}

/// The current rotation (fixed maps plus fresh library maps), built at most
/// once per [`CACHE_TTL`].
pub async fn current(hub: &Hub) -> Arc<Rotation> {
    let mut cache = hub.rotation_cache.lock().await;
    if let Some((at, r)) = cache.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return r.clone();
        }
    }
    let built = Arc::new(build(hub).await);
    *cache = Some((Instant::now(), built.clone()));
    built
}

async fn build(hub: &Hub) -> Rotation {
    if hub.cfg.main_url.is_some() {
        return match hub.backend.rotation().await {
            Ok(r) => r,
            Err(e) => {
                warn!("quick-play rotation from the main server: {e}; using the local file");
                hub.rotation.clone()
            }
        };
    }
    let since = crate::ticket::now() as i64 - FRESH_WINDOW_SECS;
    let fresh = match hub.store() {
        Some(store) => {
            let store = store.clone();
            tokio::task::spawn_blocking(move || store.rotation_picks(since, FRESH_MAPS))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e| e.to_string()))
                .unwrap_or_else(|e| {
                    warn!("fresh rotation maps: {e}");
                    Vec::new()
                })
        }
        None => Vec::new(),
    };
    hub.rotation.clone().with_fresh(fresh)
}

/// `YYYY-MM-DD HH:MM:SS` (UTC) of a unix time, as the original lists it.
pub fn datetime(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(datetime(0), "1970-01-01 00:00:00");
        assert_eq!(datetime(1_709_185_924), "2024-02-29 05:52:04");
        assert_eq!(datetime(1_798_761_599), "2026-12-31 23:59:59");
    }

    #[test]
    fn shipped_rotation() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../maps/rotation/maps2.json");
        let r = Rotation::load(&root);
        let modes = r.modes();
        assert_eq!(modes.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["qp_1", "qp_2"]);
        assert_eq!(modes[0].meta.title, "Sweaty Bois");
        assert_eq!((modes[0].meta.max_players, modes[0].meta.game_mode, modes[0].meta.limit), (4, 2, 2.0));
        assert!(modes[1].meta.teams);
        assert_eq!(r.maps_of("qp_1").len(), 14);
        assert_eq!(r.maps_of("qp_2").len(), 6);
        assert_eq!(r.maps_of("custom").len(), 1);
        for m in &r.maps {
            let data = neobox_sim::MapData::from_code(&m.leveldata).unwrap_or_else(|e| panic!("{}: {e}", m.name));
            for id in &m.modes {
                assert!(!team_only(&data) || r.mode_meta(id).is_some_and(|meta| meta.teams), "{} is team-only but offered in {id}", m.name);
            }
        }
        // library maps: team-only ones join the team modes, the rest the modes without teams
        let golden = r.maps[0].leveldata.clone();
        let twin = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../maps/04-team-fort.json")).unwrap();
        let twin = neobox_sim::MapData::from_json(&serde_json::from_str::<serde_json::Value>(&twin).unwrap()["map"]).unwrap().to_code();
        let fresh = |code: String, id| RoomMap {
            id,
            name: "New".into(),
            author: "me".into(),
            description: String::new(),
            created: 0,
            up: 3,
            down: 0,
            code,
        };
        let r = r.with_fresh(vec![fresh(golden, 7), fresh(twin, 8)]);
        assert_eq!(r.maps_of("qp_1").len(), 15);
        assert_eq!(r.maps_of("qp_2").len(), 7);
    }
}
