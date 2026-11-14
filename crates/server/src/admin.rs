//! Authenticated admin interface: live view and control of rooms, players,
//! tick rate, latency, bandwidth, match state, logs and map review.

use crate::api::{db, Fail, MapDetailJson, MapJson};
use crate::hub::Hub;
use crate::room::{AdminCmd, RoomCmd};
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use neobox_store::Verdict;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tracing::{info, warn};

const COOKIE: &str = "neobox_admin";
const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/admin", get(page))
        .route("/admin/", get(page))
        .route("/admin/admin.js", get(script))
        .route("/admin/api/login", post(login))
        .route("/admin/api/logout", post(logout))
        .route("/admin/api/session", get(session))
        .route("/admin/api/state", get(state))
        .route("/admin/api/logs", get(logs))
        .route("/admin/api/broadcast", post(broadcast))
        .route("/admin/api/rooms/{code}", post(room_cmd))
        .route("/admin/api/rooms/{code}/view", get(room_view))
        .route("/admin/api/maps", get(all_maps))
        .route("/admin/api/maps/pending", get(pending_maps))
        .route("/admin/api/maps/{id}/code", get(map_code))
        .route("/admin/api/maps/{id}/approve", post(approve_map))
        .route("/admin/api/maps/{id}/reject", post(reject_map))
        .route("/admin/api/maps/{id}/delete", post(remove_map))
        .route("/admin/api/maps/{id}/pick", post(pick_map))
        .route("/admin/api/clips", get(admin_clips))
        .route("/admin/api/clips/{id}/delete", post(admin_delete_clip))
}

async fn page() -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Html(include_str!("admin.html")))
}

async fn script() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], include_str!("admin.js"))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').map(str::trim).find_map(|c| c.strip_prefix(&format!("{COOKIE}=")).map(str::to_string))
}

fn authorized(hub: &Hub, headers: &HeaderMap) -> bool {
    if hub.cfg.admin_password.is_empty() {
        return false;
    }
    let Some(token) = cookie_token(headers) else { return false };
    let mut sessions = hub.admin_sessions.lock().unwrap();
    sessions.retain(|_, t| t.elapsed() < SESSION_TTL);
    sessions.keys().any(|k| constant_time_eq(k.as_bytes(), token.as_bytes()))
}

pub fn client_ip(hub: &Hub, headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    if hub.cfg.trust_proxy {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|s| s.trim().parse().ok())
        {
            return ip;
        }
    }
    peer.ip()
}

#[derive(Deserialize)]
struct LoginBody {
    password: String,
}

async fn login(State(hub): State<Arc<Hub>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(b): Json<LoginBody>) -> Response {
    let ip = client_ip(&hub, &headers, peer);
    if hub.cfg.admin_password.is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE, "admin interface disabled: set NEOBOX_ADMIN_PASSWORD").into_response();
    }
    if !hub.admin_login.allow(ip) {
        warn!(%ip, "admin login rate limited");
        return (StatusCode::TOO_MANY_REQUESTS, "too many attempts, wait a minute").into_response();
    }
    if !constant_time_eq(b.password.as_bytes(), hub.cfg.admin_password.as_bytes()) {
        warn!(%ip, "admin login failed");
        return (StatusCode::UNAUTHORIZED, "wrong password").into_response();
    }
    let token: String = (0..32).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
    hub.admin_sessions.lock().unwrap().insert(token.clone(), Instant::now());
    info!(%ip, "admin login");
    let secure = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https");
    let cookie = format!(
        "{COOKIE}={token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age={}{}",
        SESSION_TTL.as_secs(),
        if secure { "; Secure" } else { "" }
    );
    ([(header::SET_COOKIE, cookie)], "ok").into_response()
}

async fn logout(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    if let Some(t) = cookie_token(&headers) {
        hub.admin_sessions.lock().unwrap().remove(&t);
    }
    ([(header::SET_COOKIE, format!("{COOKIE}=; Path=/admin; Max-Age=0"))], "ok").into_response()
}

/// Whether this browser holds an admin session; the page asks once on load.
async fn session(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "admin": authorized(&hub, &headers) }))
}

async fn state(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    if !authorized(&hub, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let rooms = hub.summaries();
    let players: usize = rooms.iter().map(|r| r.players.len()).sum();
    Json(serde_json::json!({
        "server": {
            "version": env!("CARGO_PKG_VERSION"),
            "uptime_s": hub.started.elapsed().as_secs(),
            "connections": hub.conns.load(std::sync::atomic::Ordering::Relaxed),
            "rooms": rooms.len(),
            "players": players,
            "max_rooms": hub.cfg.max_rooms,
            "max_players": hub.cfg.max_players,
            "bytes_in_per_s": rooms.iter().map(|r| r.bytes_in_per_s).sum::<u64>(),
            "bytes_out_per_s": rooms.iter().map(|r| r.bytes_out_per_s).sum::<u64>(),
        },
        "rooms": rooms,
        "maps": hub.maps.iter().map(|m| &m.name).collect::<Vec<_>>(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct LogQuery {
    since: Option<u64>,
}

async fn logs(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<LogQuery>) -> Response {
    if !authorized(&hub, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(crate::logbuf::since(q.since.unwrap_or(0), 500)).into_response()
}

#[derive(Deserialize)]
struct SayBody {
    text: String,
}

async fn broadcast(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<SayBody>) -> Response {
    if !authorized(&hub, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let rooms: Vec<_> = hub.rooms.lock().unwrap().values().cloned().collect();
    for r in rooms {
        let _ = r.tx.send(RoomCmd::Admin(AdminCmd::Say { text: b.text.clone() }));
    }
    "ok".into_response()
}

async fn room_cmd(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(code): Path<String>, Json(cmd): Json<AdminCmd>) -> Response {
    if !authorized(&hub, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match hub.room(&code) {
        Some(r) => {
            let _ = r.tx.send(RoomCmd::Admin(cmd));
            "ok".into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn room_view(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(code): Path<String>) -> Response {
    if !authorized(&hub, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(r) = hub.room(&code) else { return StatusCode::NOT_FOUND.into_response() };
    let (tx, rx) = oneshot::channel();
    if r.tx.send(RoomCmd::View { reply: tx }).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    match rx.await {
        Ok(Some(bytes)) => ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")], Body::from(bytes)).into_response(),
        _ => StatusCode::NO_CONTENT.into_response(),
    }
}

// Map review: public maps waiting for an admin, and admin decisions on any map.

/// A map in the review queue: its library entry and code size.
#[derive(Serialize)]
struct ReviewMapJson {
    #[serde(flatten)]
    map: MapJson,
    size: i64,
}

async fn pending_maps(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let maps = db(&hub, |s| s.pending()).await?;
    Ok(Json(maps.iter().map(|m| ReviewMapJson { map: MapJson::of(m), size: m.size }).collect::<Vec<_>>()).into_response())
}

/// Maps per page in the admin library.
const ADMIN_PAGE_SIZE: usize = 25;

/// Query for the library: `q` searches map and author names, `page` starts at 0.
#[derive(Deserialize)]
struct LibraryQuery {
    q: Option<String>,
    page: Option<u32>,
}

#[derive(Serialize)]
struct LibraryJson {
    total: i64,
    maps: Vec<MapJson>,
}

/// Every map, any status or visibility, newest first.
async fn all_maps(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<LibraryQuery>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let search = q.q.unwrap_or_default();
    let page = q.page.unwrap_or(0);
    let listing = db(&hub, move |s| s.admin_list(&search, page, ADMIN_PAGE_SIZE)).await?;
    Ok(Json(LibraryJson { total: listing.total, maps: listing.maps.iter().map(MapJson::of).collect() }).into_response())
}

/// The code of any map, whatever its status or visibility.
async fn map_code(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let d = db(&hub, move |s| s.get(id, None, true)).await?;
    Ok(Json(MapDetailJson::of(d, false)).into_response())
}

async fn approve_map(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    moderate_map(&hub, &headers, id, Verdict::Approve).await
}

async fn reject_map(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    moderate_map(&hub, &headers, id, Verdict::Reject).await
}

async fn moderate_map(hub: &Hub, headers: &HeaderMap, id: i64, verdict: Verdict) -> Result<Response, Fail> {
    if !authorized(hub, headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    db(hub, move |s| s.moderate(id, verdict)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Hard-delete any map, approved or not. Admins skip the owner check, so the
/// acting account id is never read; 0 names no account.
async fn remove_map(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    db(&hub, move |s| s.delete_map(0, id, true)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct PickBody {
    pick: bool,
}

/// Staff picks lead the library's "picks" listing; unpicking clears the pick.
async fn pick_map(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>, Json(b): Json<PickBody>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    db(&hub, move |s| s.set_pick(id, b.pick)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// A clip in the admin list: who recorded it, on which map, and when.
#[derive(Serialize)]
struct ClipJson {
    id: i64,
    recorder: String,
    map_name: String,
    created: i64,
    size: i64,
}

#[derive(Deserialize)]
struct ClipsQuery {
    before: Option<i64>,
}

/// Clips newest first, a page at a time; `before` is the last id seen.
async fn admin_clips(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<ClipsQuery>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let clips = db(&hub, move |s| s.clips(q.before, ADMIN_PAGE_SIZE)).await?;
    let out: Vec<ClipJson> = clips
        .into_iter()
        .map(|c| ClipJson { id: c.id, recorder: c.recorder, map_name: c.map_name, created: c.created, size: c.size })
        .collect();
    Ok(Json(out).into_response())
}

async fn admin_delete_clip(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    db(&hub, move |s| s.delete_clip(id)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
