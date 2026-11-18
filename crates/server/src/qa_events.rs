//! The server's own record of a match, for the gameplay instrument (client/qa/gameplay.mjs). Set
//! `NEOBOX_QA_EVENTS` to a file path and every match appends JSON lines to it: the players, each bat
//! hit and KO with the tick the clients label them with, and the final kills, lives and elimination
//! order. Off unless the variable is set; nothing is recorded or cloned otherwise.

use neobox_sim::State;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::Write;

pub struct EventLog {
    file: File,
    names: Vec<(u32, String)>,
}

impl EventLog {
    /// A log for a match of `players` (id, name), when `NEOBOX_QA_EVENTS` names a file.
    pub fn open(players: Vec<(u32, String)>) -> Option<Self> {
        let path = std::env::var_os("NEOBOX_QA_EVENTS")?;
        let file = OpenOptions::new().create(true).append(true).open(&path).ok()?;
        let mut log = EventLog { file, names: players };
        let players: Vec<Value> = log.names.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect();
        log.line(json!({ "ev": "start", "players": players }));
        Some(log)
    }

    /// The hits and KOs of the step that took `prev` to `cur`, labelled with `tick` (the tick of `cur`,
    /// as the clients label the confirmed states they feed).
    pub fn record(&mut self, tick: u32, prev: &State, cur: &State) {
        let mut hits = Vec::new();
        neobox_wasm::frame::new_hits(prev, cur, Some(tick), &mut hits);
        for h in hits.chunks_exact(4) {
            let (by, kind, index) = (h[0], h[1], h[2]);
            self.line(json!({ "ev": "hit", "tick": h[3], "by": self.name(by), "kind": kind, "victim": self.victim(kind, index), "index": index }));
        }
        let mut kos = Vec::new();
        neobox_wasm::frame::new_kills(tick, prev, cur, &mut kos);
        for k in kos.chunks_exact(3) {
            self.line(json!({ "ev": "ko", "tick": k[2], "by": self.name(k[0]), "victim": self.name(k[1]) }));
        }
    }

    /// The final record: each player's kills, lives left and elimination order (the scoreboard's columns).
    pub fn finish(&mut self, state: &State, reason: &str) {
        let players: Vec<Value> = self
            .names
            .iter()
            .map(|(id, name)| {
                let r = state.round.players.get(*id);
                json!({
                    "id": id,
                    "name": name,
                    "kills": r.map_or(0.0, |r| r.kills),
                    "lives": r.map_or(0.0, |r| r.lives),
                    "eliminated": r.map_or(-1.0, |r| r.eliminated),
                })
            })
            .collect();
        self.line(json!({ "ev": "end", "reason": reason, "tick": state.round.ticks, "players": players }));
    }

    /// Victim label for a bat hit, worded as the HUD words it (scoreboard.ts record): player hits name the player.
    fn victim(&self, kind: u32, index: u32) -> String {
        match kind {
            neobox_sim::step::kind::PLAYER => self.name(index),
            neobox_sim::step::kind::BODY => "a body".into(),
            _ => "a projectile".into(),
        }
    }

    fn name(&self, id: u32) -> String {
        self.names.iter().find(|(i, _)| *i == id).map_or_else(|| format!("#{id}"), |(_, n)| n.clone())
    }

    fn line(&mut self, v: Value) {
        let _ = writeln!(self.file, "{v}");
    }
}
