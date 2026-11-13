//! In-memory ring buffer of recent log lines for the admin interface.

use std::collections::VecDeque;
use std::fmt::Write;
use std::sync::Mutex;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

const CAPACITY: usize = 4000;

#[derive(serde::Serialize, Clone)]
pub struct LogLine {
    pub seq: u64,
    pub time_ms: u64,
    pub level: &'static str,
    pub target: String,
    pub text: String,
}

struct Ring {
    seq: u64,
    lines: VecDeque<LogLine>,
}

static RING: Mutex<Ring> = Mutex::new(Ring { seq: 0, lines: VecDeque::new() });

/// Lines with `seq > since`, oldest first (at most `limit`).
pub fn since(since: u64, limit: usize) -> Vec<LogLine> {
    let r = RING.lock().unwrap();
    let skip = r.lines.iter().take_while(|l| l.seq <= since).count();
    r.lines.iter().skip(skip).take(limit).cloned().collect()
}

struct Fields(String);

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.push_str(value);
        } else {
            let _ = write!(self.0, " {}={value}", field.name());
        }
    }
}

pub struct RingLayer;

impl<S: Subscriber> Layer<S> for RingLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut f = Fields(String::new());
        event.record(&mut f);
        let time_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let mut r = RING.lock().unwrap();
        r.seq += 1;
        let seq = r.seq;
        r.lines.push_back(LogLine {
            seq,
            time_ms,
            level: event.metadata().level().as_str(),
            target: event.metadata().target().to_string(),
            text: f.0,
        });
        while r.lines.len() > CAPACITY {
            r.lines.pop_front();
        }
    }
}
