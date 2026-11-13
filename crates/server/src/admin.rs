//! Authenticated admin interface: live view and control of rooms, players,
//! tick rate, latency, bandwidth, match state and logs.

use crate::hub::Hub;
use crate::room::{AdminCmd, RoomCmd};
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
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
        .route("/admin/api/login", post(login))
        .route("/admin/api/logout", post(logout))
        .route("/admin/api/state", get(state))
        .route("/admin/api/logs", get(logs))
        .route("/admin/api/broadcast", post(broadcast))
        .route("/admin/api/rooms/{code}", post(room_cmd))
        .route("/admin/api/rooms/{code}/view", get(room_view))
}

async fn page() -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Html(include_str!("admin.html")))
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
    {
        let mut attempts = hub.login_attempts.lock().unwrap();
        let list = attempts.entry(ip).or_default();
        list.retain(|t| t.elapsed() < Duration::from_secs(60));
        if list.len() >= 5 {
            warn!(%ip, "admin login rate limited");
            return (StatusCode::TOO_MANY_REQUESTS, "too many attempts, wait a minute").into_response();
        }
        list.push(Instant::now());
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
