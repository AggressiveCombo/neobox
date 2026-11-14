//! End-to-end checks against a real server process on a free local port:
//! room create/join, reconnect by token, quick play, password rooms, the
//! `/lock` `/unlock` `/ban` `/unban` chat commands, and friends' presence.

use futures_util::{SinkExt, StreamExt};
use neobox_net::*;
use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// How long to wait for an expected server message.
const WAIT: Duration = Duration::from_secs(5);
const STARTUP: Duration = Duration::from_secs(30);

/// A server process with its own port and data directory, killed on drop.
struct Server {
    child: Child,
    port: u16,
    dir: PathBuf,
}

impl Server {
    fn start() -> Server {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let dir = std::env::temp_dir().join(format!("neobox-test-{}-{port}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let child = Command::new(env!("CARGO_BIN_EXE_neobox-server"))
            .env("NEOBOX_BIND", format!("127.0.0.1:{port}"))
            .env("NEOBOX_RTC_BIND", "off")
            .env("NEOBOX_DATA", dir.join("neobox.db"))
            .env("NEOBOX_MAPS", root.join("maps"))
            .env("NEOBOX_STATIC", &dir)
            .env("NEOBOX_MAX_CONNS_PER_IP", "32")
            .env("NEOBOX_TRUST_PROXY", "false")
            .env_remove("NEOBOX_ADMIN_PASSWORD")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start neobox-server");
        let server = Server { child, port, dir };
        let deadline = Instant::now() + STARTUP;
        while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "server did not start listening");
            std::thread::sleep(Duration::from_millis(50));
        }
        server
    }

    fn ws(&self) -> String {
        format!("ws://127.0.0.1:{}/ws", self.port)
    }

    /// One HTTP/1.1 request: (status, session cookie set by the answer, JSON body or Null).
    async fn http(&self, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> (u16, Option<String>, Value) {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        if !body.is_empty() {
            req.push_str("Content-Type: application/json\r\n");
        }
        if let Some(c) = cookie {
            req.push_str(&format!("Cookie: {c}\r\n"));
        }
        req.push_str("\r\n");
        req.push_str(&body);
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let raw = String::from_utf8(raw).unwrap();
        let (head, payload) = raw.split_once("\r\n\r\n").expect("http response head");
        let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).expect("http status");
        let mut set_cookie = None;
        for line in head.lines().skip(1) {
            let (k, v) = line.split_once(':').unwrap();
            let k = k.to_ascii_lowercase();
            assert!(!(k == "transfer-encoding" && v.contains("chunked")), "chunked bodies are not handled here");
            if k == "set-cookie" {
                set_cookie = v.trim().split(';').next().map(str::to_string);
            }
        }
        let json = if payload.trim().is_empty() { Value::Null } else { serde_json::from_str(payload).unwrap_or(Value::String(payload.into())) };
        (status, set_cookie, json)
    }

    /// Register an account and return its session cookie.
    async fn register(&self, name: &str) -> String {
        let (status, cookie, body) = self.http("POST", "/api/account/register", None, Some(json!({ "name": name, "password": "correct horse" }))).await;
        assert_eq!(status, 200, "register {name}: {body}");
        cookie.expect("register sets the session cookie")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A room seat: the player id there and its resume token.
struct Seat {
    code: String,
    you: u32,
    token: String,
}

struct Client {
    ws: Socket,
}

impl Client {
    async fn connect(url: &str, name: &str) -> Client {
        Client::connect_as(url, name, None).await
    }

    /// Connect, optionally with an account's session cookie, and say hello.
    async fn connect_as(url: &str, name: &str, cookie: Option<&str>) -> Client {
        let mut req = url.into_client_request().unwrap();
        if let Some(c) = cookie {
            req.headers_mut().insert("Cookie", c.parse().unwrap());
        }
        let (ws, _) = tokio_tungstenite::connect_async(req).await.expect("connect");
        let mut c = Client { ws };
        c.send(&ClientMsg::Hello { version: PROTOCOL_VERSION, name: name.into() }).await;
        c.until("welcome", |m| matches!(m, ServerMsg::Welcome { .. }).then_some(Ok(()))).await.unwrap();
        c
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

    /// The seat after create or join, or the server's refusal as `code: message`.
    async fn seat(&mut self, what: &str) -> Result<(Seat, RoomState), String> {
        let (you, token) = self
            .until(what, |m| match m {
                ServerMsg::Joined { you, token } => Some(Ok((*you, token.clone()))),
                ServerMsg::Error { code, message } => Some(Err(format!("{code}: {message}"))),
                _ => None,
            })
            .await?;
        let room = self.room_where(what, |_| true).await;
        Ok((Seat { code: room.code.clone(), you, token }, room))
    }

    async fn create(&mut self, password: Option<&str>) -> Result<(Seat, RoomState), String> {
        self.send(&ClientMsg::CreateRoom { name: "test room".into(), password: password.map(Into::into), max_players: 8, public: true }).await;
        self.seat("create room").await
    }

    async fn join(&mut self, code: &str, password: Option<&str>, resume: Option<&str>) -> Result<(Seat, RoomState), String> {
        self.send(&ClientMsg::JoinRoom { room: code.into(), password: password.map(Into::into), resume: resume.map(Into::into) }).await;
        self.seat("join room").await
    }

    async fn chat(&mut self, text: &str) {
        self.send(&ClientMsg::Chat { text: text.into() }).await;
    }
}

#[tokio::test]
async fn rooms_reconnect_quick_play_and_host_commands() {
    let server = Server::start();
    let url = server.ws();

    let mut host = Client::connect(&url, "host").await;
    let (h, room) = host.create(None).await.unwrap();
    assert_eq!(room.players.len(), 1);
    assert!(room.players[0].host, "the creator hosts the room");

    let mut guest = Client::connect(&url, "guest").await;
    let (g, _) = guest.join(&h.code, None, None).await.unwrap();
    host.room_where("guest in room", |r| r.players.len() == 2).await;
    assert_ne!(g.you, h.you);

    // a lost connection holds its slot; the resume token gives it back
    drop(guest);
    host.room_where("guest slot held", |r| r.players.iter().any(|p| p.name == "guest" && !p.connected)).await;
    let mut guest = Client::connect(&url, "guest").await;
    let (back, _) = guest.join(&h.code, None, Some(&g.token)).await.unwrap();
    assert_eq!((back.you, back.token.as_str()), (g.you, g.token.as_str()), "resume restores the same slot");
    host.room_where("guest reconnected", |r| r.players.iter().any(|p| p.name == "guest" && p.connected)).await;

    // quick play joins the open public room; leaving answers `left`
    let mut quick = Client::connect(&url, "quick").await;
    quick.send(&ClientMsg::QuickPlay).await;
    let (q, room) = quick.seat("quick play").await.unwrap();
    assert_eq!(q.code, h.code, "quick play picks the open public room");
    assert!(room.players.iter().any(|p| p.name == "quick"));
    quick.send(&ClientMsg::LeaveRoom).await;
    quick.until("left", |m| matches!(m, ServerMsg::Left).then_some(Ok(()))).await.unwrap();

    host.chat("/lock").await;
    host.room_where("/lock", |r| r.locked).await;
    host.chat("/unlock").await;
    host.room_where("/unlock", |r| !r.locked).await;

    // a ban removes the player, lists the name and refuses a rejoin
    host.chat("/ban guest").await;
    host.room_where("/ban", |r| r.bans.iter().any(|b| b == "guest") && !r.players.iter().any(|p| p.name == "guest")).await;
    let mut banned = Client::connect(&url, "guest").await;
    let refused = banned.join(&h.code, None, None).await.err().expect("a banned player must not join");
    assert!(refused.starts_with("banned:"), "{refused}");

    host.chat("/unban guest").await;
    host.room_where("/unban", |r| r.bans.is_empty()).await;
    banned.join(&h.code, None, None).await.expect("unbanned player rejoins");
}

#[tokio::test]
async fn password_rooms() {
    let server = Server::start();
    let url = server.ws();

    let mut host = Client::connect(&url, "host").await;
    let long = "x".repeat(65);
    let err = host.create(Some(&long)).await.err().expect("overlong password refused");
    assert!(err.starts_with("bad_password:"), "{err}");

    let (h, room) = host.create(Some("hunter2")).await.expect("the creator joins their own password room");
    assert!(room.password);

    let mut guest = Client::connect(&url, "guest").await;
    let err = guest.join(&h.code, None, None).await.err().expect("no password refused");
    assert!(err.starts_with("wrong_password:"), "{err}");
    let err = guest.join(&h.code, Some("hunter3"), None).await.err().expect("wrong password refused");
    assert!(err.starts_with("wrong_password:"), "{err}");
    guest.join(&h.code, Some("hunter2"), None).await.expect("right password joins");

    // quick play never lands in a password room
    let mut quick = Client::connect(&url, "quick").await;
    quick.send(&ClientMsg::QuickPlay).await;
    let (q, _) = quick.seat("quick play").await.unwrap();
    assert_ne!(q.code, h.code);
}

#[tokio::test]
async fn friends_see_presence_and_room() {
    let server = Server::start();
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;

    let (status, _, body) = server.http("POST", "/api/friends/request", Some(&alice), Some(json!({ "name": "bob" }))).await;
    assert!((200..300).contains(&status), "request: {status} {body}");
    let (status, _, body) = server.http("POST", "/api/friends/accept", Some(&bob), Some(json!({ "name": "alice" }))).await;
    assert!((200..300).contains(&status), "accept: {status} {body}");

    let bob_entry = |list: Value| -> Value {
        list.as_array().expect("friend list").iter().find(|f| f["name"] == "bob").cloned().expect("bob is listed")
    };
    let (_, _, list) = server.http("GET", "/api/friends", Some(&alice), None).await;
    let entry = bob_entry(list);
    assert_eq!(entry["state"], "friend");
    assert_eq!(entry["online"], false);

    let mut socket = Client::connect_as(&server.ws(), "bob", Some(&bob)).await;
    let (seat, _) = socket.create(None).await.unwrap();
    let (_, _, list) = server.http("GET", "/api/friends", Some(&alice), None).await;
    let entry = bob_entry(list);
    assert_eq!(entry["online"], true, "{entry}");
    assert_eq!(entry["room"]["code"], seat.code.as_str(), "{entry}");

    drop(socket);
    let deadline = Instant::now() + WAIT;
    loop {
        let (_, _, list) = server.http("GET", "/api/friends", Some(&alice), None).await;
        if bob_entry(list)["online"] == false {
            break;
        }
        assert!(Instant::now() < deadline, "bob still online after closing his socket");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
