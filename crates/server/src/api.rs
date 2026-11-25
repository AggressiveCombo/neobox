//! JSON API: accounts, friends and the map library. Store calls run on
//! blocking threads: the store holds a mutex and hashes passwords.

use crate::admin::client_ip;
use crate::cluster;
use crate::hub::{AccountRef, Hub, Limiter};
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use neobox_net::level_of;
use neobox_store::{
    Account, Error, FeedbackKind, FriendState, MapDetail, MapSummary, MatchStats, NewFeedback, NewReport, Profile, ProfileMap, Record,
    ReportKind, ReportedMap, Reporter, Sort, Status, Store, Visibility, MAX_CODE_BYTES, SESSION_TTL,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tracing::error;

const COOKIE: &str = "nb_session";
/// Maps per library page.
const PAGE_SIZE: usize = 24;
/// Player profile lookups per address per minute.
static PLAYER_LOOKUPS: LazyLock<Limiter<IpAddr>> = LazyLock::new(|| Limiter::new(120, Duration::from_secs(60)));

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/api/stats", get(stats))
        .route("/api/rotation", get(rotation))
        .route("/api/ticket", get(ticket))
        .route("/api/account/me", get(me))
        .route("/api/account/register", post(register))
        .route("/api/account/login", post(login))
        .route("/api/account/logout", post(logout))
        .route("/api/account/password", post(change_password))
        .route("/api/account/delete", post(delete_account))
        .route("/api/account/prefs", get(get_prefs).put(put_prefs))
        .route("/api/friends", get(friends))
        .route("/api/friends/request", post(friend_request))
        .route("/api/friends/accept", post(friend_accept))
        .route("/api/friends/remove", post(friend_remove))
        .route("/api/library", get(library_list).post(library_upload))
        .route("/api/library/mine", get(library_mine))
        .route("/api/library/makers", get(library_makers))
        .route("/api/library/favourites", get(library_favourites))
        .route("/api/library/{id}", get(library_get).patch(library_update).delete(library_delete))
        .route("/api/library/{id}/vote", post(library_vote))
        .route("/api/library/{id}/favourite", post(library_favourite))
        .route("/api/library/{id}/records", get(library_records))
        .route("/api/report", post(report))
        .route("/api/feedback", post(submit_feedback))
        .route("/api/players/{name}", get(player))
        .layer(DefaultBodyLimit::max(MAX_CODE_BYTES + 64 * 1024))
}

/// An error response: the store's error as a status and `{"error": text}`.
pub struct Fail(Response);

impl Fail {
    fn new(status: StatusCode, msg: &str) -> Fail {
        Fail((status, Json(serde_json::json!({ "error": msg }))).into_response())
    }
}

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        self.0
    }
}

impl From<Error> for Fail {
    fn from(e: Error) -> Fail {
        let status = match &e {
            Error::Invalid(_) | Error::Limit(_) => StatusCode::BAD_REQUEST,
            Error::BadLogin => StatusCode::UNAUTHORIZED,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Forbidden(_) => StatusCode::FORBIDDEN,
            Error::Conflict(_) => StatusCode::CONFLICT,
            Error::Internal(m) => {
                error!(%m, "store failure");
                return Fail::new(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong");
            }
        };
        Fail::new(status, &e.to_string())
    }
}

/// Run a store call on a blocking thread.
pub(crate) async fn db<T: Send + 'static>(
    hub: &Hub,
    f: impl FnOnce(&Store) -> neobox_store::Result<T> + Send + 'static,
) -> Result<T, Fail> {
    let Some(store) = hub.store().cloned() else {
        return Err(Error::Internal("this server keeps no accounts".into()).into());
    };
    let r = tokio::task::spawn_blocking(move || f(&store)).await.map_err(|e| Error::Internal(e.to_string()))?;
    Ok(r?)
}

fn unauthorized() -> Fail {
    Fail::new(StatusCode::UNAUTHORIZED, "Sign in first")
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').map(str::trim).find_map(|c| c.strip_prefix(&format!("{COOKIE}="))).map(str::to_string)
}

fn secure_request(hub: &Hub, headers: &HeaderMap) -> bool {
    hub.cfg.trust_proxy && headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https")
}

/// `max_age`: seconds the browser keeps the cookie; `None` keeps it only until
/// the browser closes (a sign-in without "Stay signed in").
fn session_cookie(hub: &Hub, headers: &HeaderMap, value: &str, max_age: Option<i64>) -> String {
    let secure = if secure_request(hub, headers) { "; Secure" } else { "" };
    let max_age = max_age.map(|s| format!("; Max-Age={s}")).unwrap_or_default();
    format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax{max_age}{secure}")
}

/// The account of the request's session cookie; 401 for guests.
async fn signed_in(hub: &Hub, headers: &HeaderMap) -> Result<Account, Fail> {
    let token = session_token(headers).ok_or_else(unauthorized)?;
    db(hub, move |s| s.session_account(&token)).await?.ok_or_else(unauthorized)
}

/// The id of the request's signed-in account, if any.
async fn viewer(hub: &Hub, headers: &HeaderMap) -> Option<i64> {
    signed_in(hub, headers).await.ok().map(|a| a.id)
}

/// The account behind a WebSocket upgrade's session cookie, if any. Game nodes
/// keep no sessions (signed-in players bring a ticket), so they never look.
pub async fn socket_account(hub: &Hub, headers: &HeaderMap) -> Option<AccountRef> {
    hub.store()?;
    signed_in(hub, headers).await.ok().map(|a| AccountRef { id: a.id, name: a.name })
}

/// Count a sign-in or registration attempt from this address.
fn attempt(hub: &Hub, headers: &HeaderMap, peer: SocketAddr) -> Result<(), Fail> {
    if hub.account_login.allow(client_ip(hub, headers, peer)) {
        Ok(())
    } else {
        Err(Fail::new(StatusCode::TOO_MANY_REQUESTS, "Too many attempts, wait a minute"))
    }
}

/// Start a session for `acc`; answers with its cookie and the account.
/// `remember`: the cookie outlives the browser session.
async fn sign_in(hub: &Hub, headers: &HeaderMap, acc: Account, remember: bool) -> Result<Response, Fail> {
    let id = acc.id;
    let token = db(hub, move |s| s.create_session(id)).await?;
    let xp = db(hub, move |s| s.account_xp(id)).await?;
    let cookie = session_cookie(hub, headers, &token, remember.then_some(SESSION_TTL));
    Ok(([(header::SET_COOKIE, cookie)], Json(AccountJson::new(acc, xp))).into_response())
}

/// Clear the session cookie.
fn signed_out(hub: &Hub, headers: &HeaderMap) -> Response {
    ([(header::SET_COOKIE, session_cookie(hub, headers, "", Some(0)))], StatusCode::NO_CONTENT).into_response()
}

#[derive(Serialize)]
pub struct AccountJson {
    pub id: i64,
    pub name: String,
    pub xp: u64,
    pub level: u32,
}

impl AccountJson {
    fn new(a: Account, xp: u64) -> AccountJson {
        AccountJson { id: a.id, name: a.name, xp, level: level_of(xp) }
    }
}

// Server

#[derive(Serialize)]
struct StatsJson {
    online: usize,
    rooms: usize,
    /// Players by kind of room, like the original's `playercount.json`:
    /// each quick-play mode (`qp_1`, ...), `qp` (all quick play), `custom`
    /// and `total`.
    counts: HashMap<String, usize>,
}

/// Connections, rooms and players per kind of room, for the menus.
async fn stats(State(hub): State<Arc<Hub>>) -> Json<StatsJson> {
    let mut rooms = hub.summaries();
    let mut online = hub.conns.load(Ordering::Relaxed);
    for node in cluster::live_nodes(&hub) {
        online += node.conns;
        rooms.extend(node.rooms);
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for room in &rooms {
        let players = room.players.len();
        match &room.quick {
            Some(mode) => {
                *counts.entry(mode.clone()).or_default() += players;
                *counts.entry("qp".into()).or_default() += players;
            }
            None => *counts.entry("custom".into()).or_default() += players,
        }
        *counts.entry("total".into()).or_default() += players;
    }
    Json(StatsJson { online, rooms: rooms.len(), counts })
}

/// The quick-play modes and their map rotation, in the format of the
/// original's `rotationmaps/maps2.json`.
async fn rotation(State(hub): State<Arc<Hub>>) -> impl IntoResponse {
    let r = crate::rotation::current(&hub).await;
    ([(header::CACHE_CONTROL, "public, max-age=60")], Json(r.as_ref().clone()))
}

// Accounts

/// The signed-in account, or `null` for guests: every page load asks, and a
/// guest is not an error.
async fn me(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Option<AccountJson>>, Fail> {
    let Some(token) = session_token(&headers) else { return Ok(Json(None)) };
    let Some(account) = db(&hub, move |s| s.session_account(&token)).await? else { return Ok(Json(None)) };
    let id = account.id;
    let xp = db(&hub, move |s| s.account_xp(id)).await?;
    Ok(Json(Some(AccountJson::new(account, xp))))
}

#[derive(Deserialize)]
struct Credentials {
    name: String,
    password: String,
    /// "Stay signed in" (off unless asked, like the original).
    #[serde(default)]
    remember: bool,
}

/// A short-lived ticket naming the signed-in account, for regional game nodes.
async fn ticket(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, Fail> {
    if hub.cfg.cluster_secret.is_empty() {
        return Err(Error::NotFound.into());
    }
    let account = signed_in(&hub, &headers).await?;
    let id = account.id;
    let xp = db(&hub, move |s| s.account_xp(id)).await?;
    let who = AccountRef { id, name: account.name };
    let token = crate::ticket::issue(&hub.cfg.cluster_secret, &who, xp, crate::ticket::now());
    Ok(Json(serde_json::json!({ "ticket": token })))
}

async fn register(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<Credentials>,
) -> Result<Response, Fail> {
    attempt(&hub, &headers, peer)?;
    let acc = db(&hub, move |s| s.register(&b.name, &b.password)).await?;
    sign_in(&hub, &headers, acc, b.remember).await
}

async fn login(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<Credentials>,
) -> Result<Response, Fail> {
    attempt(&hub, &headers, peer)?;
    let acc = db(&hub, move |s| s.login(&b.name, &b.password)).await?;
    sign_in(&hub, &headers, acc, b.remember).await
}

async fn logout(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Response, Fail> {
    if let Some(token) = session_token(&headers) {
        db(&hub, move |s| s.delete_session(&token)).await?;
    }
    Ok(signed_out(&hub, &headers))
}

#[derive(Deserialize)]
struct PasswordBody {
    old: String,
    new: String,
    /// Whether this browser's session was "Stay signed in" (the client remembers its choice).
    #[serde(default)]
    remember: bool,
}

/// Signing out every session on a password change, so this one is issued again.
async fn change_password(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<PasswordBody>) -> Result<Response, Fail> {
    let acc = signed_in(&hub, &headers).await?;
    let id = acc.id;
    db(&hub, move |s| s.change_password(id, &b.old, &b.new)).await?;
    sign_in(&hub, &headers, acc, b.remember).await
}

#[derive(Deserialize)]
struct PasswordOnly {
    password: String,
}

async fn delete_account(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<PasswordOnly>) -> Result<Response, Fail> {
    let id = signed_in(&hub, &headers).await?.id;
    db(&hub, move |s| s.delete_account(id, &b.password)).await?;
    Ok(signed_out(&hub, &headers))
}

async fn get_prefs(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Response, Fail> {
    let id = signed_in(&hub, &headers).await?.id;
    let json = db(&hub, move |s| s.get_prefs(id)).await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], json).into_response())
}

/// The body is stored as sent once the store has checked it is a JSON object.
async fn put_prefs(State(hub): State<Arc<Hub>>, headers: HeaderMap, body: Bytes) -> Result<StatusCode, Fail> {
    let id = signed_in(&hub, &headers).await?.id;
    let json = String::from_utf8(body.to_vec()).map_err(|_| Error::Invalid("Preferences must be UTF-8"))?;
    db(&hub, move |s| s.set_prefs(id, &json)).await?;
    Ok(StatusCode::NO_CONTENT)
}

// Friends

#[derive(Serialize, Clone)]
struct RoomRef {
    code: String,
    name: String,
}

#[derive(Serialize)]
struct FriendJson {
    name: String,
    state: &'static str,
    online: bool,
    room: Option<RoomRef>,
}

/// Friends with their presence. Pending requests show no presence or room.
async fn friends(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Vec<FriendJson>>, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    let list = db(&hub, move |s| s.friends(me)).await?;
    let nodes = cluster::live_nodes(&hub);
    let mut rooms: HashMap<i64, RoomRef> = HashMap::new();
    for r in hub.summaries().into_iter().chain(nodes.iter().flat_map(|n| n.rooms.iter().cloned())) {
        for p in r.players.iter().filter(|p| p.connected) {
            if let Some(id) = p.account {
                rooms.entry(id).or_insert_with(|| RoomRef { code: r.code.clone(), name: r.name.clone() });
            }
        }
    }
    let node_online: HashSet<i64> = nodes.iter().flat_map(|n| n.online.iter().copied()).collect();
    let out = list
        .into_iter()
        .map(|f| {
            let id = f.account.id;
            let is_friend = f.state == FriendState::Friend;
            FriendJson {
                name: f.account.name,
                state: match f.state {
                    FriendState::Friend => "friend",
                    FriendState::Incoming => "incoming",
                    FriendState::Outgoing => "outgoing",
                },
                online: is_friend && (hub.is_online(id) || node_online.contains(&id)),
                room: if is_friend { rooms.get(&id).cloned() } else { None },
            }
        })
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn friend_request(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<NameBody>) -> Result<StatusCode, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    db(&hub, move |s| s.request(me, &b.name)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn friend_accept(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<NameBody>) -> Result<StatusCode, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    db(&hub, move |s| s.accept(me, &b.name)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn friend_remove(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<NameBody>) -> Result<StatusCode, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    db(&hub, move |s| s.remove(me, &b.name)).await?;
    Ok(StatusCode::NO_CONTENT)
}

// Library

/// A map as the library lists it; `my_vote` and `favourite` only for signed-in viewers.
#[derive(Serialize)]
pub struct MapJson {
    pub id: i64,
    pub name: String,
    pub author: String,
    pub votes: i64,
    pub plays: i64,
    pub created: String,
    pub visibility: &'static str,
    pub status: &'static str,
    pub description: String,
    pub pick: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_vote: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favourite: Option<bool>,
}

impl MapJson {
    pub fn of(m: &MapSummary) -> MapJson {
        MapJson {
            id: m.id,
            name: m.name.clone(),
            author: m.author.name.clone(),
            votes: m.score,
            plays: m.plays,
            created: iso_time(m.created),
            visibility: visibility_name(m.visibility),
            status: status_name(m.status),
            description: m.description.clone(),
            pick: m.pick > 0,
            my_vote: None,
            favourite: None,
        }
    }
}

/// A map with its code.
#[derive(Serialize)]
pub struct MapDetailJson {
    #[serde(flatten)]
    pub map: MapJson,
    pub code: String,
}

impl MapDetailJson {
    /// `signed_in`: whether the viewer has an account, which decides if their vote and star are shown.
    pub fn of(d: MapDetail, signed_in: bool) -> MapDetailJson {
        let mut map = MapJson::of(&d.map);
        if signed_in {
            map.my_vote = Some(d.vote);
            map.favourite = Some(d.favourite);
        }
        MapDetailJson { map, code: d.code }
    }
}

/// Library maps as JSON, with the viewer's vote and star on each when signed in.
async fn maps_json(hub: &Hub, viewer: Option<i64>, maps: Vec<MapSummary>) -> Result<Vec<MapJson>, Fail> {
    let mut out: Vec<MapJson> = maps.iter().map(MapJson::of).collect();
    if let Some(me) = viewer {
        let ids: Vec<i64> = maps.iter().map(|m| m.id).collect();
        let marks = db(hub, move |s| s.marks(me, &ids)).await?;
        for m in &mut out {
            let (vote, favourite) = marks.get(&m.id).copied().unwrap_or((0, false));
            m.my_vote = Some(vote);
            m.favourite = Some(favourite);
        }
    }
    Ok(out)
}

fn visibility_name(v: Visibility) -> &'static str {
    match v {
        Visibility::Public => "public",
        Visibility::Unlisted => "unlisted",
        Visibility::Private => "private",
    }
}

fn status_name(s: Status) -> &'static str {
    match s {
        Status::Pending => "pending",
        Status::Approved => "approved",
        Status::Rejected => "rejected",
    }
}

fn parse_visibility(s: &str) -> Result<Visibility, Fail> {
    Ok(match s {
        "public" => Visibility::Public,
        "unlisted" => Visibility::Unlisted,
        "private" => Visibility::Private,
        _ => return Err(Error::Invalid("Unknown visibility").into()),
    })
}

/// `2026-11-13T12:00:00Z` for unix seconds (UTC).
pub fn iso_time(secs: i64) -> String {
    let days = secs.div_euclid(86_400) + 719_468;
    let rem = secs.rem_euclid(86_400);
    // civil date from day count (Howard Hinnant's algorithm)
    let era = days.div_euclid(146_097);
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn parse_sort(s: Option<&str>) -> Result<Sort, Fail> {
    match s {
        None | Some("new") => Ok(Sort::New),
        Some("top") => Ok(Sort::Top),
        Some("plays") => Ok(Sort::Plays),
        Some("hot") => Ok(Sort::Hot),
        Some("picks") => Ok(Sort::Picks),
        Some(_) => Err(Error::Invalid("Unknown sort").into()),
    }
}

#[derive(Deserialize)]
struct ListQuery {
    sort: Option<String>,
    q: Option<String>,
    page: Option<u32>,
}

async fn library_list(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<ListQuery>) -> Result<Json<Vec<MapJson>>, Fail> {
    let sort = parse_sort(q.sort.as_deref())?;
    let search = q.q.unwrap_or_default();
    let page = q.page.unwrap_or(0);
    let listing = db(&hub, move |s| s.list(sort, &search, page, PAGE_SIZE)).await?;
    let me = viewer(&hub, &headers).await;
    Ok(Json(maps_json(&hub, me, listing.maps).await?))
}

async fn library_mine(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Vec<MapJson>>, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    let maps = db(&hub, move |s| s.mine(me)).await?;
    Ok(Json(maps_json(&hub, Some(me), maps).await?))
}

#[derive(Serialize)]
struct MakerJson {
    name: String,
    score: i64,
}

/// The makers with the most upvotes and plays this week.
async fn library_makers(State(hub): State<Arc<Hub>>) -> Result<Json<Vec<MakerJson>>, Fail> {
    let makers = db(&hub, |s| s.top_makers(Store::activity_since(), 5)).await?;
    Ok(Json(makers.into_iter().map(|(name, score)| MakerJson { name, score }).collect()))
}

async fn library_favourites(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Vec<MapJson>>, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    let maps = db(&hub, move |s| s.favourites(me)).await?;
    Ok(Json(maps_json(&hub, Some(me), maps).await?))
}

#[derive(Deserialize)]
struct UploadBody {
    name: String,
    description: String,
    code: String,
    visibility: String,
}

async fn library_upload(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<UploadBody>) -> Result<Response, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    if !hub.uploads.allow(me) {
        return Err(Fail::new(StatusCode::TOO_MANY_REQUESTS, "Too many uploads, try again later"));
    }
    let visibility = parse_visibility(&b.visibility)?;
    let id = db(&hub, move |s| s.upload(me, &b.name, &b.code, visibility, &b.description)).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response())
}

async fn library_get(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Json<MapDetailJson>, Fail> {
    let me = viewer(&hub, &headers).await;
    let d = db(&hub, move |s| s.get(id, me, false)).await?;
    Ok(Json(MapDetailJson::of(d, me.is_some())))
}

/// Fastest Times: a library map's best time per player, fastest first.
async fn library_records(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Json<Vec<Record>>, Fail> {
    let me = viewer(&hub, &headers).await;
    let rows = db(&hub, move |s| s.records(id, me, false)).await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct PatchBody {
    name: Option<String>,
    description: Option<String>,
    visibility: Option<String>,
    code: Option<String>,
}

/// Fields left out keep their current value.
async fn library_update(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<PatchBody>,
) -> Result<StatusCode, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    let visibility = b.visibility.as_deref().map(parse_visibility).transpose()?;
    db(&hub, move |s| {
        let cur = s.get(id, Some(me), false)?;
        let name = b.name.unwrap_or(cur.map.name);
        let description = b.description.unwrap_or(cur.map.description);
        s.update(me, id, &name, b.code.as_deref(), visibility.unwrap_or(cur.map.visibility), &description)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn library_delete(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<StatusCode, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    db(&hub, move |s| s.delete_map(me, id, false)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct VoteBody {
    v: i64,
}

async fn library_vote(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>, Json(b): Json<VoteBody>) -> Result<StatusCode, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    db(&hub, move |s| s.vote(me, id, b.v)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct FavouriteBody {
    on: bool,
}

async fn library_favourite(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<FavouriteBody>,
) -> Result<StatusCode, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    db(&hub, move |s| s.favourite(me, id, b.on)).await?;
    Ok(StatusCode::NO_CONTENT)
}

// Players

#[derive(Serialize)]
struct PlayerJson {
    name: String,
    level: u32,
    xp: u64,
    joined: String,
    /// The appearance colour (0xRRGGBB) the player shows in rooms; null when unset.
    color: Option<u32>,
    stats: MatchStats,
    friends: i64,
    published: i64,
    maps: Vec<ProfileMap>,
    records: i64,
}

impl PlayerJson {
    fn new(p: Profile, color: Option<u32>) -> PlayerJson {
        PlayerJson {
            name: p.name,
            level: level_of(p.xp),
            xp: p.xp,
            joined: iso_time(p.joined),
            color,
            stats: p.stats,
            friends: p.friends,
            published: p.published,
            maps: p.maps,
            records: p.records,
        }
    }
}

/// The appearance colour from a player's stored preferences (already public: rooms show it).
fn pref_color(prefs: &str) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_str(prefs).ok()?;
    let c = v.get("color")?.as_u64()?;
    u32::try_from(c).ok().filter(|c| *c <= 0xff_ffff)
}

/// A player's public profile by name (ignoring case). Guests have none.
async fn player(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<PlayerJson>, Fail> {
    if !PLAYER_LOOKUPS.allow(client_ip(&hub, &headers, peer)) {
        return Err(Fail::new(StatusCode::TOO_MANY_REQUESTS, "Too many lookups, try again later"));
    }
    let found = db(&hub, move |s| {
        let Some(p) = s.profile(&name)? else { return Ok(None) };
        let color = pref_color(&s.get_prefs(p.id)?);
        Ok(Some((p, color)))
    })
    .await?;
    let Some((p, color)) = found else {
        return Err(Fail::new(StatusCode::NOT_FOUND, "No such player"));
    };
    Ok(Json(PlayerJson::new(p, color)))
}

// Reports

/// A report from the client: a player in a room, or a map. A map is named by
/// the room it is played in, or by its library id for a report made outside
/// any room.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ReportBody {
    Player { room: String, player: u32, reason: String },
    Map { room: Option<String>, map: Option<i64>, reason: String },
}

/// File a report on a player or a map, with the evidence the room's server keeps
/// or the library's record of the map. Guests may report; each address is limited
/// in how many it files.
async fn report(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<ReportBody>,
) -> Result<StatusCode, Fail> {
    let ip = client_ip(&hub, &headers, peer);
    if !hub.reports.allow(ip) {
        return Err(Fail::new(StatusCode::TOO_MANY_REQUESTS, "Too many reports, try again later"));
    }
    let reporter = match signed_in(&hub, &headers).await {
        Ok(acc) => Reporter { account: Some(acc.id), name: acc.name, ip: ip.to_string() },
        Err(_) => Reporter { account: None, name: "Guest".to_string(), ip: ip.to_string() },
    };
    let report = match b {
        ReportBody::Player { room, player, reason } => room_report(&hub, &room, Some(player), reason, reporter).await?,
        ReportBody::Map { room: Some(room), map: None, reason } => room_report(&hub, &room, None, reason, reporter).await?,
        ReportBody::Map { room: None, map: Some(map), reason } => library_map_report(&hub, map, reason, reporter).await?,
        ReportBody::Map { .. } => {
            return Err(Fail::new(StatusCode::BAD_REQUEST, "A map report names either a room or a library map"));
        }
    };
    db(&hub, move |s| s.create_report(&report)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A report on a player or the map of a room, from the room's own evidence.
async fn room_report(hub: &Hub, room: &str, player: Option<u32>, reason: String, reporter: Reporter) -> Result<NewReport, Fail> {
    let ev = cluster::room_evidence(hub, room, player)
        .await
        .map_err(|e| {
            error!("report evidence: {e}");
            Fail::new(StatusCode::BAD_GATEWAY, "The room's server did not answer")
        })?
        .ok_or_else(|| Fail::new(StatusCode::NOT_FOUND, "That room is closed"))?;
    let (kind, player) = match player {
        Some(_) => {
            let player = ev.player.ok_or_else(|| Fail::new(StatusCode::NOT_FOUND, "That player left the room"))?;
            (ReportKind::Player, Some(player))
        }
        None => (ReportKind::Map, None),
    };
    Ok(NewReport { kind, reason, reporter, room_code: ev.room_code, room_name: ev.room_name, player, map: Some(ev.map), chat: ev.chat })
}

/// A report on a library map, made from outside any room. The map is named as the library has it.
async fn library_map_report(hub: &Hub, id: i64, reason: String, reporter: Reporter) -> Result<NewReport, Fail> {
    let viewer = reporter.account;
    let map = db(hub, move |s| s.map_meta(id, viewer)).await?;
    Ok(NewReport {
        kind: ReportKind::Map,
        reason,
        reporter,
        room_code: String::new(),
        room_name: String::new(),
        player: None,
        map: Some(ReportedMap { id: Some(map.id), name: map.name, author: map.author }),
        chat: Vec::new(),
    })
}

// Player feedback (bug reports & feature suggestions)

#[derive(Deserialize)]
struct FeedbackBody {
    kind: FeedbackKind,
    message: String,
    #[serde(default)]
    screen: String,
    #[serde(default)]
    context: String,
    #[serde(default)]
    name: String,
}

async fn submit_feedback(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<FeedbackBody>,
) -> Result<StatusCode, Fail> {
    let ip = client_ip(&hub, &headers, peer);
    if !hub.feedback.allow(ip) {
        return Err(Fail::new(StatusCode::TOO_MANY_REQUESTS, "Too many submissions, please try again shortly"));
    }
    let (author_account, author_name) = match signed_in(&hub, &headers).await {
        Ok(acc) => (Some(acc.id), acc.name),
        Err(_) => {
            let clean = b.name.trim();
            (None, if clean.is_empty() { "Guest".to_string() } else { clean.chars().take(32).collect() })
        }
    };
    let entry = NewFeedback {
        kind: b.kind,
        message: b.message,
        screen: b.screen,
        context: b.context,
        author_account,
        author_name,
        author_ip: ip.to_string(),
    };
    db(&hub, move |s| s.create_feedback(&entry)).await?;
    Ok(StatusCode::NO_CONTENT)
}
