//! Where accounts, XP and the map library live. The main server owns the
//! store; a regional game node has none and asks the main server over HTTP.

use neobox_store::{MatchStats, RoomMap, Store, XpGrant};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

/// A POST with a JSON body (reqwest here has no `json` feature).
fn json_post<T: Serialize>(http: &reqwest::Client, url: String, body: &T) -> reqwest::RequestBuilder {
    http.post(url).header("content-type", "application/json").body(serde_json::to_vec(body).unwrap_or_default())
}

/// A map vote or favourite change, as sent between servers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapAction {
    Up,
    Down,
    Fav,
    Unfav,
}

pub enum Backend {
    Local(Arc<Store>),
    Remote(Remote),
}

/// The main server, as a regional node sees it.
pub struct Remote {
    pub main: String,
    pub secret: String,
    pub http: reqwest::Client,
}

#[derive(Serialize, Deserialize)]
pub struct XpBody {
    pub account: i64,
    pub amount: u32,
}

#[derive(Serialize, Deserialize)]
pub struct StatsBody {
    pub account: i64,
    pub stats: MatchStats,
}

#[derive(Serialize, Deserialize)]
pub struct MapCommandBody {
    pub account: i64,
    pub map: i64,
    pub action: MapAction,
}

/// A finish time on a library map, as sent between servers.
#[derive(Serialize, Deserialize)]
pub struct RecordBody {
    pub account: i64,
    pub map: i64,
    pub ticks: i64,
}

fn store_err(e: neobox_store::Error) -> String {
    e.to_string()
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> neobox_store::Result<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(store_err)
}

/// Apply a map vote or favourite change in the store.
pub fn apply_map_action(s: &Store, account: i64, map: i64, action: MapAction) -> neobox_store::Result<()> {
    match action {
        MapAction::Up => s.vote(account, map, 1),
        MapAction::Down => s.vote(account, map, -1),
        MapAction::Fav => s.favourite(account, map, true),
        MapAction::Unfav => s.favourite(account, map, false),
    }
}

impl Backend {
    /// The local store, if this server owns one.
    pub fn store(&self) -> Option<&Arc<Store>> {
        match self {
            Backend::Local(s) => Some(s),
            Backend::Remote(_) => None,
        }
    }

    pub async fn grant_xp(&self, account: i64, xp: u32) -> Result<XpGrant, String> {
        match self {
            Backend::Local(s) => {
                let s = s.clone();
                blocking(move || s.grant_xp(account, xp)).await
            }
            Backend::Remote(r) => r.send(json_post(&r.http, r.url("/internal/xp"), &XpBody { account, amount: xp })).await,
        }
    }

    pub async fn account_xp(&self, account: i64) -> Result<u64, String> {
        match self {
            Backend::Local(s) => {
                let s = s.clone();
                blocking(move || s.account_xp(account)).await
            }
            Backend::Remote(_) => Err("accounts live on the main server".into()),
        }
    }

    pub async fn map_command(&self, body: MapCommandBody) -> Result<(), String> {
        match self {
            Backend::Local(s) => {
                let s = s.clone();
                blocking(move || apply_map_action(&s, body.account, body.map, body.action)).await
            }
            Backend::Remote(r) => {
                let _: serde_json::Value =
                    r.send(json_post(&r.http, r.url("/internal/map-command"), &body)).await?;
                Ok(())
            }
        }
    }

    /// Keep the finish time if it beats the account's stored one; `true` when it is a new personal best.
    pub async fn save_record(&self, body: RecordBody) -> Result<bool, String> {
        match self {
            Backend::Local(s) => {
                let s = s.clone();
                blocking(move || s.record_time(body.account, body.map, body.ticks)).await
            }
            Backend::Remote(r) => r.send(json_post(&r.http, r.url("/internal/records"), &body)).await,
        }
    }

    pub async fn room_map(&self, map: i64, viewer: Option<i64>) -> Result<RoomMap, String> {
        match self {
            Backend::Local(s) => {
                let s = s.clone();
                blocking(move || s.map_meta(map, viewer)).await
            }
            Backend::Remote(r) => {
                let mut url = r.url(&format!("/internal/maps/{map}"));
                if let Some(v) = viewer {
                    url.push_str(&format!("?viewer={v}"));
                }
                r.send(r.http.get(url)).await
            }
        }
    }

    pub async fn record_play(&self, map: i64) -> Result<(), String> {
        match self {
            Backend::Local(s) => {
                let s = s.clone();
                blocking(move || s.record_play(map)).await
            }
            Backend::Remote(r) => {
                let _: serde_json::Value = r.send(r.http.post(r.url(&format!("/internal/maps/{map}/play")))).await?;
                Ok(())
            }
        }
    }

    /// Add one finished game to a signed-in player's stats.
    pub async fn record_stats(&self, account: i64, stats: MatchStats) -> Result<(), String> {
        match self {
            Backend::Local(s) => {
                let s = s.clone();
                blocking(move || s.record_stats(account, &stats)).await
            }
            Backend::Remote(r) => {
                let _: serde_json::Value = r.send(json_post(&r.http, r.url("/internal/stats"), &StatsBody { account, stats })).await?;
                Ok(())
            }
        }
    }

    /// The main server's quick-play rotation (regional nodes only).
    pub async fn rotation(&self) -> Result<crate::rotation::Rotation, String> {
        match self {
            Backend::Local(_) => Err("the main server builds its own rotation".into()),
            Backend::Remote(r) => r.send(r.http.get(r.url("/api/rotation"))).await,
        }
    }
}

impl Remote {
    pub fn new(main: String, secret: String) -> Remote {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default();
        Remote { main, secret, http }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.main, path)
    }

    /// Send an authorised request to the main server and decode its JSON answer.
    async fn send<T: DeserializeOwned>(&self, rq: reqwest::RequestBuilder) -> Result<T, String> {
        let resp = rq
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(|e| format!("The main server cannot be reached: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["error"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("The main server answered {status}"));
            return Err(msg);
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}
