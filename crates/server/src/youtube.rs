//! YouTube links in chat: spotting a bare link (jukebox suggestions) and
//! fetching a video's title from YouTube's public oEmbed endpoint.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

const ID_LEN: usize = 11;
/// Largest oEmbed reply we read; a real one is a few hundred bytes.
const MAX_BODY: usize = 64 * 1024;
const TITLE_CHARS: usize = 100;
/// Titles kept in memory; the cache is emptied when it fills up.
const CACHE_CAP: usize = 500;

static CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("HTTP client with rustls")
});

/// The video id when `text` is nothing but a YouTube link to one video:
/// `youtube.com/watch?v=ID` (other query parameters allowed), `youtu.be/ID`,
/// `youtube.com/embed/ID` or `youtube.com/shorts/ID`, on the www, m or music
/// hosts too, with or without `http(s)://`. Any other text in the line makes it
/// no link.
pub fn video_id(text: &str) -> Option<String> {
    let link = text.trim();
    if link.is_empty() || link.contains(char::is_whitespace) {
        return None;
    }
    let rest = strip_scheme(link);
    let (host, path) = match rest.find(['/', '?', '#']) {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let path = path.split_once('#').map_or(path, |(before, _)| before);
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    match host.to_ascii_lowercase().as_str() {
        "youtu.be" => to_id(route.strip_prefix('/')?),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            if let Some(id) = route.strip_prefix("/embed/").or_else(|| route.strip_prefix("/shorts/")) {
                to_id(id)
            } else if route == "/watch" {
                query.split('&').find_map(|pair| pair.strip_prefix("v=")).and_then(to_id)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// The title of a YouTube video (`video` is the 11-character id), or None if
/// it cannot be fetched. Titles are cached for the life of the process; a
/// failed lookup is not cached, so it is retried next time.
pub async fn title(video: &str) -> Option<String> {
    let id = to_id(video)?;
    if let Some(cached) = lock_cache().get(&id) {
        return Some(cached.clone());
    }
    let url = format!("https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={id}&format=json");
    let mut res = CLIENT.get(url.as_str()).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.ok()? {
        if body.len() + chunk.len() > MAX_BODY {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let title: String = value["title"].as_str()?.trim().chars().take(TITLE_CHARS).collect();
    if title.is_empty() {
        return None;
    }
    let mut cache = lock_cache();
    if cache.len() >= CACHE_CAP {
        cache.clear();
    }
    cache.insert(id, title.clone());
    Some(title)
}

fn lock_cache() -> MutexGuard<'static, HashMap<String, String>> {
    // A panic while holding the lock leaves a valid map behind, so keep using it.
    CACHE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `link` without a leading `https://` or `http://` (any letter case).
fn strip_scheme(link: &str) -> &str {
    for scheme in ["https://", "http://"] {
        if link.get(..scheme.len()).is_some_and(|head| head.eq_ignore_ascii_case(scheme)) {
            return &link[scheme.len()..];
        }
    }
    link
}

/// Whether `id` has the shape of a YouTube video id: exactly 11 characters of
/// `[A-Za-z0-9_-]`.
pub fn valid_id(id: &str) -> bool {
    id.len() == ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `id` as an owned string if it has the shape of a YouTube video id.
fn to_id(id: &str) -> Option<String> {
    valid_id(id).then(|| id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{title, video_id};

    const ID: &str = "dQw4w9WgXcQ";

    #[test]
    fn finds_id_in_link_forms() {
        let cases = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "http://youtube.com/watch?v=dQw4w9WgXcQ",
            "youtube.com/watch?v=dQw4w9WgXcQ",
            "www.youtube.com/watch?v=dQw4w9WgXcQ",
            "HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s",
            "https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
            "youtube.com/watch?list=PL123&v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "youtu.be/dQw4w9WgXcQ?si=abc_DEF-123",
            "https://youtu.be/dQw4w9WgXcQ#t=10",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "  https://youtu.be/dQw4w9WgXcQ  ",
        ];
        for case in cases {
            assert_eq!(video_id(case).as_deref(), Some(ID), "{case}");
        }
    }

    #[test]
    fn id_may_use_dash_and_underscore() {
        assert_eq!(video_id("youtu.be/-_-_-_-_-_-").as_deref(), Some("-_-_-_-_-_-"));
    }

    #[test]
    fn rejects_text_that_is_not_only_a_link() {
        let cases = [
            "",
            "   ",
            "check this https://youtu.be/dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ thanks",
            "https://youtu.be/dQw4w9WgXcQ\nhi",
            "hello",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com@evil.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com:8443/watch?v=dQw4w9WgXcQ",
            "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch",
            "https://youtube.com/watch?v=",
            "https://youtube.com/watch?v=short",
            "https://youtube.com/watch?v=dQw4w9WgXcQ!",
            "https://youtube.com/watch?v=dQw4w9WgXc!Q",
            "https://youtube.com/watch/?v=dQw4w9WgXcQ",
            "https://youtube.com/channel/dQw4w9WgXcQ",
            "https://youtube.com/playlist?list=PL123",
            "https://youtube.com/embed/dQw4w9WgXcQ/extra",
            "https://youtu.be/dQw4w9WgXcQ/extra",
            "https://youtu.be/",
            "https://youtu.be/dQw4w9WgXc",
            "https://youtu.be/dQw4w9WgXcQQ",
        ];
        for case in cases {
            assert_eq!(video_id(case), None, "{case}");
        }
    }

    #[tokio::test]
    async fn title_rejects_malformed_ids_without_fetching() {
        assert_eq!(title("").await, None);
        assert_eq!(title("../../etc/passwd").await, None);
        assert_eq!(title("dQw4w9WgXcQ&x=1").await, None);
    }

    #[tokio::test]
    async fn title_is_served_from_cache() {
        let id = "TESTCACHE01";
        super::lock_cache().insert(id.to_owned(), "Cached title".to_owned());
        assert_eq!(title(id).await.as_deref(), Some("Cached title"));
    }
}
