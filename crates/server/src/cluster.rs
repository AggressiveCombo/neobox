//! Regional game nodes. The main server keeps a registry of the nodes that
//! beat at it; a node reports every [`BEAT_EVERY`] (and at once when a room
//! is created or closes). Both sides talk over the `/internal` API, which
//! checks the cluster secret (bearer token).

use crate::backend::{Backend, MapCommandBody, RecordBody, StatsBody, XpBody};
use crate::geo::distance_km;
use crate::hub::Hub;
use crate::room::{gather_evidence, AdminCmd, Evidence, RoomCmd, RoomSummary};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// A node that has not beaten for this long is forgotten.
const NODE_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a node reports to the main server.
const BEAT_EVERY: Duration = Duration::from_secs(2);

/// What a game node last reported to the main server.
#[derive(Clone, Debug)]
pub struct NodeInfo {
    pub region: String,
    pub country: Option<String>,
    pub url: String,
    pub location: Option<(f64, f64)>,
    pub conns: usize,
    pub rooms: Vec<RoomSummary>,
    pub online: Vec<i64>,
    pub seen: Instant,
}

/// A node's heartbeat body. Its public URL identifies it.
#[derive(Serialize, Deserialize)]
pub struct Beat {
    pub region: String,
    #[serde(default)]
    pub country: Option<String>,
    pub url: String,
    pub location: Option<[f64; 2]>,
    pub conns: usize,
    pub rooms: Vec<RoomSummary>,
    pub online: Vec<i64>,
}

#[derive(Deserialize)]
struct AdminBody {
    room: String,
    cmd: AdminCmd,
}

#[derive(Deserialize)]
struct ViewerQuery {
    viewer: Option<i64>,
}

/// Where a new room runs: this server or a live node.
pub enum Site {
    Local,
    Node(NodeInfo),
}

/// The nodes that beat within [`NODE_TIMEOUT`], copied out of the registry.
pub fn live_nodes(hub: &Hub) -> Vec<NodeInfo> {
    let mut nodes = hub.nodes.lock().unwrap();
    nodes.retain(|url, n| {
        let live = n.seen.elapsed() < NODE_TIMEOUT;
        if !live {
            info!(node = %url, region = %n.region, "game node left (no heartbeat)");
        }
        live
    });
    nodes.values().cloned().collect()
}

/// The live node that runs room `code`, if any.
pub fn node_with_room(hub: &Hub, code: &str) -> Option<NodeInfo> {
    let code = code.to_ascii_uppercase();
    live_nodes(hub).into_iter().find(|n| n.rooms.iter().any(|r| r.code == code))
}

/// The server nearest `viewer` among this one and the live nodes. This server
/// when the viewer or this server's location is unknown.
pub fn nearest_site(hub: &Hub, viewer: Option<(f64, f64)>) -> Site {
    let (Some(v), Some(here)) = (viewer, hub.cfg.location) else { return Site::Local };
    let mut best = (distance_km(v, here), Site::Local);
    for node in live_nodes(hub) {
        let Some(loc) = node.location else { continue };
        let d = distance_km(v, loc);
        if d < best.0 {
            best = (d, Site::Node(node));
        }
    }
    best.1
}

/// Constant-time bearer check. Refused outright when no cluster secret is set.
fn authorized(hub: &Hub, headers: &HeaderMap) -> bool {
    let secret = hub.cfg.cluster_secret.as_bytes();
    let Some(token) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    !secret.is_empty() && same(token.as_bytes(), secret)
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn denied() -> Response {
    StatusCode::UNAUTHORIZED.into_response()
}

fn failed(msg: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn done() -> Response {
    Json(serde_json::json!({})).into_response()
}

/// The `/internal` API, served by the main server and by game nodes.
pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/internal/heartbeat", post(heartbeat))
        .route("/internal/xp", post(xp))
        .route("/internal/records", post(records))
        .route("/internal/stats", post(stats))
        .route("/internal/map-command", post(map_command))
        .route("/internal/maps/{id}", get(room_map))
        .route("/internal/maps/{id}/play", post(record_play))
        .route("/internal/admin", post(admin))
        .route("/internal/evidence", post(evidence))
}

async fn heartbeat(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<Beat>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    let country = b.country.or_else(|| crate::geo::region_country(&b.region));
    let info = NodeInfo {
        region: b.region,
        country,
        location: b.location.map(|[lat, lon]| (lat, lon)),
        conns: b.conns,
        rooms: b.rooms,
        online: b.online,
        seen: Instant::now(),
        url: b.url.clone(),
    };
    let (url, region) = (b.url, info.region.clone());
    let old = hub.nodes.lock().unwrap().insert(url.clone(), info);
    if old.is_none_or(|o| o.seen.elapsed() >= NODE_TIMEOUT) {
        info!(node = %url, region = %region, "game node joined");
    }
    done()
}

async fn xp(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<XpBody>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    match hub.backend.grant_xp(b.account, b.amount).await {
        Ok(grant) => Json(grant).into_response(),
        Err(e) => failed(e),
    }
}

async fn records(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<RecordBody>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    match hub.backend.save_record(b).await {
        Ok(new_best) => Json(new_best).into_response(),
        Err(e) => failed(e),
    }
}

async fn stats(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<StatsBody>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    match hub.backend.record_stats(b.account, b.stats).await {
        Ok(()) => Json(()).into_response(),
        Err(e) => failed(e),
    }
}

async fn map_command(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<MapCommandBody>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    match hub.backend.map_command(b).await {
        Ok(()) => done(),
        Err(e) => failed(e),
    }
}

async fn room_map(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>, Query(q): Query<ViewerQuery>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    match hub.backend.room_map(id, q.viewer).await {
        Ok(map) => Json(map).into_response(),
        Err(e) => failed(e),
    }
}

async fn record_play(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    match hub.backend.record_play(id).await {
        Ok(()) => done(),
        Err(e) => failed(e),
    }
}

async fn admin(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<AdminBody>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    match hub.room(&b.room) {
        Some(r) => {
            let _ = r.tx.send(RoomCmd::Admin(b.cmd));
            done()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The HTTP client for calls to game nodes.
fn node_http() -> &'static reqwest::Client {
    static HTTP: std::sync::LazyLock<reqwest::Client> =
        std::sync::LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default());
    &HTTP
}

/// The evidence of `room` for a report: from this server's room, or from the
/// node that runs it. `Ok(None)` when no live room has that code.
pub async fn room_evidence(hub: &Hub, room: &str, player: Option<u32>) -> Result<Option<Evidence>, String> {
    if let Some(handle) = hub.room(room) {
        return Ok(gather_evidence(&handle, player).await);
    }
    let Some(node) = node_with_room(hub, room) else {
        return Ok(None);
    };
    let body = serde_json::to_vec(&serde_json::json!({ "room": room, "player": player })).unwrap_or_default();
    let resp = node_http()
        .post(format!("{}/internal/evidence", node.url))
        .bearer_auth(&hub.cfg.cluster_secret)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    match resp.status() {
        StatusCode::NOT_FOUND => Ok(None),
        s if s.is_success() => {
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string())
        }
        s => Err(format!("node answered {s}")),
    }
}

#[derive(Deserialize)]
struct EvidenceBody {
    room: String,
    player: Option<u32>,
}

async fn evidence(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<EvidenceBody>) -> Response {
    if !authorized(&hub, &headers) {
        return denied();
    }
    let Some(handle) = hub.room(&b.room) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match gather_evidence(&handle, b.player).await {
        Some(ev) => Json(ev).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Send an admin command to the node that runs `room`, with the cluster secret.
pub async fn forward_admin(hub: &Hub, node: &NodeInfo, room: &str, cmd: AdminCmd) -> Result<(), String> {
    let body = serde_json::to_vec(&serde_json::json!({ "room": room, "cmd": cmd })).unwrap_or_default();
    let resp = node_http()
        .post(format!("{}/internal/admin", node.url))
        .bearer_auth(&hub.cfg.cluster_secret)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("node answered {}", resp.status()))
    }
}

/// On a game node: report to the main server every [`BEAT_EVERY`], or at once
/// when a room is created or closes. A no-op on the main server.
pub fn spawn_heartbeat(hub: Arc<Hub>) {
    let Backend::Remote(remote) = &hub.backend else { return };
    let url = remote.url("/internal/heartbeat");
    let secret = remote.secret.clone();
    let http = remote.http.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(BEAT_EVERY);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = hub.beat.notified() => {}
            }
            let beat = Beat {
                region: hub.cfg.region.clone(),
                country: hub.server_country(),
                url: hub.cfg.public_url.clone(),
                location: hub.cfg.location.map(|(lat, lon)| [lat, lon]),
                conns: hub.conns.load(Ordering::Relaxed),
                rooms: hub.summaries(),
                online: hub.online.lock().unwrap().iter().filter(|(_, n)| **n > 0).map(|(id, _)| *id).collect(),
            };
            let sent = http
                .post(&url)
                .bearer_auth(&secret)
                .header(header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(&beat).unwrap_or_default())
                .send()
                .await;
            match sent {
                Ok(resp) if resp.status().is_success() => {}
                Ok(resp) => warn!(status = %resp.status(), "the main server refused a heartbeat"),
                Err(e) => debug!("the main server cannot be reached: {e}"),
            }
        }
    });
}

/// A game node redirects every path it does not serve to the main server (303).
pub async fn to_main(State(hub): State<Arc<Hub>>, uri: Uri) -> Response {
    let main = hub.cfg.main_url.clone().unwrap_or_default();
    let path = uri.path_and_query().map_or("/", |p| p.as_str());
    Redirect::to(&format!("{main}{path}")).into_response()
}
