//! Neobox networking core shared by the server and the browser client:
//! the wire protocol and the deterministic match timelines (server
//! authority + client prediction/rollback).

pub mod protocol;
pub mod replay;
pub mod timeline;

pub use protocol::*;
pub use replay::*;
pub use timeline::*;
