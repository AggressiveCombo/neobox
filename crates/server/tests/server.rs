//! End-to-end checks against a real server process on a free local port:
//! room create/join, reconnect by token, quick-play rooms, password rooms,
//! the `/lock` `/unlock` `/ban` `/unban` chat commands, friends' presence,
//! lobby signals (presence lines, typing, colours, start countdown) and the
//! experience awarded when a match ends.

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
        self.http_from(method, path, cookie, None, body).await
    }

    /// `http` with an `Origin` header when `origin` is given, as a page on that site sends.
    async fn http_from(&self, method: &str, path: &str, cookie: Option<&str>, origin: Option<&str>, body: Option<Value>) -> (u16, Option<String>, Value) {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        if !body.is_empty() {
            req.push_str("Content-Type: application/json\r\n");
        }
        if let Some(c) = cookie {
            req.push_str(&format!("Cookie: {c}\r\n"));
        }
        if let Some(o) = origin {
            req.push_str(&format!("Origin: {o}\r\n"));
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
        c.send(&ClientMsg::Hello { version: PROTOCOL_VERSION, name: name.into(), color: None, ticket: None, build: None }).await;
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

    // quick play opens a host-less room of the mode (size, game mode and limit
    // from the rotation) that starts by itself; the next player of the same
    // mode lands in it unless they exclude it; leaving answers `left`
    let mut quick = Client::connect(&url, "quick").await;
    quick.send(&ClientMsg::QuickPlay { queue: Some("qp_1".into()), exclude: vec![] }).await;
    let (q, room) = quick.seat("quick play").await.unwrap();
    assert_ne!(q.code, h.code, "quick play never lands in a custom room");
    assert_eq!(room.quick.as_deref(), Some("qp_1"));
    assert_eq!((room.name.as_str(), room.max_players), ("Sweaty Bois", 4));
    assert_eq!((room.settings.game_mode, room.settings.objective_limit), (2, 2.0), "rounds, two to win");
    assert!(room.players.iter().all(|p| !p.host), "quick-play rooms have no host");
    quick.until("quick match start", |m| matches!(m, ServerMsg::MatchStart { .. } | ServerMsg::Snapshot { .. }).then_some(Ok(()))).await.unwrap();
    let mut second = Client::connect(&url, "second").await;
    second.send(&ClientMsg::QuickPlay { queue: Some("qp_1".into()), exclude: vec![] }).await;
    let (s, _) = second.seat("second quick play").await.unwrap();
    assert_eq!(s.code, q.code, "the same mode fills the open quick-play room");
    second.until("late join snapshot", |m| matches!(m, ServerMsg::Snapshot { .. }).then_some(Ok(()))).await.unwrap();
    let mut third = Client::connect(&url, "third").await;
    third.send(&ClientMsg::QuickPlay { queue: Some("qp_1".into()), exclude: vec![q.code.clone()] }).await;
    let (t, _) = third.seat("third quick play").await.unwrap();
    assert_ne!(t.code, q.code, "an excluded room is skipped");
    let mut teams = Client::connect(&url, "teams").await;
    teams.send(&ClientMsg::QuickPlay { queue: Some("qp_2".into()), exclude: vec![] }).await;
    let (_, room) = teams.seat("team quick play").await.unwrap();
    assert_eq!((room.name.as_str(), room.max_players, room.settings.game_mode), ("Team Madness", 8, 5));
    assert!(room.players.iter().all(|p| p.team == 2 || p.team == 3), "team quick play puts players in teams");
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

    // commands spend the chat budget (3 at once, then one per 3 seconds)
    tokio::time::sleep(Duration::from_secs(4)).await;
    host.chat("/unban guest").await;
    host.room_where("/unban", |r| r.bans.is_empty()).await;
    banned.join(&h.code, None, None).await.expect("unbanned player rejoins");
}

#[tokio::test]
async fn commands_share_the_chat_budget() {
    let server = Server::start();
    let mut host = Client::connect(&server.ws(), "host").await;
    host.create(None).await.unwrap();
    for _ in 0..4 {
        host.chat("/help").await;
    }
    host.until("command flood refused", |m| match m {
        ServerMsg::Error { code, .. } if code == "rate_limited" => Some(Ok(())),
        _ => None,
    })
    .await
    .unwrap();
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
    quick.send(&ClientMsg::QuickPlay { queue: None, exclude: vec![] }).await;
    let (q, room) = quick.seat("quick play").await.unwrap();
    assert_ne!(q.code, h.code);
    assert_eq!(room.quick.as_deref(), Some("qp_1"), "the first mode");
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

/// The chat line `text` from the server (system lines have `from: None`).
fn is_chat(m: &ServerMsg, text: &str) -> bool {
    matches!(m, ServerMsg::Chat { text: t, .. } if t == text)
}

#[tokio::test]
async fn lobby_signals_and_start_countdown() {
    let server = Server::start();
    let url = server.ws();
    let mut host = Client::connect(&url, "host").await;
    let (h, _) = host.create(None).await.unwrap();
    let mut guest = Client::connect(&url, "guest").await;
    let (g, _) = guest.join(&h.code, None, None).await.unwrap();
    host.until("join line", |m| is_chat(m, "guest has joined the game").then_some(Ok(()))).await.unwrap();

    // typing reaches the others, not the typist
    guest.send(&ClientMsg::Typing).await;
    let who = host.until("typing", |m| match m {
        ServerMsg::Typing { player } => Some(Ok(*player)),
        _ => None,
    });
    assert_eq!(who.await.unwrap(), g.you);

    // colours and editor presence show in the room state
    guest.send(&ClientMsg::SetColor { color: 0x123456 }).await;
    host.room_where("colour", |r| r.players.iter().any(|p| p.id == g.you && p.color == 0x123456)).await;
    guest.send(&ClientMsg::Editing { open: true }).await;
    host.room_where("editing", |r| r.players.iter().any(|p| p.id == g.you && p.editing)).await;

    // a player who picks no colour takes the first palette colour no one in the room uses (the host has the first)
    let mut third = Client::connect(&url, "third").await;
    let (t, _) = third.join(&h.code, None, None).await.unwrap();
    host.room_where("default colour", |r| {
        let colour = |id| r.players.iter().find(|p| p.id == id).map(|p| p.color);
        colour(h.you) == Some(0xf9fc91) && colour(t.you) == Some(0x33658a)
    })
    .await;

    // emoji shortcodes become emoji
    guest.chat("gg :fire:").await;
    host.until("emoji", |m| is_chat(m, "gg 🔥").then_some(Ok(()))).await.unwrap();

    // two players: start counts down and can be aborted; /settings lists the settings
    host.send(&ClientMsg::Start).await;
    host.room_where("countdown", |r| r.starting).await;
    host.send(&ClientMsg::AbortStart).await;
    host.room_where("aborted", |r| !r.starting && !r.in_match).await;
    host.chat("/settings").await;
    host.until("settings", |m| matches!(m, ServerMsg::Chat { text, .. } if text.contains("timeScale: ")).then_some(Ok(()))).await.unwrap();
    host.send(&ClientMsg::Start).await;
    host.until("countdown match start", |m| matches!(m, ServerMsg::MatchStart { .. }).then_some(Ok(()))).await.unwrap();

    // the room's map code is served for the editor
    host.send(&ClientMsg::GetMap).await;
    let code = host.until("map code", |m| match m {
        ServerMsg::MapCode { code, .. } => Some(Ok(code.clone())),
        _ => None,
    });
    assert!(!code.await.unwrap().is_empty());

    drop(guest);
    host.room_where("guest slot held", |r| r.players.iter().any(|p| p.id == g.you && !p.connected)).await;
}

#[tokio::test]
async fn match_end_awards_experience() {
    let server = Server::start();
    let alice = server.register("alice").await;
    let url = server.ws();
    let mut host = Client::connect_as(&url, "alice", Some(&alice)).await;
    host.create(None).await.unwrap();
    let mut guest = Client::connect(&url, "guest").await;
    let code = host.room_where("room", |_| true).await.code;
    guest.join(&code, None, None).await.unwrap();

    // a map with spawns and no ground: everyone falls; one life each ends the game
    let void = r#"{"b":[],"j":[],"s":[{"1":15,"2":10},{"1":25,"2":10}],"p":[],"tu":[],"tc":[],"gp":[],"c":[],"set":{"3":40,"15":40,"16":25}}"#;
    host.send(&ClientMsg::SetMap { code: neobox_sim::map::encode_code(void), name: Some("void".into()) }).await;
    host.send(&ClientMsg::SetMode { mode: 1 }).await;
    host.chat("/set objectiveLimit 1").await;
    host.room_where("lives, one life", |r| r.settings.game_mode == 1 && r.settings.objective_limit == 1.0 && r.map_name == "void").await;
    host.send(&ClientMsg::Start).await;

    let deadline = Instant::now() + Duration::from_secs(60);
    // the guest is read here too: the server pings every 2 s and drops a client that answers nothing for 10 s
    let mut guest_award = None;
    let mut guest_open = true;
    let award = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let found = tokio::select! {
            next = host.ws.next() => match next {
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<ServerMsg>(t.as_str()) {
                    Ok(ServerMsg::Xp(a)) => Some(a),
                    _ => None,
                },
                _ => None,
            },
            next = guest.ws.next(), if guest_open => {
                match next {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(ServerMsg::Xp(a)) = serde_json::from_str::<ServerMsg>(t.as_str()) {
                            guest_award = Some(a);
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => guest_open = false,
                }
                None
            }
            _ = tokio::time::sleep(left) => panic!("no experience before the deadline"),
        };
        if let Some(a) = found {
            break a;
        }
    };
    assert!(!award.quick);
    assert_eq!(award.xp, Some(award.gained as u64), "a new account's total is its first award");
    assert_eq!(award.level, level_of(award.gained as u64));
    let (_, _, me) = server.http("GET", "/api/account/me", Some(&alice), None).await;
    assert_eq!(me["xp"], award.gained, "{me}");
    // guests get the same award message, without an account total
    let guest_award = match guest_award {
        Some(a) => a,
        None => guest
            .until("guest award", |m| match m {
                ServerMsg::Xp(a) => Some(Ok(a.clone())),
                _ => None,
            })
            .await
            .unwrap(),
    };
    assert_eq!((guest_award.xp, guest_award.level), (None, 0));
    host.until("match end", |m| matches!(m, ServerMsg::MatchEnd { .. }).then_some(Ok(()))).await.unwrap();
}

#[tokio::test]
async fn race_finish_sets_a_fastest_time() {
    let server = Server::start();
    let alice = server.register("alice").await;
    // checkpoint 1 above the finish (2), under the spawn: falling passes both
    let race = r#"{"b":[{"1":0,"2":15,"3":13,"31":1,"s":[{"p":[-3,-0.25,3,-0.25,3,0.25,-3,0.25]}]},
        {"1":1,"2":15,"3":19,"31":2,"s":[{"p":[-3,-0.25,3,-0.25,3,0.25,-3,0.25]}]}],
        "j":[],"s":[{"1":15,"2":10}],"p":[],"tu":[],"tc":[],"gp":[],"c":[],"set":{"3":40,"15":40,"16":25}}"#;
    let body = json!({ "name": "race", "description": "", "code": neobox_sim::map::encode_code(race), "visibility": "unlisted" });
    let (status, _, made) = server.http("POST", "/api/library", Some(&alice), Some(body)).await;
    assert_eq!(status, 201, "{made}");
    let map = made["id"].as_i64().unwrap();

    let mut host = Client::connect_as(&server.ws(), "alice", Some(&alice)).await;
    host.create(None).await.unwrap();
    host.send(&ClientMsg::SetLibraryMap { id: map }).await;
    host.send(&ClientMsg::SetMode { mode: 0 }).await;
    host.chat("/set recordMode true").await;
    host.room_where("race map, kills, record mode", |r| r.map.as_ref().is_some_and(|m| m.id == map) && r.settings.record_mode).await;
    host.send(&ClientMsg::Start).await;
    let line = host
        .until("personal best", |m| match m {
            ServerMsg::Chat { from: None, text, .. } if text.contains("personal best") => Some(Ok(text.clone())),
            _ => None,
        })
        .await
        .unwrap();
    assert!(line.starts_with("alice set a personal best: ") && line.ends_with('s'), "{line}");
    let (status, _, rows) = server.http("GET", &format!("/api/library/{map}/records"), None, None).await;
    assert_eq!(status, 200, "{rows}");
    assert_eq!(rows.as_array().map(Vec::len), Some(1), "{rows}");
    assert_eq!((rows[0]["rank"].as_i64(), rows[0]["name"].as_str()), (Some(1), Some("alice")), "{rows}");
    assert!(rows[0]["ticks"].as_i64().is_some_and(|t| t > 0), "{rows}");
}

/// A page on another site must not use the visitor's cookie; the server's own origin and requests without one still work.
#[tokio::test]
async fn cross_site_requests_are_refused() {
    let server = Server::start();
    let alice = server.register("alice").await;
    let url = server.ws();

    let mut req = url.as_str().into_client_request().unwrap();
    req.headers_mut().insert("Origin", "https://evil.example".parse().unwrap());
    req.headers_mut().insert("Cookie", alice.parse().unwrap());
    match tokio_tungstenite::connect_async(req).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(res)) => assert_eq!(res.status(), 403),
        other => panic!("a foreign origin must be refused with 403, got {:?}", other.map(|_| ())),
    }

    let (status, _, body) = server.http_from("GET", "/api/friends", Some(&alice), Some("https://evil.example"), None).await;
    assert_eq!(status, 403, "{body}");

    // the test server's Host header is 127.0.0.1, so that is its own origin
    let (status, _, body) = server.http_from("GET", "/api/friends", Some(&alice), Some("http://127.0.0.1"), None).await;
    assert_eq!(status, 200, "{body}");
    let mut req = url.as_str().into_client_request().unwrap();
    req.headers_mut().insert("Origin", format!("http://127.0.0.1:{}", server.port).parse().unwrap());
    let (own, _) = tokio_tungstenite::connect_async(req).await.expect("the own origin connects");
    drop(own);
}

/// The same account in a second tab takes its seat over; the first tab is closed as replaced.
#[tokio::test]
async fn one_seat_per_account() {
    let server = Server::start();
    let alice = server.register("alice").await;
    let url = server.ws();

    let mut first = Client::connect_as(&url, "alice", Some(&alice)).await;
    let (seat, _) = first.create(None).await.unwrap();

    let mut second = Client::connect_as(&url, "alice", Some(&alice)).await;
    let (taken, room) = second.join(&seat.code, None, None).await.unwrap();
    assert_eq!(taken.you, seat.you, "the account keeps its seat");
    assert_eq!(room.players.len(), 1, "{:?}", room.players);

    let closed = tokio::time::timeout(WAIT, async {
        loop {
            match first.ws.next().await {
                Some(Ok(Message::Close(frame))) => return frame,
                Some(Ok(_)) => {}
                other => panic!("expected the first tab to be closed, got {other:?}"),
            }
        }
    })
    .await
    .expect("the first tab is closed");
    assert_eq!(closed.map(|f| f.reason.as_str().to_string()).as_deref(), Some("replaced"));
}

/// Invisible-only lines are dropped; bidi controls and zero-width characters are
/// removed from the rest; emoji joined by zero-width joiners stay whole.
#[tokio::test]
async fn chat_drops_invisible_characters() {
    let server = Server::start();
    let mut host = Client::connect(&server.ws(), "host").await;
    host.create(None).await.unwrap();

    host.chat("\u{200B}\u{202E}\u{FEFF}").await;
    host.chat("a\u{202E}bc\u{200B}").await;
    host.chat("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} hi").await;
    let mut lines = Vec::new();
    for _ in 0..2 {
        lines.push(
            host.until("chat line", |m| match m {
                ServerMsg::Chat { text, .. } if !text.ends_with("has joined the game") => Some(Ok(text.clone())),
                _ => None,
            })
            .await
            .unwrap(),
        );
    }
    assert_eq!(lines, ["abc", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} hi"]);
}
