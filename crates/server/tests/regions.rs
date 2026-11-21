//! Regional game nodes beside a real main server (Frankfurt) and a node in New
//! York. Viewers and hosts are placed by their `X-Forwarded-For` address in the
//! test geolocation database: 198.51.100.x is Frankfurt, 203.0.113.x is New York.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, KeyInit, Mac};
use neobox_net::*;
use serde_json::{json, Value};
use sha2::Sha256;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// How long to wait for an expected server message.
const WAIT: Duration = Duration::from_secs(30);
const STARTUP: Duration = Duration::from_secs(30);
const SECRET: &str = "test-cluster-secret";

/// Viewer and host addresses in the fixture database.
const FRANKFURT_IP: &str = "198.51.100.7";
const NEW_YORK_IP: &str = "203.0.113.9";
const FRANKFURT: (f64, f64) = (50.1109, 8.6821);
const NEW_YORK: (f64, f64) = (40.7128, -74.0060);

/// Great-circle distance in km, as the server computes it (the original's haversine).
fn km(a: (f64, f64), b: (f64, f64)) -> u32 {
    let rad = std::f64::consts::PI / 180.0;
    let (lat1, lat2) = (a.0 * rad, b.0 * rad);
    let dlat = lat2 - lat1;
    let dlon = (b.1 - a.1) * rad;
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    (6372.797 * 2.0 * h.sqrt().atan2((1.0 - h).sqrt())).round() as u32
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// A server process on `port` with its own data directory, killed on drop.
struct Proc {
    child: Child,
    dir: PathBuf,
}

/// The `neobox-server` command on `port` with `env` added on top of the test defaults.
fn command(port: u16, env: &[(&str, String)]) -> (Command, PathBuf) {
    let dir = std::env::temp_dir().join(format!("neobox-regions-{}-{port}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_neobox-server"));
    cmd.env("NEOBOX_BIND", format!("127.0.0.1:{port}"))
        .env("NEOBOX_RTC_BIND", "off")
        .env("NEOBOX_DATA", dir.join("neobox.db"))
        .env("NEOBOX_MAPS", root.join("maps"))
        .env("NEOBOX_STATIC", &dir)
        .env("NEOBOX_GEOIP", root.join("crates/server/tests/data/geo-test.mmdb"))
        .env("NEOBOX_TRUST_PROXY", "true")
        .env_remove("NEOBOX_ADMIN_PASSWORD")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    (cmd, dir)
}

impl Proc {
    fn start(port: u16, env: &[(&str, String)]) -> Proc {
        let (mut cmd, dir) = command(port, env);
        let proc = Proc { child: cmd.spawn().expect("start neobox-server"), dir };
        let deadline = Instant::now() + STARTUP;
        while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "server did not start listening");
            std::thread::sleep(Duration::from_millis(50));
        }
        proc
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// `http://…` → `ws://…/ws`.
fn ws_url(http: &str) -> String {
    format!("{}/ws", http.replacen("http", "ws", 1))
}

/// A main server (Frankfurt) and a game node (New York) on free ports. The node
/// is registered once its heartbeat lands; tests poll for that.
struct Pair {
    _main: Proc,
    _node: Proc,
    main_port: u16,
    node_port: u16,
}

impl Pair {
    fn start() -> Pair {
        let (main_port, node_port) = (free_port(), free_port());
        let main = Proc::start(
            main_port,
            &[
                ("NEOBOX_CLUSTER_SECRET", SECRET.into()),
                ("NEOBOX_REGION", "Frankfurt".into()),
                ("NEOBOX_LOCATION", "50.1109,8.6821".into()),
            ],
        );
        let node = Proc::start(
            node_port,
            &[
                ("NEOBOX_MAIN", format!("http://127.0.0.1:{main_port}")),
                ("NEOBOX_CLUSTER_SECRET", SECRET.into()),
                ("NEOBOX_PUBLIC_URL", format!("http://127.0.0.1:{node_port}")),
                ("NEOBOX_REGION", "New York".into()),
                ("NEOBOX_LOCATION", "40.7128,-74.0060".into()),
            ],
        );
        Pair { _main: main, _node: node, main_port, node_port }
    }

    fn main_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.main_port)
    }

    fn node_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.node_port)
    }

    fn main_ws(&self) -> String {
        ws_url(&self.main_url())
    }

    fn node_ws(&self) -> String {
        ws_url(&self.node_url())
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A room seat: the code of the room joined or created.
struct Seat {
    code: String,
}

struct Client {
    ws: Socket,
}

impl Client {
    /// Open a socket as if from `ip`, with an optional session cookie. Say hello before use.
    async fn open(url: &str, ip: &str, cookie: Option<&str>) -> Client {
        let mut req = url.into_client_request().unwrap();
        req.headers_mut().insert("X-Forwarded-For", ip.parse().unwrap());
        if let Some(c) = cookie {
            req.headers_mut().insert("Cookie", c.parse().unwrap());
        }
        let (ws, _) = tokio_tungstenite::connect_async(req).await.expect("connect");
        Client { ws }
    }

    /// Say hello; `Err` carries the server's refusal as `code: message`.
    async fn hello(&mut self, name: &str, ticket: Option<String>) -> Result<(), String> {
        self.send(&ClientMsg::Hello { version: PROTOCOL_VERSION, name: name.into(), color: None, ticket, build: None }).await;
        self.until("welcome", |m| match m {
            ServerMsg::Welcome { .. } => Some(Ok(())),
            ServerMsg::Error { code, message } => Some(Err(format!("{code}: {message}"))),
            _ => None,
        })
        .await
    }

    async fn send(&mut self, m: &ClientMsg) {
        let text = serde_json::to_string(m).unwrap();
        self.ws.send(Message::Text(text.into())).await.expect("send");
    }

    /// Reads server messages until `f` decides on one; fails after `WAIT`.
    async fn until<T>(&mut self, what: &str, mut f: impl FnMut(&ServerMsg) -> Option<Result<T, String>>) -> Result<T, String> {
        let deadline = Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let next = tokio::time::timeout(left, self.ws.next()).await.map_err(|_| format!("timed out waiting for {what}"))?;
            match next {
                Some(Ok(Message::Text(t))) => {
                    let m: ServerMsg = serde_json::from_str(t.as_str()).map_err(|e| format!("bad server message: {e}"))?;
                    if let Some(v) = f(&m) {
                        return v;
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(format!("socket error waiting for {what}: {e}")),
                None => return Err(format!("connection closed waiting for {what}")),
            }
        }
    }

    /// The next room state that `f` accepts.
    async fn room_where(&mut self, what: &str, f: impl Fn(&RoomState) -> bool) -> RoomState {
        self.until(what, |m| match m {
            ServerMsg::Room { room } if f(room) => Some(Ok(room.clone())),
            _ => None,
        })
        .await
        .unwrap()
    }

    /// The next redirect: the server's URL and the message to send there.
    async fn redirect(&mut self) -> (String, ClientMsg) {
        self.until("redirect", |m| match m {
            ServerMsg::Redirect { url, then } => Some(Ok((url.clone(), (**then).clone()))),
            _ => None,
        })
        .await
        .unwrap()
    }

    /// The seat after create or join, or the server's refusal as `code: message`.
    async fn seat(&mut self, what: &str) -> Result<(Seat, RoomState), String> {
        self.until(what, |m| match m {
            ServerMsg::Joined { .. } => Some(Ok(())),
            ServerMsg::Error { code, message } => Some(Err(format!("{code}: {message}"))),
            _ => None,
        })
        .await?;
        let room = self.room_where(what, |_| true).await;
        Ok((Seat { code: room.code.clone() }, room))
    }

    async fn create(&mut self) -> Result<(Seat, RoomState), String> {
        self.send(&ClientMsg::CreateRoom { name: "test room".into(), password: None, max_players: 8, public: true }).await;
        self.seat("create room").await
    }

    async fn join(&mut self, code: &str) -> Result<(Seat, RoomState), String> {
        self.send(&ClientMsg::JoinRoom { room: code.into(), password: None, resume: None }).await;
        self.seat("join room").await
    }

    async fn chat(&mut self, text: &str) {
        self.send(&ClientMsg::Chat { text: text.into() }).await;
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

/// Register an account on `base` and return its session cookie.
async fn register(base: &str, name: &str) -> String {
    let resp = http()
        .post(format!("{base}/api/account/register"))
        .header("content-type", "application/json")
        .body(json!({ "name": name, "password": "correct horse" }).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK, "register {name}");
    resp.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string()
}

/// A ticket for the signed-in account behind `cookie`, from the main server.
async fn ticket(base: &str, cookie: &str) -> String {
    let (status, body) = get_json(base, "/api/ticket", Some(cookie)).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    body["ticket"].as_str().unwrap().to_string()
}

async fn get_json(base: &str, path: &str, cookie: Option<&str>) -> (reqwest::StatusCode, Value) {
    let mut req = http().get(format!("{base}{path}"));
    if let Some(c) = cookie {
        req = req.header("cookie", c);
    }
    let resp = req.send().await.unwrap();
    let status = resp.status();
    let text = resp.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

async fn post_json(base: &str, path: &str, cookie: Option<&str>, body: Value) -> (reqwest::StatusCode, Value) {
    let mut req = http().post(format!("{base}{path}")).header("content-type", "application/json").body(body.to_string());
    if let Some(c) = cookie {
        req = req.header("cookie", c);
    }
    let resp = req.send().await.unwrap();
    let status = resp.status();
    let text = resp.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// A ticket signed with the cluster secret, in the same format the main server issues.
fn signed_ticket(claims: Value) -> String {
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let mut m = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    m.update(payload.as_bytes());
    format!("{payload}.{}", URL_SAFE_NO_PAD.encode(m.finalize().into_bytes()))
}

#[tokio::test(flavor = "multi_thread")]
async fn node_room_is_listed_and_joined_by_redirect() {
    let pair = Pair::start();

    // a public room on the node, hosted from New York
    let mut host = Client::open(&pair.node_ws(), NEW_YORK_IP, None).await;
    host.hello("host", None).await.unwrap();
    let (seat, _) = host.create().await.unwrap();

    // a Frankfurt viewer on the main server sees it with its region, distance and host's country
    let mut viewer = Client::open(&pair.main_ws(), FRANKFURT_IP, None).await;
    viewer.hello("viewer", None).await.unwrap();
    let deadline = Instant::now() + WAIT;
    let (row, country) = loop {
        viewer.send(&ClientMsg::ListRooms).await;
        let (found, country) = viewer
            .until("room list", |m| match m {
                ServerMsg::Rooms { rooms, country } => Some(Ok((rooms.iter().find(|r| r.region == "New York").cloned(), country.clone()))),
                _ => None,
            })
            .await
            .unwrap();
        if let Some(row) = found {
            break (row, country);
        }
        assert!(Instant::now() < deadline, "node room never listed on the main server");
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    assert_eq!(row.code, seat.code);
    assert_eq!(row.distance, Some(km(FRANKFURT, NEW_YORK)), "distance from the viewer to the node");
    assert_eq!(row.country.as_deref(), Some("US"), "the host's country");
    assert_eq!(country.as_deref(), Some("DE"), "the viewer's country");

    // joining it on the main server redirects the client to the node, which then gets the same join
    viewer.send(&ClientMsg::JoinRoom { room: row.code.clone(), password: None, resume: None }).await;
    let (url, then) = viewer.redirect().await;
    assert_eq!(url, pair.node_url());
    assert!(matches!(&then, ClientMsg::JoinRoom { room, .. } if *room == row.code), "redirect rejoins the same room");
}

#[tokio::test(flavor = "multi_thread")]
async fn create_room_goes_to_the_nearest_server() {
    let pair = Pair::start();

    // a New York viewer: the node is nearest, so the create is handed over
    let mut ny = Client::open(&pair.main_ws(), NEW_YORK_IP, None).await;
    ny.hello("ny", None).await.unwrap();
    ny.send(&ClientMsg::CreateRoom { name: "near".into(), password: None, max_players: 8, public: true }).await;
    let (url, then) = ny.redirect().await;
    assert_eq!(url, pair.node_url());
    assert!(matches!(&then, ClientMsg::CreateRoom { name, .. } if *name == "near"), "redirect carries the create");

    // a Frankfurt viewer: the main server is nearest, the room opens here
    let mut fra = Client::open(&pair.main_ws(), FRANKFURT_IP, None).await;
    fra.hello("fra", None).await.unwrap();
    let (seat, _) = fra.create().await.unwrap();
    assert!(!seat.code.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn signed_in_player_on_a_node_is_levelled_and_awarded_on_main() {
    let pair = Pair::start();
    let cookie = register(&pair.main_url(), "alice").await;
    let ticket = ticket(&pair.main_url(), &cookie).await;

    // the signed-in host plays on the node: its roster entry is levelled, not a guest
    let mut host = Client::open(&pair.node_ws(), NEW_YORK_IP, None).await;
    host.hello("alice", Some(ticket)).await.unwrap();
    let (seat, room) = host.create().await.unwrap();
    let me = room.players.iter().find(|p| p.name == "alice").expect("host in its roster");
    assert!(me.level >= 1, "a signed-in player is not a guest: level {}", me.level);

    let mut guest = Client::open(&pair.node_ws(), FRANKFURT_IP, None).await;
    guest.hello("guest", None).await.unwrap();
    guest.join(&seat.code).await.unwrap();

    // a map with spawns and no ground: everyone falls; one life each ends the game
    let void = r#"{"b":[],"j":[],"s":[{"1":15,"2":10},{"1":25,"2":10}],"p":[],"tu":[],"tc":[],"gp":[],"c":[],"set":{"3":40,"15":40,"16":25}}"#;
    host.send(&ClientMsg::SetMap { code: neobox_sim::map::encode_code(void), name: Some("void".into()) }).await;
    host.send(&ClientMsg::SetMode { mode: 1 }).await;
    host.chat("/set objectiveLimit 1").await;
    host.room_where("lives, one life", |r| r.settings.game_mode == 1 && r.settings.objective_limit == 1.0 && r.map_name == "void").await;
    host.send(&ClientMsg::Start).await;

    let award = host
        .until("experience", |m| match m {
            ServerMsg::Xp(a) => Some(Ok(a.clone())),
            _ => None,
        })
        .await
        .unwrap();
    assert!(!award.quick);
    assert!(award.gained > 0);
    assert_eq!(award.xp, Some(award.gained as u64), "a new account's total is its first award");

    // the award is stored on the main server
    let (status, me) = get_json(&pair.main_url(), "/api/account/me", Some(&cookie)).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(me["xp"], award.gained, "{me}");
}

#[tokio::test(flavor = "multi_thread")]
async fn node_rejects_a_bad_ticket_on_hello() {
    let pair = Pair::start();
    let mut c = Client::open(&pair.node_ws(), NEW_YORK_IP, None).await;
    let err = c.hello("ghost", Some("garbage.ticket".into())).await.expect_err("a bad ticket is refused");
    assert!(err.starts_with("bad_ticket"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn node_rejects_an_expired_ticket_on_hello() {
    let pair = Pair::start();
    let claims = json!({ "a": 1, "n": "ghost", "x": 0, "e": 1 });
    let mut c = Client::open(&pair.node_ws(), NEW_YORK_IP, None).await;
    let err = c.hello("ghost", Some(signed_ticket(claims))).await.expect_err("an expired ticket is refused");
    assert!(err.starts_with("bad_ticket"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn internal_api_requires_the_cluster_secret() {
    let pair = Pair::start();
    let body = json!({ "region": "New York", "url": pair.node_url(), "location": null, "conns": 0, "rooms": [], "online": [] });
    let beat = |secret: &'static str| {
        http()
            .post(format!("{}/internal/heartbeat", pair.main_url()))
            .bearer_auth(secret)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
    };
    let wrong = beat("not-the-secret").await.unwrap();
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);
    let right = beat(SECRET).await.unwrap();
    assert!(right.status().is_success(), "heartbeat with the secret: {}", right.status());
}

#[tokio::test(flavor = "multi_thread")]
async fn node_redirects_plain_pages_to_the_main_server() {
    let pair = Pair::start();
    let resp = http().get(format!("{}/", pair.node_url())).send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::SEE_OTHER);
    assert_eq!(resp.headers()["location"], format!("{}/", pair.main_url()).as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn node_refuses_to_start_without_its_cluster_settings() {
    let port = free_port();
    let (mut cmd, dir) = command(port, &[("NEOBOX_MAIN", "http://127.0.0.1:1".into())]);
    let mut child = cmd.spawn().expect("start neobox-server");
    let deadline = Instant::now() + STARTUP;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "node without a cluster secret kept running");
        std::thread::sleep(Duration::from_millis(50));
    };
    let _ = std::fs::remove_dir_all(&dir);
    assert!(!status.success());
}

#[tokio::test(flavor = "multi_thread")]
async fn ticket_needs_a_cluster_secret_and_a_session() {
    // without a cluster secret the endpoint does not exist
    let port = free_port();
    let _single = Proc::start(port, &[]);
    let (status, _) = get_json(&format!("http://127.0.0.1:{port}"), "/api/ticket", None).await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND);

    // with a secret, a guest gets 401
    let pair = Pair::start();
    let (status, _) = get_json(&pair.main_url(), "/api/ticket", None).await;
    assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test(flavor = "multi_thread")]
async fn friends_see_a_node_room() {
    let pair = Pair::start();
    let main = pair.main_url();
    let alice = register(&main, "alice").await;
    let bob = register(&main, "bob").await;

    let (status, body) = post_json(&main, "/api/friends/request", Some(&alice), json!({ "name": "bob" })).await;
    assert!((200..300).contains(&status.as_u16()), "request: {status} {body}");
    let (status, body) = post_json(&main, "/api/friends/accept", Some(&bob), json!({ "name": "alice" })).await;
    assert!((200..300).contains(&status.as_u16()), "accept: {status} {body}");

    // bob plays on the node from New York
    let mut socket = Client::open(&pair.node_ws(), NEW_YORK_IP, None).await;
    socket.hello("bob", Some(ticket(&main, &bob).await)).await.unwrap();
    let (seat, _) = socket.create().await.unwrap();

    // alice sees bob online in that room, on the main server
    let deadline = Instant::now() + WAIT;
    loop {
        let (_, list) = get_json(&main, "/api/friends", Some(&alice)).await;
        let entry = list.as_array().expect("friend list").iter().find(|f| f["name"] == "bob").cloned().expect("bob is listed");
        if entry["online"] == true && entry["room"]["code"] == seat.code.as_str() {
            break;
        }
        assert!(Instant::now() < deadline, "bob never showed in the node room: {entry}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn quick_play_from_new_york_goes_to_the_node() {
    let pair = Pair::start();

    // no quick room anywhere yet: the New York viewer is handed to the node's quick play
    let mut ny = Client::open(&pair.main_ws(), NEW_YORK_IP, None).await;
    ny.hello("ny", None).await.unwrap();
    ny.send(&ClientMsg::QuickPlay { queue: None, exclude: vec![] }).await;
    let (url, then) = ny.redirect().await;
    assert_eq!(url, pair.node_url());
    assert!(matches!(&then, ClientMsg::QuickPlay { queue: Some(q), .. } if *q == "qp_1"), "redirect carries quick play");

    // the node opens a quick room (with the main server's rotation); the main server then sends the viewer into it
    let mut node_viewer = Client::open(&pair.node_ws(), NEW_YORK_IP, None).await;
    node_viewer.hello("node", None).await.unwrap();
    node_viewer.send(&ClientMsg::QuickPlay { queue: Some("qp_1".into()), exclude: vec![] }).await;
    let (quick, room) = node_viewer.seat("node quick play").await.unwrap();
    assert_eq!((room.name.as_str(), room.max_players), ("Sweaty Bois", 4));

    let deadline = Instant::now() + WAIT;
    let (url, then) = loop {
        ny.send(&ClientMsg::QuickPlay { queue: None, exclude: vec![] }).await;
        let (url, then) = ny.redirect().await;
        if matches!(then, ClientMsg::JoinRoom { .. }) {
            break (url, then);
        }
        assert!(Instant::now() < deadline, "the node's quick room never reached the main server");
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    assert_eq!(url, pair.node_url());
    assert!(matches!(&then, ClientMsg::JoinRoom { room, .. } if *room == quick.code), "redirect joins the node's quick room");
}
