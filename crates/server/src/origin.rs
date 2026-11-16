//! Refuses requests that a page on another site sent with a visitor's
//! cookies (cross-site WebSocket hijacking and cross-site form posts).
//!
//! Browsers send an `Origin` header on every WebSocket upgrade and every
//! non-GET request made from another site. Requests without `Origin` come
//! from scripts and servers (the game nodes, the test probes) and pass.

use crate::hub::Hub;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::Arc;
use tracing::warn;

/// Whether an `Origin` header value may use a server reached at `host` (its
/// `Host` header) or is in `list` (lowercase origins such as
/// `https://neobox.example.org`). `null` and origins with a path are refused.
pub fn allowed(origin: &str, host: Option<&str>, list: &[String]) -> bool {
    let origin = origin.trim().to_ascii_lowercase();
    let Some(authority) = origin.strip_prefix("https://").or_else(|| origin.strip_prefix("http://")) else {
        return false;
    };
    if authority.is_empty() || authority.contains('/') {
        return false;
    }
    host.is_some_and(|h| h.eq_ignore_ascii_case(authority)) || list.iter().any(|o| *o == origin)
}

/// Middleware: answers 403 to a request whose `Origin` is not allowed.
pub async fn guard(State(hub): State<Arc<Hub>>, req: Request, next: Next) -> Response {
    let Some(origin) = req.headers().get(header::ORIGIN) else {
        return next.run(req).await;
    };
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok());
    if origin.to_str().is_ok_and(|o| allowed(o, host, &hub.cfg.allowed_origins)) {
        return next.run(req).await;
    }
    warn!(path = req.uri().path(), origin = ?origin, "refused a cross-origin request");
    (StatusCode::FORBIDDEN, "cross-origin request refused").into_response()
}

#[cfg(test)]
mod tests {
    use super::allowed;

    fn list() -> Vec<String> {
        vec!["https://game.example".into()]
    }

    #[test]
    fn own_host_is_allowed() {
        assert!(allowed("https://neobox.example.org", Some("neobox.example.org"), &[]));
        assert!(allowed("HTTPS://Neobox.Example.org", Some("neobox.example.org"), &[]));
        assert!(allowed("http://127.0.0.1:8080", Some("127.0.0.1:8080"), &[]));
    }

    #[test]
    fn other_sites_are_refused() {
        assert!(!allowed("https://evil.example", Some("neobox.example.org"), &[]));
        assert!(!allowed("http://127.0.0.1:9", Some("127.0.0.1:8080"), &[]));
        assert!(!allowed("https://neobox.example.org.evil.example", Some("neobox.example.org"), &[]));
        assert!(!allowed("null", Some("neobox.example.org"), &[]));
        assert!(!allowed("https://", Some("neobox.example.org"), &[]));
        assert!(!allowed("https://neobox.example.org/x", Some("neobox.example.org"), &[]));
        assert!(!allowed("https://neobox.example.org", None, &[]));
    }

    #[test]
    fn configured_origins_are_allowed() {
        assert!(allowed("https://game.example", Some("us.neobox.example.org"), &list()));
        assert!(!allowed("http://game.example", Some("us.neobox.example.org"), &list()));
        assert!(!allowed("https://evil.example", Some("us.neobox.example.org"), &list()));
    }
}
