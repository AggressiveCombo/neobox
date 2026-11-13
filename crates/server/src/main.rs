//! neobox game server.
//!
//! One process serves the web client (static files), the game WebSocket
//! (`/ws`), the built-in map list (`/api/maps`) and the admin interface
//! (`/admin`). Configuration comes from environment variables (see
//! `hub::Config` and DEPLOY.md).

mod admin;
mod conn;
mod hub;
mod logbuf;
mod maps;
mod room;
mod rtc;

use axum::extract::{ConnectInfo, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use hub::{Config, Hub};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::info;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

async fn ws(State(hub): State<Arc<Hub>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    let ip = admin::client_ip(&hub, &headers, peer);
    upgrade.max_message_size(room::MAX_MAP_CODE + 8192).on_upgrade(move |socket| conn::serve(hub, socket, ip))
}

async fn map_list(State(hub): State<Arc<Hub>>) -> impl IntoResponse {
    let maps: Vec<_> = hub.maps.iter().map(|m| serde_json::json!({ "name": m.name, "code": m.code })).collect();
    ([(header::CACHE_CONTROL, "public, max-age=300")], Json(maps))
}

#[tokio::main]
async fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    tracing_subscriber::registry().with(filter).with(tracing_subscriber::fmt::layer()).with(logbuf::RingLayer).init();

    let cfg = Config::from_env();
    if cfg.admin_password.is_empty() {
        tracing::warn!("NEOBOX_ADMIN_PASSWORD is not set: the admin interface is disabled");
    }
    let maps = maps::load(&cfg.maps_dir);
    let static_dir = cfg.static_dir.clone();
    let bind = cfg.bind.clone();
    let rtc = start_rtc(&cfg).await;
    let hub = Hub::new(cfg, maps, rtc);

    let files = ServeDir::new(&static_dir).fallback(ServeFile::new(static_dir.join("index.html")));
    let app = Router::new()
        .route("/ws", get(ws))
        .route("/api/maps", get(map_list))
        .route("/healthz", get(|| async { "ok" }))
        .merge(admin::router())
        .fallback_service(files)
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, HeaderValue::from_static("same-origin")))
        .layer(CompressionLayer::new())
        .with_state(hub);

    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("cannot listen on {bind}: {e}"));
    info!(%bind, static_dir = %static_dir.display(), "neobox server listening");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("shutting down");
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
