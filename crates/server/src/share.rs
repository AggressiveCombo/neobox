//! Link previews: a link to `/` or `/CODE` answers with the page's title and
//! description filled in for that room, so chat and social cards show what
//! the link opens. Only live public rooms without a password get a room card;
//! everything else is the generic page. Every shell also gets an absolute
//! `og:url` and `og:image`, which link scrapers require.

use crate::hub::{Hub, ROOM_CODE_CHARS};
use crate::room::RoomSummary;
use crate::admin;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Uri};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use std::net::SocketAddr;
use std::sync::Arc;

/// Brackets the preview tags of `client/index.html`, which are replaced.
const START: &str = "<!-- share:start -->";
const END: &str = "<!-- share:end -->";
/// The preview image as `client/index.html` names it (relative).
const IMAGE: &str = "content=\"/og.png\"";

/// Title and description of a link preview.
#[derive(Debug, PartialEq)]
struct Card {
    title: String,
    description: String,
}

/// Serves the app shell with absolute preview links and, for a `/CODE` or
/// `/?room=CODE` link to a live public room without a password, that room's
/// title and description. Other requests go to the static files unchanged.
pub async fn preview(State(hub): State<Arc<Hub>>, req: Request, next: Next) -> Response {
    let named = match *req.method() {
        Method::GET | Method::HEAD => shell_request(req.uri()),
        _ => None,
    };
    let Some(named) = named else { return next.run(req).await };
    let card = named.and_then(|code| find_room(&hub, &code)).and_then(|room| card_for(&room));
    let proxied = req.extensions().get::<ConnectInfo<SocketAddr>>().is_some_and(|peer| admin::via_trusted_proxy(&hub, peer.0));
    let origin = origin(&hub.cfg.public_url, req.headers(), proxied);
    let page = format!("{origin}{}", req.uri().path());
    let html = match tokio::fs::read_to_string(hub.cfg.static_dir.join("index.html")).await {
        Ok(template) => render(&template, card.as_ref(), &origin, &page),
        Err(_) => None,
    };
    match html {
        Some(html) => ([(header::CACHE_CONTROL, "no-cache")], Html(html)).into_response(),
        None => no_cache(next.run(req).await),
    }
}

/// The site's origin for absolute links: `NEOBOX_PUBLIC_URL` when set, else the
/// request's host with the scheme the proxy reports (https unless it says http).
fn origin(public_url: &str, headers: &HeaderMap, trust_proxy: bool) -> String {
    if !public_url.is_empty() {
        return public_url.to_string();
    }
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty());
    let host = (if trust_proxy { header("x-forwarded-host") } else { None }).or_else(|| header("host")).unwrap_or("localhost");
    let scheme = match (trust_proxy, header("x-forwarded-proto")) {
        (true, Some("http")) => "http",
        (true, Some(_)) => "https",
        // Without a proxy the server itself speaks plain HTTP.
        _ => "http",
    };
    // A host header is not escaped later; keep only characters a host may hold.
    let host: String = host.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')).collect();
    format!("{scheme}://{host}")
}

/// Whether `uri` asks for the app shell (`/`, `/CODE`, with any query) and, if
/// so, the room code it names. Like the client, `?room=` wins over the path.
/// `None` for every other path.
fn shell_request(uri: &Uri) -> Option<Option<String>> {
    let path = uri.path().trim_matches('/').to_ascii_uppercase();
    if !path.is_empty() && !is_code(&path) {
        return None;
    }
    let query = uri.query().unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("room="));
    let named = query.map(str::to_ascii_uppercase).or_else(|| (!path.is_empty()).then_some(path));
    Some(named.filter(|code| is_code(code)))
}

fn is_code(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| ROOM_CODE_CHARS.contains(&b))
}

/// The room with `code`, on this server or on a game node.
fn find_room(hub: &Hub, code: &str) -> Option<RoomSummary> {
    if let Some(handle) = hub.room(code) {
        return Some(handle.summary.lock().unwrap().clone());
    }
    let nodes = hub.nodes.lock().unwrap();
    let found = nodes.values().flat_map(|node| node.rooms.iter()).find(|room| room.code == code).cloned();
    found
}

/// The preview of a room anyone may join by link: listed as public, no password.
fn card_for(room: &RoomSummary) -> Option<Card> {
    if !room.public || room.password {
        return None;
    }
    let name = if room.name.trim().is_empty() { &room.code } else { &room.name };
    let seats = format!("{}/{} players", room.players.len(), room.max_players);
    let description = if room.map_name.is_empty() { seats } else { format!("{seats} on {}", room.map_name) };
    Some(Card { title: format!("{name} · neobox"), description })
}

/// `template` with an absolute `og:image` (`origin`), an `og:url` (`page`)
/// and, given a `card`, the text between its preview markers replaced by it.
/// Everything inserted is escaped. `None` if the markers are missing.
fn render(template: &str, card: Option<&Card>, origin: &str, page: &str) -> Option<String> {
    let start = template.find(START)? + START.len();
    let end = start + template[start..].find(END)?;
    let url = format!("\n    <meta property=\"og:url\" content=\"{}\" />", escape(page));
    let block = match card {
        Some(card) => {
            let title = escape(&card.title);
            let description = escape(&card.description);
            format!(
                "\n    <title>{title}</title>\n    <meta name=\"description\" content=\"{description}\" />\n    \
                 <meta property=\"og:title\" content=\"{title}\" />\n    \
                 <meta property=\"og:description\" content=\"{description}\" />{url}\n    "
            )
        }
        None => format!("{}{url}\n    ", template[start..end].trim_end()),
    };
    let rest = template[end..].replacen(IMAGE, &format!("content=\"{}/og.png\"", escape(origin)), 1);
    Some(format!("{}{block}{rest}", &template[..start]))
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Room-specific pages change with the room, so browsers must revalidate them.
fn no_cache(mut res: Response) -> Response {
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(s: &str) -> Uri {
        s.parse().unwrap()
    }

    fn room(public: bool, password: bool) -> RoomSummary {
        RoomSummary {
            code: "ABCDEF".into(),
            name: "Fun <b>".into(),
            public,
            password,
            max_players: 4,
            map_name: "Bridge".into(),
            players: vec![Default::default(), Default::default()],
            ..Default::default()
        }
    }

    #[test]
    fn shell_requests_name_rooms() {
        assert_eq!(shell_request(&uri("/")), Some(None));
        assert_eq!(shell_request(&uri("/abcdef")), Some(Some("ABCDEF".into())));
        assert_eq!(shell_request(&uri("/?room=ab2cd3")), Some(Some("AB2CD3".into())));
        assert_eq!(shell_request(&uri("/abcdef?room=zzzzz")), Some(None));
        assert_eq!(shell_request(&uri("/?room=")), Some(None));
        assert_eq!(shell_request(&uri("/ws")), None);
        assert_eq!(shell_request(&uri("/api/maps")), None);
        assert_eq!(shell_request(&uri("/og.png")), None);
        assert_eq!(shell_request(&uri("/ABCDEFG")), None);
        assert_eq!(shell_request(&uri("/ABC0EF")), None);
    }

    #[test]
    fn only_open_public_rooms_get_a_card() {
        assert!(card_for(&room(true, false)).is_some());
        assert!(card_for(&room(false, false)).is_none());
        assert!(card_for(&room(true, true)).is_none());
    }

    #[test]
    fn card_describes_the_room() {
        let card = card_for(&room(true, false)).unwrap();
        assert_eq!(card.title, "Fun <b> · neobox");
        assert_eq!(card.description, "2/4 players on Bridge");
        let lobby = RoomSummary { map_name: String::new(), name: " ".into(), code: "ABCDEF".into(), ..room(true, false) };
        let card = card_for(&lobby).unwrap();
        assert_eq!(card.title, "ABCDEF · neobox");
        assert_eq!(card.description, "2/4 players");
    }

    #[test]
    fn render_escapes_and_keeps_the_rest() {
        let template = "<head><title>neobox</title>\n<!-- share:start --><title>x</title><!-- share:end --><meta property=\"og:image\" content=\"/og.png\"></head>";
        let card = Card { title: "A & <b>".into(), description: "d \"q\"".into() };
        let out = render(template, Some(&card), "https://n.example", "https://n.example/ABCDEF").unwrap();
        assert!(out.starts_with("<head><title>neobox</title>\n<!-- share:start -->"));
        assert!(out.contains("<title>A &amp; &lt;b&gt;</title>"));
        assert!(out.contains("content=\"d &quot;q&quot;\""));
        assert!(!out.contains("<title>x</title>"));
        assert!(out.contains("<meta property=\"og:url\" content=\"https://n.example/ABCDEF\" />"));
        assert!(out.ends_with("<!-- share:end --><meta property=\"og:image\" content=\"https://n.example/og.png\"></head>"));
        assert_eq!(render("<head></head>", Some(&card), "o", "p"), None);
    }

    #[test]
    fn generic_shell_keeps_its_text_and_gets_absolute_links() {
        let template = "<!-- share:start --><title>neobox</title><!-- share:end --><meta property=\"og:image\" content=\"/og.png\">";
        let out = render(template, None, "http://localhost:8080", "http://localhost:8080/").unwrap();
        assert!(out.contains("<title>neobox</title>"));
        assert!(out.contains("og:url\" content=\"http://localhost:8080/\""));
        assert!(out.contains("og:image\" content=\"http://localhost:8080/og.png\""));
    }

    #[test]
    fn origin_prefers_the_public_url_then_the_proxy() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("127.0.0.1:8080"));
        assert_eq!(origin("https://neobox.example", &headers, true), "https://neobox.example");
        assert_eq!(origin("", &headers, true), "http://127.0.0.1:8080");
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        headers.insert("x-forwarded-host", HeaderValue::from_static("neobox.example\"><script>"));
        assert_eq!(origin("", &headers, true), "https://neobox.examplescript");
        assert_eq!(origin("", &headers, false), "http://127.0.0.1:8080");
    }
}
