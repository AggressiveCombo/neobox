//! Built-in maps: `maps/*.json` files of the form
//! `{"name": "...", "map": <compact Hitbox map JSON>}`, or `*.txt` files
//! containing a Hitbox map code (the file name is the map name).

use crate::hub::BuiltinMap;
use neobox_sim::MapData;
use std::path::Path;
use tracing::{info, warn};

pub fn load(dir: &Path) -> Vec<BuiltinMap> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        warn!(dir = %dir.display(), "maps directory not found: no built-in maps");
        return out;
    };
    let mut files: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    files.sort();
    for f in files {
        let stem = f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let parsed = match f.extension().and_then(|e| e.to_str()) {
            Some("json") => serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| {
                let name = v["name"].as_str().unwrap_or(&stem).to_string();
                MapData::from_json(&v["map"]).ok().map(|m| (name, m.to_code()))
            }),
            Some("txt") => MapData::from_code(text.trim()).ok().map(|_| (stem.clone(), text.trim().to_string())),
            _ => None,
        };
        match parsed {
            Some((name, code)) => out.push(BuiltinMap { name, code }),
            None => warn!(file = %f.display(), "skipping invalid map file"),
        }
    }
    info!(count = out.len(), "built-in maps loaded");
    out
}
