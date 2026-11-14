//! Clips: short replays of recorded matches (cut on the client with /record),
//! uploaded here and played behind the main menu.

use crate::admin::client_ip;
use crate::api::{db, socket_account, Fail};
use crate::hub::{Hub, Limiter};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use neobox_net::{valid_name, Replay, ReplayError};
use neobox_store::{Error, MAX_CLIP_BYTES, MAX_MAP_NAME_CHARS};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

/// Longest accepted clip, seconds. Clips are cut at 15 s; the slack covers
/// rounding of the cut on the client.
const MAX_CLIP_SECS: f64 = 20.0;
/// Clips per page of the listing (the menu's page size).
const PAGE_SIZE: usize = 10;
/// Clip uploads per address per hour.
static UPLOADS: LazyLock<Limiter<IpAddr>> = LazyLock::new(|| Limiter::new(5, Duration::from_secs(3600)));

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/api/clips", get(list).post(upload))
        .route("/api/clips/{id}", get(get_clip))
        .layer(DefaultBodyLimit::max(MAX_CLIP_BYTES + 64 * 1024))
}

#[derive(Deserialize)]
struct UploadBody {
    /// The replay's JSON text.
    replay: String,
    map_name: String,
    /// The recorder's name when signed out (signed-in players are named by
    /// their account).
    name: Option<String>,
}

async fn upload(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<UploadBody>,
) -> Result<Response, Response> {
    if !UPLOADS.allow(client_ip(&hub, &headers, peer)) {
        let body = serde_json::json!({ "error": "Too many clips, try again later" });
        return Err((StatusCode::TOO_MANY_REQUESTS, Json(body)).into_response());
    }
    let (recorder, account) = match socket_account(&hub, &headers).await {
        Some(a) => (a.name, Some(a.id)),
        None => {
            let name = b.name.unwrap_or_default();
            if !valid_name(&name) {
                return Err(Fail::from(Error::Invalid("Pick a valid name to record under")).into_response());
            }
            (name, None)
        }
    };
    let map_name = b.map_name.trim().to_string();
    if map_name.is_empty() || map_name.chars().count() > MAX_MAP_NAME_CHARS {
        return Err(Fail::from(Error::Invalid("Map name is missing or too long")).into_response());
    }
    let replay = Replay::from_json(b.replay.as_bytes()).map_err(|e| {
        let message = match e {
            ReplayError::Version(_) => "Unknown replay version",
            _ => "Bad replay",
        };
        Fail::from(Error::Invalid(message)).into_response()
    })?;
    let hz = replay.start.tick_hz;
    let ticks = replay.decode_ticks().map_err(|_| Fail::from(Error::Invalid("Bad replay")).into_response())?;
    if !(hz > 0.0) || ticks.len() as f64 > MAX_CLIP_SECS * hz {
        return Err(Fail::from(Error::Invalid("Clip is too long")).into_response());
    }
    let data = b.replay.into_bytes();
    let id = db(&hub, move |s| s.add_clip(account, &recorder, &map_name, &data)).await.map_err(IntoResponse::into_response)?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response())
}

#[derive(Deserialize)]
struct ListQuery {
    /// Only clips with ids below this (the last id of the previous page).
    before: Option<i64>,
}

#[derive(Serialize)]
struct ClipJson {
    id: i64,
    recorder: String,
    map_name: String,
    created: i64,
    size: i64,
}

async fn list(State(hub): State<Arc<Hub>>, Query(q): Query<ListQuery>) -> Result<Json<Vec<ClipJson>>, Fail> {
    let clips = db(&hub, move |s| s.clips(q.before, PAGE_SIZE)).await?;
    Ok(Json(
        clips
            .into_iter()
            .map(|c| ClipJson { id: c.id, recorder: c.recorder, map_name: c.map_name, created: c.created, size: c.size })
            .collect(),
    ))
}

async fn get_clip(State(hub): State<Arc<Hub>>, Path(id): Path<i64>) -> Result<Response, Fail> {
    let data = db(&hub, move |s| s.clip_data(id)).await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], data).into_response())
}
