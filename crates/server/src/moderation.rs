//! The repeat-spam guard for chat.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::time::{Duration, Instant};

/// Window in which an identical line from the same sender counts as spam.
const REPEAT_WINDOW: Duration = Duration::from_secs(30);
/// Identical lines allowed inside [`REPEAT_WINDOW`]; the next one is refused.
const REPEAT_MAX: usize = 2;

/// Spam guard: refuses the third identical line from one sender within
/// [`REPEAT_WINDOW`]. Refused lines are not recorded.
pub struct RepeatGuard<K> {
    recent: HashMap<K, VecDeque<(String, Instant)>>,
}

impl<K: Eq + Hash + Clone> RepeatGuard<K> {
    pub fn new() -> Self {
        Self { recent: HashMap::new() }
    }

    /// `false` when `text` is refused; `true` when it is allowed and recorded.
    pub fn allow(&mut self, who: &K, text: &str, now: Instant) -> bool {
        let key = repeat_key(text);
        let q = self.recent.entry(who.clone()).or_default();
        while q.front().is_some_and(|(_, t)| now.duration_since(*t) > REPEAT_WINDOW) {
            q.pop_front();
        }
        if q.iter().filter(|(m, _)| *m == key).count() >= REPEAT_MAX {
            return false;
        }
        q.push_back((key, now));
        true
    }
}

impl<K: Eq + Hash + Clone> Default for RepeatGuard<K> {
    fn default() -> Self {
        Self::new()
    }
}

fn repeat_key(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn third_repeat_is_refused_and_window_resets() {
        let mut g = RepeatGuard::new();
        let t0 = Instant::now();
        assert!(g.allow(&1, "hello", t0));
        assert!(g.allow(&1, "Hello  ", t0));
        assert!(!g.allow(&1, "hello", t0 + Duration::from_secs(5)));
        assert!(g.allow(&2, "hello", t0), "another sender is not affected");
        assert!(g.allow(&1, "hello", t0 + Duration::from_secs(31)));
    }
}
