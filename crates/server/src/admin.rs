//! Authenticated admin interface: live view and control of rooms, players,
//! tick rate, latency, bandwidth, match state, logs and map review.

use crate::api::{db, Fail, MapDetailJson, MapJson};
use crate::cluster;
use crate::hub::Hub;
use crate::room::{AdminCmd, RoomCmd};
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use neobox_store::{Error, FeedbackKind, FeedbackStatus, ReportStatus, Verdict, ADMIN_SESSION_TTL};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tracing::{info, warn};

const COOKIE: &str = "neobox_admin";
const SESSION_TTL: Duration = Duration::from_secs(ADMIN_SESSION_TTL as u64);

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
        .route("/admin/api/maps/{id}/preview", get(map_preview))
        .route("/admin/api/maps/{id}/inspect", get(map_inspect))
        .route("/admin/api/maps/{id}/approve", post(approve_map))
        .route("/admin/api/maps/{id}/reject", post(reject_map))
        .route("/admin/api/maps/{id}/delete", post(remove_map))
        .route("/admin/api/maps/{id}/pick", post(pick_map))
        .route("/admin/api/clips", get(admin_clips))
        .route("/admin/api/clips/{id}/delete", post(admin_delete_clip))
        .route("/admin/api/reports", get(reports))
        .route("/admin/api/reports/{id}/status", post(report_status))
        .route("/admin/api/reports/{id}/delete", post(report_delete))
        .route("/admin/api/feedback", get(feedback_list))
        .route("/admin/api/feedback/{id}/status", post(feedback_status))
        .route("/admin/api/feedback/{id}/delete", post(feedback_delete))
        .route("/admin/api/accounts", get(accounts))
        .route("/admin/api/accounts/{id}/password", post(account_password))
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
    // With a store, SQLite is the only session record: it enforces expiry, the
    // session cap and sliding renewal. A RAM copy would outlive all three.
    if let Some(store) = hub.store() {
        return store.check_admin_session(&token, &hub.cfg.admin_password).unwrap_or(false);
    }
    let mut sessions = hub.admin_sessions.lock().unwrap();
    sessions.retain(|_, t| t.elapsed() < SESSION_TTL);
    sessions.keys().any(|k| constant_time_eq(k.as_bytes(), token.as_bytes()))
}

fn admin_cookie(hub: &Hub, peer: SocketAddr, headers: &HeaderMap, value: &str, max_age: i64) -> String {
    let secure = via_trusted_proxy(hub, peer) && headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https");
    format!(
        "{COOKIE}={value}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

/// A JSON body, parsed only once the request is authorized.
fn parse_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, Fail> {
    serde_json::from_slice(body).map_err(|_| Error::Invalid("Malformed body").into())
}

/// Whether this connection came through a proxy whose forwarded headers are
/// believed: `NEOBOX_TRUST_PROXY` is on and the peer is loopback (a proxy on
/// this host) or listed in `NEOBOX_TRUSTED_PROXIES`.
pub fn via_trusted_proxy(hub: &Hub, peer: SocketAddr) -> bool {
    hub.cfg.trust_proxy && is_proxy(hub, peer.ip())
}

fn is_proxy(hub: &Hub, ip: IpAddr) -> bool {
    ip.is_loopback() || hub.cfg.trusted_proxies.contains(&ip)
}

/// The client's address. Behind a trusted proxy it is the rightmost
/// `X-Forwarded-For` entry that is not a proxy: the proxy appends the address it
/// received the request from, so anything to its left is client-chosen. An
/// unparseable entry, or no entry at all, falls back to the peer.
pub fn client_ip(hub: &Hub, headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    if !via_trusted_proxy(hub, peer) {
        return peer.ip();
    }
    forwarded_client(headers, |ip| is_proxy(hub, ip)).unwrap_or(peer.ip())
}

/// The rightmost forwarded address that is not a proxy. `None` when there is
/// none, or when an entry on the way is not an address.
fn forwarded_client(headers: &HeaderMap, is_proxy: impl Fn(IpAddr) -> bool) -> Option<IpAddr> {
    let forwarded: Vec<&str> = headers.get_all("x-forwarded-for").iter().filter_map(|v| v.to_str().ok()).collect();
    for entry in forwarded.join(",").rsplit(',') {
        let ip = entry.trim().parse::<IpAddr>().ok()?;
        if !is_proxy(ip) {
            return Some(ip);
        }
    }
    None
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
    let token = if let Some(store) = hub.store() {
        match store.create_admin_session(&hub.cfg.admin_password) {
            Ok(t) => t,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "could not create session").into_response(),
        }
    } else {
        let t: String = (0..32).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
        hub.admin_sessions.lock().unwrap().insert(t.clone(), Instant::now());
        t
    };
    info!(%ip, "admin login");
    let cookie = admin_cookie(&hub, peer, &headers, &token, ADMIN_SESSION_TTL);
    ([(header::SET_COOKIE, cookie)], "ok").into_response()
}

async fn logout(State(hub): State<Arc<Hub>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    if let Some(t) = cookie_token(&headers) {
        hub.admin_sessions.lock().unwrap().remove(&t);
        if let Some(store) = hub.store() {
            let _ = store.delete_admin_session(&t, &hub.cfg.admin_password);
        }
    }
    let cookie = admin_cookie(&hub, peer, &headers, "", 0);
    ([(header::SET_COOKIE, cookie)], "ok").into_response()
}

/// Whether this browser holds an admin session; the page asks once on load.
/// Refreshes the cookie's 30-day Max-Age when valid so active admins stay logged in.
async fn session(State(hub): State<Arc<Hub>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    let ok = authorized(&hub, &headers);
    if ok {
        if let Some(token) = cookie_token(&headers) {
            let cookie = admin_cookie(&hub, peer, &headers, &token, ADMIN_SESSION_TTL);
            return ([(header::SET_COOKIE, cookie)], Json(serde_json::json!({ "admin": true }))).into_response();
        }
    }
    Json(serde_json::json!({ "admin": false })).into_response()
}

/// The dashboard polls every second; the counts are cached this long so each poll does not run the queries under the database lock.
const COUNTS_TTL: Duration = Duration::from_secs(10);

async fn admin_counts(hub: &Hub) -> neobox_store::AdminCounts {
    let cached = hub.counts.lock().unwrap().as_ref().filter(|(at, _)| at.elapsed() < COUNTS_TTL).map(|(_, c)| c.clone());
    if let Some(c) = cached {
        return c;
    }
    match db(hub, |s| s.admin_counts()).await {
        Ok(c) => {
            *hub.counts.lock().unwrap() = Some((Instant::now(), c.clone()));
            c
        }
        Err(_) => Default::default(),
    }
}

async fn state(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    if !authorized(&hub, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut rooms: Vec<(String, crate::room::RoomSummary)> =
        hub.summaries().into_iter().map(|r| (hub.cfg.region.clone(), r)).collect();
    let mut conns = hub.conns.load(std::sync::atomic::Ordering::Relaxed);
    let live_nodes = cluster::live_nodes(&hub);
    let nodes_json: Vec<serde_json::Value> = live_nodes
        .iter()
        .map(|n| {
            serde_json::json!({
                "region": n.region,
                "url": n.url,
                "connections": n.conns,
                "rooms": n.rooms.len(),
                "players": n.rooms.iter().map(|r| r.players.len()).sum::<usize>(),
            })
        })
        .collect();
    for node in live_nodes {
        conns += node.conns;
        let region = node.region;
        rooms.extend(node.rooms.into_iter().map(|r| (region.clone(), r)));
    }
    let players: usize = rooms.iter().map(|(_, r)| r.players.len()).sum();
    let mut udp_players: usize = 0;
    let mut ws_players: usize = 0;
    let mut pings: Vec<u32> = Vec::with_capacity(players);
    let mut in_match_rooms: usize = 0;
    let mut max_step_us: f64 = 0.0;
    let mut step_sum: f64 = 0.0;
    let mut step_rooms: usize = 0;
    let mut mode_counts: std::collections::BTreeMap<i32, (usize, usize)> = std::collections::BTreeMap::new();
    for (_, r) in &rooms {
        if r.in_match {
            in_match_rooms += 1;
            if r.step_avg_us > 0.0 {
                step_sum += r.step_avg_us;
                step_rooms += 1;
            }
            if r.step_max_us > max_step_us {
                max_step_us = r.step_max_us;
            }
        }
        let entry = mode_counts.entry(r.game_mode).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += r.players.len();
        for p in &r.players {
            if p.transport == "udp" {
                udp_players += 1;
            } else {
                ws_players += 1;
            }
            if p.ping_ms > 0 {
                pings.push(p.ping_ms);
            }
        }
    }
    pings.sort_unstable();
    let avg_ping_ms = if pings.is_empty() { 0.0 } else { pings.iter().map(|&x| x as f64).sum::<f64>() / pings.len() as f64 };
    let p95_ping_ms = if pings.is_empty() { 0 } else { pings[((pings.len() - 1) * 95) / 100] };
    let avg_step_us = if step_rooms == 0 { 0.0 } else { step_sum / step_rooms as f64 };
    let counts = admin_counts(&hub).await;

    let rooms_json: Vec<serde_json::Value> = rooms
        .iter()
        .map(|(region, r)| {
            let mut v = serde_json::to_value(r).unwrap_or_default();
            if let Some(o) = v.as_object_mut() {
                o.insert("region".into(), region.clone().into());
            }
            v
        })
        .collect();
    Json(serde_json::json!({
        "server": {
            "version": env!("CARGO_PKG_VERSION"),
            "uptime_s": hub.started.elapsed().as_secs(),
            "connections": conns,
            "rooms": rooms.len(),
            "players": players,
            "max_rooms": hub.cfg.max_rooms,
            "max_players": hub.cfg.max_players,
            "bytes_in_per_s": rooms.iter().map(|(_, r)| r.bytes_in_per_s).sum::<u64>(),
            "bytes_out_per_s": rooms.iter().map(|(_, r)| r.bytes_out_per_s).sum::<u64>(),
        },
        "insights": {
            "udp_players": udp_players,
            "ws_players": ws_players,
            "avg_ping_ms": avg_ping_ms,
            "p95_ping_ms": p95_ping_ms,
            "in_match_rooms": in_match_rooms,
            "lobby_rooms": rooms.len().saturating_sub(in_match_rooms),
            "avg_step_us": avg_step_us,
            "max_step_us": max_step_us,
            "modes": mode_counts.into_iter().map(|(mode, (rc, pc))| serde_json::json!({ "mode": mode, "rooms": rc, "players": pc })).collect::<Vec<_>>(),
            "counts": counts,
            "nodes": nodes_json,
        },
        "rooms": rooms_json,
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

async fn broadcast(State(hub): State<Arc<Hub>>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&hub, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let b: SayBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let rooms: Vec<_> = hub.rooms.lock().unwrap().values().cloned().collect();
    for r in rooms {
        let _ = r.tx.send(RoomCmd::Admin(AdminCmd::Say { text: b.text.clone() }));
    }
    "ok".into_response()
}

async fn room_cmd(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(code): Path<String>, body: Bytes) -> Response {
    if !authorized(&hub, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let cmd: AdminCmd = match parse_body(&body) {
        Ok(cmd) => cmd,
        Err(e) => return e.into_response(),
    };
    if let AdminCmd::SetTickRate { hz } = &cmd {
        if !neobox_net::valid_tick_hz(*hz) {
            let (min, max) = (neobox_net::TICK_HZ_MIN, neobox_net::TICK_HZ_MAX);
            return (StatusCode::BAD_REQUEST, format!("Tick rate must be between {min} and {max} Hz")).into_response();
        }
    }
    match hub.room(&code) {
        Some(r) => {
            let _ = r.tx.send(RoomCmd::Admin(cmd));
            "ok".into_response()
        }
        None => match cluster::node_with_room(&hub, &code) {
            Some(node) => match cluster::forward_admin(&hub, &node, &code, cmd).await {
                Ok(()) => "ok".into_response(),
                Err(e) => (StatusCode::BAD_GATEWAY, e).into_response(),
            },
            None => StatusCode::NOT_FOUND.into_response(),
        },
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
        Ok(Some((bytes, in_match))) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "no-store"),
                (header::HeaderName::from_static("x-neobox-mode"), if in_match { "match" } else { "lobby" }),
            ],
            Body::from(bytes),
        )
            .into_response(),
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

/// Rendered binary frame buffer preview of any map (works for pending, unlisted and private maps too).
async fn map_preview(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let d = db(&hub, move |s| s.get(id, None, true)).await?;
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, Error> {
        let map = neobox_sim::MapData::from_code(&d.code).map_err(|_| Error::Invalid("Could not decode map"))?;
        let st = neobox_sim::State::from_map(&map);
        let mut fb = neobox_wasm::frame::FrameBuilder::default();
        let meta = neobox_wasm::frame::Meta { tick: 0, local: -1, ..Default::default() };
        fb.build(&st, &st, 1.0, &neobox_sim::GameSettings::default(), meta, &neobox_wasm::frame::Feed::default());
        Ok(fb.words.iter().flat_map(|w| w.to_le_bytes()).collect())
    })
    .await
    .map_err(|e| Error::Internal(e.to_string()))??;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "private, max-age=60"),
        ],
        Body::from(bytes),
    )
        .into_response())
}

/// Full map metadata + geometry/gameplay analysis for the admin Map Inspector (no code copying needed).
async fn map_inspect(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let d = db(&hub, move |s| s.get(id, None, true)).await?;
    let code_size = d.code.len();
    let analysis = match neobox_sim::MapData::from_code(&d.code) {
        Ok(map) => {
            let bodies = map.bodies.len();
            let shapes: usize = map.bodies.iter().map(|(_, b)| b.def.shapes.len()).sum();
            let death_bodies = map.bodies.iter().filter(|(_, b)| b.def.kill_players).count();
            let objective_bodies = map.bodies.iter().filter(|(_, b)| b.def.objective != 0.0).count();
            let checkpoints = map.bodies.iter().filter(|(_, b)| b.def.checkpoint > 0.0).count();
            let dynamic_bodies = map.bodies.iter().filter(|(_, b)| b.def.motion == 2.0).count();
            let scenery_bodies = map.bodies.iter().filter(|(_, b)| b.def.no_physics).count();
            let spawns_ffa = map.spawns.iter().filter(|s| s.teams[1]).count();
            let spawns_red = map.spawns.iter().filter(|s| s.teams[2]).count();
            let spawns_blue = map.spawns.iter().filter(|s| s.teams[3]).count();
            let spawn_points: Vec<serde_json::Value> = map
                .spawns
                .iter()
                .map(|s| serde_json::json!({ "x": s.x, "y": s.y, "ffa": s.teams[1], "red": s.teams[2], "blue": s.teams[3] }))
                .collect();
            let mut warnings: Vec<&'static str> = Vec::new();
            if map.spawns.is_empty() {
                warnings.push("No spawn points — players spawn at default coordinates");
            }
            if spawns_ffa == 0 && (spawns_red > 0 || spawns_blue > 0) {
                warnings.push("Team spawns only (no FFA spawns)");
            }
            if bodies == 0 {
                warnings.push("Map has zero bodies");
            }
            if shapes > 400 {
                warnings.push("High shape count (>400) — check performance on older devices");
            }
            if map.settings.width <= 0.0 || map.settings.height <= 0.0 {
                warnings.push("Arena width/height is zero (unbounded editor map)");
            }
            serde_json::json!({
                "ok": true,
                "arena_w": map.settings.width,
                "arena_h": map.settings.height,
                "view_aspect": map.settings.view_aspect(),
                "wide": map.settings.wide,
                "gravity": map.settings.gravity,
                "wrap": map.settings.wrap,
                "bodies": bodies,
                "shapes": shapes,
                "joints": map.joints.len(),
                "spawns": map.spawns.len(),
                "spawns_ffa": spawns_ffa,
                "spawns_red": spawns_red,
                "spawns_blue": spawns_blue,
                "turrets": map.turrets.len(),
                "caps": map.caps.len(),
                "grapples": map.grapples.len(),
                "death_bodies": death_bodies,
                "objective_bodies": objective_bodies,
                "checkpoints": checkpoints,
                "dynamic_bodies": dynamic_bodies,
                "scenery_bodies": scenery_bodies,
                "spawn_points": spawn_points,
                "warnings": warnings,
            })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string(), "warnings": ["Map failed to decode"] }),
    };
    let detail = MapDetailJson::of(d, false);
    Ok(Json(serde_json::json!({
        "detail": detail,
        "code_size": code_size,
        "analysis": analysis,
    }))
    .into_response())
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
async fn pick_map(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>, body: Bytes) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let b: PickBody = parse_body(&body)?;
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

// Reports and accounts

#[derive(Deserialize)]
struct ReportsQuery {
    status: Option<ReportStatus>,
    before: Option<i64>,
}

/// Reports newest first, a page at a time; `status` filters, `before` is the last id seen.
async fn reports(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<ReportsQuery>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let list = db(&hub, move |s| s.reports(q.status, q.before, ADMIN_PAGE_SIZE)).await?;
    Ok(Json(list).into_response())
}

#[derive(Deserialize)]
struct ReportStatusBody {
    status: ReportStatus,
}

async fn report_status(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>, body: Bytes) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let b: ReportStatusBody = parse_body(&body)?;
    db(&hub, move |s| s.set_report_status(id, b.status)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn report_delete(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    db(&hub, move |s| s.delete_report(id)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct FeedbackQuery {
    kind: Option<FeedbackKind>,
    status: Option<FeedbackStatus>,
    before: Option<i64>,
}

/// Player bug reports and suggestions, newest first, filtered by kind/status and paged by `before`.
async fn feedback_list(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<FeedbackQuery>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let list = db(&hub, move |s| s.list_feedback(q.kind, q.status, q.before, ADMIN_PAGE_SIZE)).await?;
    Ok(Json(list).into_response())
}

#[derive(Deserialize)]
struct FeedbackStatusBody {
    status: FeedbackStatus,
}

async fn feedback_status(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>, body: Bytes) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let b: FeedbackStatusBody = parse_body(&body)?;
    db(&hub, move |s| s.set_feedback_status(id, b.status)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn feedback_delete(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    db(&hub, move |s| s.delete_feedback(id)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct AccountsQuery {
    q: Option<String>,
}

/// Accounts whose name contains `q`, newest first, for the admin search.
async fn accounts(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<AccountsQuery>) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let query = q.q.unwrap_or_default();
    let found = db(&hub, move |s| s.find_accounts(&query, ADMIN_PAGE_SIZE)).await?;
    Ok(Json(found).into_response())
}

#[derive(Deserialize)]
struct PasswordSetBody {
    password: String,
}

/// Set an account's password without the old one; its sessions are signed out.
async fn account_password(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>, body: Bytes) -> Result<Response, Fail> {
    if !authorized(&hub, &headers) {
        return Ok(StatusCode::UNAUTHORIZED.into_response());
    }
    let b: PasswordSetBody = parse_body(&body)?;
    db(&hub, move |s| s.admin_set_password(id, &b.password)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn xff(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for v in values {
            headers.append("x-forwarded-for", HeaderValue::from_str(v).unwrap());
        }
        headers
    }

    fn is_proxy(ip: IpAddr) -> bool {
        ip.is_loopback() || ip == "10.0.0.1".parse::<IpAddr>().unwrap()
    }

    #[test]
    fn the_client_is_the_rightmost_entry_the_proxy_added() {
        // the client sent 6.6.6.6 itself; the proxy appended the address it saw
        let headers = xff(&["6.6.6.6", "9.9.9.9"]);
        assert_eq!(forwarded_client(&headers, is_proxy), Some("9.9.9.9".parse().unwrap()));
        // a proxy in the chain is skipped
        let headers = xff(&["9.9.9.9, 10.0.0.1"]);
        assert_eq!(forwarded_client(&headers, is_proxy), Some("9.9.9.9".parse().unwrap()));
    }

    #[test]
    fn garbage_or_missing_forwarding_gives_no_client() {
        assert_eq!(forwarded_client(&xff(&["9.9.9.9, nope"]), is_proxy), None);
        assert_eq!(forwarded_client(&xff(&[""]), is_proxy), None);
        assert_eq!(forwarded_client(&HeaderMap::new(), is_proxy), None);
    }
}
