//! neobox game server.
//!
//! One process serves the web client (static files), the game WebSocket
//! (`/ws`), the built-in map list (`/api/maps`) and the admin interface
//! (`/admin`). Configuration comes from environment variables (see
//! `hub::Config` and DEPLOY.md).

mod backend;
mod admin;
mod api;
mod clips;
mod cluster;
mod award;
mod conn;
mod emoji;
mod geo;
mod hitbox;
mod hub;
mod logbuf;
mod moderation;
mod maps;
mod origin;
mod qa_events;
mod room;
mod rotation;
mod rtc;
mod share;
mod ticket;
mod youtube;

use axum::extract::{ConnectInfo, Request, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::middleware;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use hub::{Config, Hub};
use neobox_store::Store;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::info;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Content policy for every response: pages load only same-origin scripts
/// (plus the wasm module) and styles. The jukebox embeds YouTube's player
/// (its script and frame) and shows video thumbnails.
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com; \
    frame-src https://www.youtube.com https://www.youtube-nocookie.com; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: blob: https://i.ytimg.com; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; \
    frame-ancestors 'none'";

/// The service worker script and the HTML shell are never cached by the browser: a 304 on a stale
/// copy would keep an old worker, or an index.html naming old hashed bundles, after a deploy.
async fn no_store_entry(req: Request, next: middleware::Next) -> Response {
    let sw = req.uri().path() == "/sw.js";
    let mut res = next.run(req).await;
    let html = res.headers().get(header::CONTENT_TYPE).is_some_and(|ct| ct.as_bytes().starts_with(b"text/html"));
    if sw || html {
        res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

/// Extensions of the files the client ships: a path ending in one names an asset, not a page.
const ASSET_EXTS: &[&str] = &[
    "js", "mjs", "css", "wasm", "map", "json", "webmanifest", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf",
    "mp3", "ogg", "wav", "mp4", "webm", "txt", "xml",
];

/// Serves the app shell for an unknown page path. A path whose last segment ends in a known asset extension
/// names an asset, so a missing one is a 404 rather than HTML handed to a script or stylesheet request.
async fn spa_fallback(uri: Uri, index: PathBuf) -> Response {
    let last = uri.path().rsplit('/').next().unwrap_or_default();
    if last.rsplit_once('.').is_some_and(|(_, ext)| ASSET_EXTS.iter().any(|known| known.eq_ignore_ascii_case(ext))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(&index).await {
        Ok(bytes) => Html(bytes).into_response(),
        Err(e) => {
            tracing::error!(path = %index.display(), "cannot read app shell: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Unknown `/api` paths answer 404 JSON, never the web shell.
async fn api_not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response()
}

async fn ws(State(hub): State<Arc<Hub>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let ip = admin::client_ip(&hub, &headers, peer);
    match api::ip_ban_message(&hub, ip).await {
        Ok(None) => {}
        Ok(Some(msg)) => return (StatusCode::FORBIDDEN, msg).into_response(),
        Err(f) => return f.into_response(),
    }
    let Some(slot) = conn::take_ip_slot(&hub, ip) else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let account = api::socket_account(&hub, &headers).await;
    upgrade.max_message_size(room::MAX_MAP_CODE + 8192).on_upgrade(move |socket| conn::serve(hub, socket, ip, slot, account))
}

async fn map_list(State(hub): State<Arc<Hub>>) -> impl IntoResponse {
    let maps: Vec<_> = hub.maps.iter().map(|m| serde_json::json!({ "name": m.name, "code": m.code })).collect();
    ([(header::CACHE_CONTROL, "public, max-age=300")], Json(maps))
}

/// Colored log lines only on a terminal that renders them: not when logs go to
/// a file or journald, not with `NO_COLOR`, and on Windows only once the
/// console accepts escape codes (a classic console window shows them raw).
fn log_colors() -> bool {
    use std::io::IsTerminal;
    if std::env::var_os("NO_COLOR").is_some() || !std::io::stdout().is_terminal() {
        return false;
    }
    #[cfg(windows)]
    return nu_ansi_term::enable_ansi_support().is_ok();
    #[cfg(not(windows))]
    return true;
}

#[tokio::main]
async fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let console = tracing_subscriber::fmt::layer().with_ansi(log_colors());
    tracing_subscriber::registry().with(filter).with(console).with(logbuf::RingLayer).init();

    let cfg = Config::from_env();
    if cfg.admin_password.is_empty() {
        tracing::warn!("NEOBOX_ADMIN_PASSWORD is not set: the admin interface is disabled");
    }
    let maps = maps::load(&cfg.maps_dir);
    let rotation = rotation::Rotation::load(&cfg.maps_dir.join("rotation").join("maps2.json"));
    let static_dir = cfg.static_dir.clone();
    let bind = cfg.bind.clone();
    if cfg.main_url.is_some() && (cfg.cluster_secret.is_empty() || cfg.public_url.is_empty()) {
        tracing::error!("a regional node (NEOBOX_MAIN) needs NEOBOX_CLUSTER_SECRET and NEOBOX_PUBLIC_URL");
        std::process::exit(1);
    }
    let rtc = start_rtc(&cfg).await;
    let store = if cfg.main_url.is_some() { None } else { Some(open_store(&cfg.data)) };
    let hub = Hub::new(cfg, maps, rotation, rtc, store);
    spawn_housekeeping(hub.clone());
    spawn_retention(hub.clone());
    cluster::spawn_heartbeat(hub.clone());

    // Unknown paths get the app shell so the client can show its own not-found screen. A missing asset
    // (the last segment has an extension) is a real 404: serving HTML in its place breaks the module load.
    let index = static_dir.join("index.html");
    let spa = Router::new().fallback(move |uri: Uri| spa_fallback(uri, index.clone()));
    let files = ServeDir::new(&static_dir).fallback(spa);
    // A regional node serves the game, `/healthz` and `/internal`; everything else goes to the main server.
    let routes = if hub.cfg.main_url.is_some() {
        Router::new()
            .route("/ws", get(ws))
            .route("/healthz", get(|| async { "ok" }))
            .merge(cluster::router())
            .fallback(cluster::to_main)
    } else {
        Router::new()
            .route("/ws", get(ws))
            .route("/api/maps", get(map_list))
            .route("/healthz", get(|| async { "ok" }))
            .merge(admin::router())
            .merge(api::router())
            .merge(clips::router())
            .merge(cluster::router())
            .route("/api/{*rest}", any(api_not_found))
            .fallback_service(files)
            .layer(middleware::from_fn_with_state(hub.clone(), share::preview))
    };
    let shutdown_hub = hub.clone();
    let app = routes
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, HeaderValue::from_static("same-origin")))
        .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP)))
        .layer(middleware::from_fn(no_store_entry))
        .layer(CompressionLayer::new())
        .layer(middleware::from_fn_with_state(hub.clone(), origin::guard))
        .with_state(hub);

    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("cannot listen on {bind}: {e}"));
    info!(%bind, static_dir = %static_dir.display(), "neobox server listening");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            info!("shutting down");
            // open sockets send their close frame first; the listener stops after a moment
            shutdown_hub.shutdown.send_replace(true);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        })
        .await
        .expect("server error");
}

/// The WebRTC transport, unless disabled or the UDP port is unavailable
/// (clients then use the WebSocket only).
async fn start_rtc(cfg: &Config) -> Option<rtc::RtcHub> {
    let bind = cfg.rtc_bind?;
    let public = cfg.rtc_public.or_else(|| {
        // the address of the interface used for outgoing traffic (no packet
        // is sent); on a typical VPS that is the public address
        let probe = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
        probe.connect("1.1.1.1:80").ok()?;
        Some(SocketAddr::new(probe.local_addr().ok()?.ip(), bind.port()))
    });
    let Some(public) = public else {
        tracing::warn!("cannot determine the public address: set NEOBOX_RTC_PUBLIC; WebRTC disabled");
        return None;
    };
    match rtc::RtcHub::start(bind, public).await {
        Ok(h) => Some(h),
        Err(e) => {
            tracing::warn!(%bind, "cannot open the WebRTC UDP port ({e}); WebRTC disabled");
            None
        }
    }
}

/// Open the account database, creating its directory first. Without it the
/// server cannot serve accounts, so a failure stops startup.
fn open_store(path: &Path) -> Store {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("cannot create {}: {e}", dir.display()));
    }
    Store::open(path).unwrap_or_else(|e| panic!("cannot open {}: {e}", path.display()))
}

/// Once a minute: drop expired sessions and forget rate-limit entries that
/// have aged out, so none of these tables grows without bound.
fn spawn_housekeeping(hub: Arc<Hub>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tick.tick().await;
            hub.admin_login.prune();
            hub.account_login.prune();
            hub.uploads.prune();
            hub.reports.prune();
            hub.feedback.prune();
            // a monthly database update replaces the file; pick it up within a minute
            hub.geo.refresh();
            let Some(store) = hub.store().cloned() else { continue };
            match tokio::task::spawn_blocking(move || store.prune_expired_sessions()).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => tracing::warn!("cannot prune sessions: {e}"),
                Err(e) => tracing::warn!("session pruning stopped: {e}"),
            }
        }
    });
}

/// Once a day: delete what the retention rules expire (old reports and feedback,
/// finished suspensions and IP bans). Game nodes keep no store and skip it.
fn spawn_retention(hub: Arc<Hub>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(24 * 60 * 60));
        loop {
            tick.tick().await;
            let Some(store) = hub.store().cloned() else { continue };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs() as i64);
            match tokio::task::spawn_blocking(move || store.purge(now)).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => tracing::warn!("cannot apply retention: {e}"),
                Err(e) => tracing::warn!("retention stopped: {e}"),
            }
        }
    });
}
