//! Server-side proxy for Hitbox.io's public map search and browse endpoints.
//!
//! Browsers never contact hitbox.io directly (keeping CSP `connect-src 'self'`
//! intact and avoiding leaking player IPs to a third party). Only the query,
//! sort, search scope and pagination offset are forwarded upstream, and raw
//! Hitbox response fields (`authorname`, `leveldata`, `vu`, `vd`,
//! `publisheddate`) are translated at this boundary into descriptive names.

use neobox_store::MAX_CODE_BYTES;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// Hitbox returns 32 maps per page across search and browse endpoints.
pub const PAGE_SIZE: usize = 32;
/// Hard ceiling on upstream pagination offset.
const MAX_OFFSET: usize = 3200;
/// Maximum search query length (characters).
const MAX_QUERY_CHARS: usize = 50;
/// Maximum upstream HTTP body accepted (32 large art maps can reach several MB).
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// How long successful upstream pages stay cached in memory.
const CACHE_TTL: Duration = Duration::from_secs(120);
/// Maximum cached pages kept in memory.
const CACHE_CAP: usize = 64;

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("HTTP client with rustls")
});

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CacheKey {
    base: String,
    query: String,
    sort: HitboxSort,
    by: HitboxSearchBy,
    offset: usize,
}

struct CachedPage {
    at: Instant,
    page: HitboxPage,
}

static CACHE: LazyLock<Mutex<HashMap<CacheKey, CachedPage>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_cache() -> MutexGuard<'static, HashMap<CacheKey, CachedPage>> {
    CACHE.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HitboxSort {
    #[default]
    Hot,
    Top,
    New,
    Picks,
    Best,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HitboxSearchBy {
    #[default]
    Both,
    Name,
    Author,
}

#[derive(Clone, Debug, Deserialize)]
pub struct HitboxQuery {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub sort: HitboxSort,
    #[serde(default)]
    pub by: HitboxSearchBy,
    #[serde(default)]
    pub offset: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HitboxMap {
    pub id: i64,
    pub name: String,
    pub author: String,
    pub description: String,
    pub upvotes: i64,
    pub downvotes: i64,
    pub published: String,
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HitboxPage {
    pub maps: Vec<HitboxMap>,
    pub more: bool,
    pub next_offset: Option<usize>,
}

#[derive(Debug)]
pub enum HitboxError {
    Disabled,
    Upstream(String),
}

impl std::fmt::Display for HitboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HitboxError::Disabled => write!(f, "Hitbox.io search is disabled on this server"),
            HitboxError::Upstream(msg) => write!(f, "{msg}"),
        }
    }
}

/// Fetch one page of maps from Hitbox.io (or a configured test base URL).
pub async fn fetch_maps(base_url: &str, params: &HitboxQuery) -> Result<HitboxPage, HitboxError> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(HitboxError::Disabled);
    }

    let query: String = params.q.trim().chars().take(MAX_QUERY_CHARS).collect();
    let offset = params.offset.min(MAX_OFFSET);
    let sort = if !query.is_empty() {
        match params.sort {
            HitboxSort::New => HitboxSort::New,
            _ => HitboxSort::Best,
        }
    } else {
        match params.sort {
            HitboxSort::Best => HitboxSort::Hot,
            other => other,
        }
    };
    let by = if query.is_empty() { HitboxSearchBy::Both } else { params.by };

    // Picks is a single static list on Hitbox with no further pages.
    if query.is_empty() && sort == HitboxSort::Picks && offset > 0 {
        return Ok(HitboxPage { maps: Vec::new(), more: false, next_offset: None });
    }

    let key = CacheKey { base: base.to_string(), query: query.clone(), sort, by, offset };
    if let Some(hit) = cached_get(&key) {
        return Ok(hit);
    }

    let response = if !query.is_empty() {
        let search_author = matches!(by, HitboxSearchBy::Both | HitboxSearchBy::Author);
        let search_name = matches!(by, HitboxSearchBy::Both | HitboxSearchBy::Name);
        let search_sort = if sort == HitboxSort::New { "newest" } else { "best" };
        let offset_str = offset.to_string();
        let form = [
            ("startingfrom", offset_str.as_str()),
            ("searchauthor", if search_author { "true" } else { "false" }),
            ("searchmapname", if search_name { "true" } else { "false" }),
            ("searchsort", search_sort),
            ("searchstring", query.as_str()),
        ];
        CLIENT
            .post(format!("{base}/scripts/map_get_search_spice.php"))
            .form(&form)
            .send()
            .await
    } else {
        match sort {
            HitboxSort::Hot | HitboxSort::Best => CLIENT.get(format!("{base}/scripts/hotmaps/hotcache_4_{offset}.json")).send().await,
            HitboxSort::Top => CLIENT.get(format!("{base}/scripts/topmaps/topratedcache_2024_{offset}.json")).send().await,
            HitboxSort::New => {
                let offset_str = offset.to_string();
                CLIENT
                    .post(format!("{base}/scripts/map_get_newest_spice.php"))
                    .form(&[("startingfrom", offset_str.as_str())])
                    .send()
                    .await
            }
            HitboxSort::Picks => CLIENT.post(format!("{base}/scripts/hotmaps/picks.txt")).send().await,
        }
    };

    let mut res = response.map_err(|_| HitboxError::Upstream("Could not reach Hitbox.io right now.".into()))?;
    if !res.status().is_success() {
        return Err(HitboxError::Upstream("Hitbox.io did not answer right now.".into()));
    }

    let mut body = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|_| HitboxError::Upstream("Hitbox.io closed the connection early.".into()))?
    {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(HitboxError::Upstream("Hitbox.io returned a response that was too large.".into()));
        }
        body.extend_from_slice(&chunk);
    }

    let page = parse_response(&body, offset, sort == HitboxSort::Picks && query.is_empty())?;
    cached_put(key, page.clone());
    Ok(page)
}

fn parse_response(body: &[u8], offset: usize, is_picks: bool) -> Result<HitboxPage, HitboxError> {
    let raw: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| HitboxError::Upstream("Hitbox.io returned an unexpected reply.".into()))?;
    if raw.get("r").and_then(|v| v.as_str()) != Some("success") {
        let msg = match raw.get("e").and_then(|v| v.as_str()) {
            Some("invalid_options") => "Choose map name or author to search.",
            _ => "Hitbox.io refused that search.",
        };
        return Err(HitboxError::Upstream(msg.into()));
    }

    let items = raw.get("maps").and_then(|v| v.as_array()).map(Vec::as_slice).unwrap_or(&[]);
    let mut maps = Vec::with_capacity(items.len());
    for entry in items {
        let Some(code) = entry.get("leveldata").and_then(|v| v.as_str()).map(str::trim) else {
            continue;
        };
        if code.is_empty() || code.len() > MAX_CODE_BYTES {
            continue;
        }
        let id = value_i64(entry.get("id")).unwrap_or(0);
        let name = clean_text(entry.get("name").and_then(|v| v.as_str()), 120, "Untitled");
        let author = clean_text(entry.get("authorname").and_then(|v| v.as_str()), 60, "Unknown");
        let description = clean_text(entry.get("description").and_then(|v| v.as_str()), 600, "");
        let upvotes = value_i64(entry.get("vu")).unwrap_or(0).max(0);
        let downvotes = value_i64(entry.get("vd")).unwrap_or(0).max(0);
        let published = clean_text(entry.get("publisheddate").and_then(|v| v.as_str()), 40, "");
        maps.push(HitboxMap {
            id,
            name,
            author,
            description,
            upvotes,
            downvotes,
            published,
            code: code.to_string(),
        });
    }

    let more = !is_picks && value_bool(raw.get("more")) && offset + PAGE_SIZE <= MAX_OFFSET;
    let next_offset = more.then_some(offset + PAGE_SIZE);
    Ok(HitboxPage { maps, more, next_offset })
}

fn clean_text(raw: Option<&str>, max_chars: usize, fallback: &str) -> String {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

fn value_i64(v: Option<&serde_json::Value>) -> Option<i64> {
    match v? {
        serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn value_bool(v: Option<&serde_json::Value>) -> bool {
    match v {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(serde_json::Value::String(s)) => matches!(s.trim(), "true" | "1"),
        _ => false,
    }
}

fn cached_get(key: &CacheKey) -> Option<HitboxPage> {
    let mut cache = lock_cache();
    if let Some(entry) = cache.get(key) {
        if entry.at.elapsed() < CACHE_TTL {
            return Some(entry.page.clone());
        }
        cache.remove(key);
    }
    None
}

fn cached_put(key: CacheKey, page: HitboxPage) {
    let mut cache = lock_cache();
    let now = Instant::now();
    if cache.len() >= CACHE_CAP {
        cache.retain(|_, v| now.duration_since(v.at) < CACHE_TTL);
    }
    if cache.len() >= CACHE_CAP {
        if let Some(oldest) = cache.iter().min_by_key(|(_, v)| v.at).map(|(k, _)| k.clone()) {
            cache.remove(&oldest);
        }
    }
    cache.insert(key, CachedPage { at: now, page });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use axum::{Form, Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::net::TcpListener;

    async fn mock_hitbox() -> (String, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_search = hits.clone();
        let hits_hot = hits.clone();
        let app = Router::new()
            .route(
                "/scripts/map_get_search_spice.php",
                post(move |Form(form): Form<HashMap<String, String>>| {
                    let hits = hits_search.clone();
                    async move {
                        hits.fetch_add(1, Ordering::Relaxed);
                        let q = form.get("searchstring").cloned().unwrap_or_default();
                        let sort = form.get("searchsort").cloned().unwrap_or_default();
                        let by_author = form.get("searchauthor").cloned().unwrap_or_default();
                        let by_name = form.get("searchmapname").cloned().unwrap_or_default();
                        let start = form.get("startingfrom").cloned().unwrap_or_default();
                        Json(serde_json::json!({
                            "r": "success",
                            "more": true,
                            "maps": [
                                {
                                    "id": "42",
                                    "name": format!("{q} ({sort}:{by_name}/{by_author}@{start})"),
                                    "authorname": "Chaz",
                                    "description": "Classic arena",
                                    "leveldata": "eJztwTEBAAAAwqD1T20ND6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwN4A0AAAQ%3D%3D",
                                    "vu": "150",
                                    "vd": 12,
                                    "publisheddate": "2024-01-02 03:04:05"
                                },
                                {
                                    "id": 99,
                                    "name": "Missing data",
                                    "authorname": "Nobody",
                                    "leveldata": ""
                                }
                            ]
                        }))
                    }
                }),
            )
            .route(
                "/scripts/hotmaps/hotcache_4_0.json",
                get(move || {
                    let hits = hits_hot.clone();
                    async move {
                        hits.fetch_add(1, Ordering::Relaxed);
                        Json(serde_json::json!({
                            "r": "success",
                            "more": false,
                            "maps": [
                                {
                                    "id": 7,
                                    "name": "Hot Arena",
                                    "authorname": "Maker",
                                    "leveldata": "abc123",
                                    "vu": 99,
                                    "vd": 3,
                                    "publisheddate": "2024-05-01"
                                }
                            ]
                        }))
                    }
                }),
            )
            .route(
                "/scripts/hotmaps/picks.txt",
                post(|| async {
                    Json(serde_json::json!({
                        "r": "success",
                        "maps": [
                            { "id": 1, "name": "Ice factory", "authorname": "Chaz", "leveldata": "xyz789", "vu": 500, "vd": 10 }
                        ]
                    }))
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), hits)
    }

    #[tokio::test]
    async fn search_forwards_form_params_filters_empty_and_caches() {
        let (base, hits) = mock_hitbox().await;
        let q = HitboxQuery {
            q: "simple arena".into(),
            sort: HitboxSort::New,
            by: HitboxSearchBy::Author,
            offset: 32,
        };
        let page = fetch_maps(&base, &q).await.unwrap();
        assert_eq!(page.maps.len(), 1);
        assert_eq!(page.maps[0].id, 42);
        assert_eq!(page.maps[0].name, "simple arena (newest:false/true@32)");
        assert_eq!(page.maps[0].author, "Chaz");
        assert_eq!(page.maps[0].upvotes, 150);
        assert_eq!(page.maps[0].downvotes, 12);
        assert!(page.more);
        assert_eq!(page.next_offset, Some(64));
        assert_eq!(hits.load(Ordering::Relaxed), 1);

        // Second identical request hits cache instead of upstream.
        let cached = fetch_maps(&base, &q).await.unwrap();
        assert_eq!(cached, page);
        assert_eq!(hits.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn browse_hot_and_picks_work_and_picks_has_one_page() {
        let (base, _) = mock_hitbox().await;
        let hot = fetch_maps(&base, &HitboxQuery { q: String::new(), sort: HitboxSort::Hot, by: HitboxSearchBy::Both, offset: 0 })
            .await
            .unwrap();
        assert_eq!(hot.maps.len(), 1);
        assert_eq!(hot.maps[0].name, "Hot Arena");
        assert!(!hot.more);

        let picks = fetch_maps(&base, &HitboxQuery { q: String::new(), sort: HitboxSort::Picks, by: HitboxSearchBy::Both, offset: 0 })
            .await
            .unwrap();
        assert_eq!(picks.maps.len(), 1);
        assert_eq!(picks.maps[0].name, "Ice factory");
        assert!(!picks.more);

        let picks_p2 = fetch_maps(&base, &HitboxQuery { q: String::new(), sort: HitboxSort::Picks, by: HitboxSearchBy::Both, offset: 32 })
            .await
            .unwrap();
        assert!(picks_p2.maps.is_empty());
        assert!(!picks_p2.more);
    }

    #[tokio::test]
    async fn empty_base_url_disables_search() {
        let err = fetch_maps("", &HitboxQuery { q: "test".into(), sort: HitboxSort::Best, by: HitboxSearchBy::Both, offset: 0 })
            .await
            .unwrap_err();
        assert!(matches!(err, HitboxError::Disabled));
    }
}
