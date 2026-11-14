//! JSON API: accounts, friends and the map library. Store calls run on
//! blocking threads: the store holds a mutex and hashes passwords.

use crate::admin::client_ip;
use crate::hub::{AccountRef, Hub};
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use neobox_store::{
    Account, Error, FriendState, MapDetail, MapSummary, Sort, Status, Store, Visibility, MAX_CODE_BYTES, SESSION_TTL,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::error;

const COOKIE: &str = "nb_session";
/// Maps per library page.
const PAGE_SIZE: usize = 24;

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
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
        .route("/api/library/favourites", get(library_favourites))
        .route("/api/library/{id}", get(library_get).patch(library_update).delete(library_delete))
        .route("/api/library/{id}/vote", post(library_vote))
        .route("/api/library/{id}/favourite", post(library_favourite))
        .route("/api/library/{id}/play", post(library_play))
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
    let store = hub.store.clone();
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

fn session_cookie(hub: &Hub, headers: &HeaderMap, value: &str, max_age: i64) -> String {
    let secure = if secure_request(hub, headers) { "; Secure" } else { "" };
    format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}")
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

/// The account behind a WebSocket upgrade's session cookie, if any.
pub async fn socket_account(hub: &Hub, headers: &HeaderMap) -> Option<AccountRef> {
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
async fn sign_in(hub: &Hub, headers: &HeaderMap, acc: Account) -> Result<Response, Fail> {
    let id = acc.id;
    let token = db(hub, move |s| s.create_session(id)).await?;
    let cookie = session_cookie(hub, headers, &token, SESSION_TTL);
    Ok(([(header::SET_COOKIE, cookie)], Json(AccountJson::from(acc))).into_response())
}

/// Clear the session cookie.
fn signed_out(hub: &Hub, headers: &HeaderMap) -> Response {
    ([(header::SET_COOKIE, session_cookie(hub, headers, "", 0))], StatusCode::NO_CONTENT).into_response()
}

#[derive(Serialize)]
pub struct AccountJson {
    pub id: i64,
    pub name: String,
}

impl From<Account> for AccountJson {
    fn from(a: Account) -> AccountJson {
        AccountJson { id: a.id, name: a.name }
    }
}

// Accounts

/// The signed-in account, or `null` for guests: every page load asks, and a
/// guest is not an error.
async fn me(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Option<AccountJson>>, Fail> {
    let Some(token) = session_token(&headers) else { return Ok(Json(None)) };
    let account = db(&hub, move |s| s.session_account(&token)).await?;
    Ok(Json(account.map(AccountJson::from)))
}

#[derive(Deserialize)]
struct Credentials {
    name: String,
    password: String,
}

async fn register(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<Credentials>,
) -> Result<Response, Fail> {
    attempt(&hub, &headers, peer)?;
    let acc = db(&hub, move |s| s.register(&b.name, &b.password)).await?;
    sign_in(&hub, &headers, acc).await
}

async fn login(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<Credentials>,
) -> Result<Response, Fail> {
    attempt(&hub, &headers, peer)?;
    let acc = db(&hub, move |s| s.login(&b.name, &b.password)).await?;
    sign_in(&hub, &headers, acc).await
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
}

/// Signing out every session on a password change, so this one is issued again.
async fn change_password(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<PasswordBody>) -> Result<Response, Fail> {
    let acc = signed_in(&hub, &headers).await?;
    let id = acc.id;
    db(&hub, move |s| s.change_password(id, &b.old, &b.new)).await?;
    sign_in(&hub, &headers, acc).await
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
    let mut rooms: HashMap<i64, RoomRef> = HashMap::new();
    for r in hub.summaries() {
        for p in r.players.iter().filter(|p| p.connected) {
            if let Some(id) = p.account {
                rooms.entry(id).or_insert_with(|| RoomRef { code: r.code.clone(), name: r.name.clone() });
            }
        }
    }
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
                online: is_friend && hub.is_online(id),
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

/// A map as the library lists it.
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
        }
    }
}

/// A map with its code; `my_vote` and `favourite` are for signed-in viewers.
#[derive(Serialize)]
pub struct MapDetailJson {
    #[serde(flatten)]
    pub map: MapJson,
    pub code: String,
    pub my_vote: Option<i64>,
    pub favourite: bool,
}

impl MapDetailJson {
    /// `signed_in`: whether the viewer has an account, which decides if their vote is shown.
    pub fn of(d: MapDetail, signed_in: bool) -> MapDetailJson {
        let my_vote = signed_in.then_some(d.vote);
        MapDetailJson { map: MapJson::of(&d.map), code: d.code, my_vote, favourite: d.favourite }
    }
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
        Some(_) => Err(Error::Invalid("Unknown sort").into()),
    }
}

#[derive(Deserialize)]
struct ListQuery {
    sort: Option<String>,
    q: Option<String>,
    page: Option<u32>,
}

async fn library_list(State(hub): State<Arc<Hub>>, Query(q): Query<ListQuery>) -> Result<Json<Vec<MapJson>>, Fail> {
    let sort = parse_sort(q.sort.as_deref())?;
    let search = q.q.unwrap_or_default();
    let page = q.page.unwrap_or(0);
    let listing = db(&hub, move |s| s.list(sort, &search, page, PAGE_SIZE)).await?;
    Ok(Json(listing.maps.iter().map(MapJson::of).collect()))
}

async fn library_mine(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Vec<MapJson>>, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    let maps = db(&hub, move |s| s.mine(me)).await?;
    Ok(Json(maps.iter().map(MapJson::of).collect()))
}

async fn library_favourites(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Vec<MapJson>>, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    let maps = db(&hub, move |s| s.favourites(me)).await?;
    Ok(Json(maps.iter().map(MapJson::of).collect()))
}

#[derive(Deserialize)]
struct UploadBody {
    name: String,
    code: String,
    visibility: String,
}

async fn library_upload(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(b): Json<UploadBody>) -> Result<Response, Fail> {
    let me = signed_in(&hub, &headers).await?.id;
    if !hub.uploads.allow(me) {
        return Err(Fail::new(StatusCode::TOO_MANY_REQUESTS, "Too many uploads, try again later"));
    }
    let visibility = parse_visibility(&b.visibility)?;
    let id = db(&hub, move |s| s.upload(me, &b.name, &b.code, visibility)).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response())
}

async fn library_get(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Json<MapDetailJson>, Fail> {
    let me = viewer(&hub, &headers).await;
    let d = db(&hub, move |s| s.get(id, me, false)).await?;
    Ok(Json(MapDetailJson::of(d, me.is_some())))
}

#[derive(Deserialize)]
struct PatchBody {
    name: Option<String>,
    visibility: Option<String>,
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
        s.update(me, id, &name, None, visibility.unwrap_or(cur.map.visibility))
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

async fn library_play(State(hub): State<Arc<Hub>>, Path(id): Path<i64>) -> Result<StatusCode, Fail> {
    db(&hub, move |s| s.record_play(id)).await?;
    Ok(StatusCode::NO_CONTENT)
}
