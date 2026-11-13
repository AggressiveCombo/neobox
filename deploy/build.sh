#!/usr/bin/env bash
# Builds everything the server needs into ./dist-server:
#   neobox-server          the server binary
#   client/                the web client (static files, incl. neobox.wasm)
#   maps/                  built-in maps
# Requirements: Rust (rustup) with the wasm32-unknown-unknown target, Bun.
set -euo pipefail
cd "$(dirname "$0")/.."

rustup target add wasm32-unknown-unknown >/dev/null

echo "== game module (WASM)"
cargo build --profile wasm --target wasm32-unknown-unknown -p neobox-wasm
mkdir -p client/public
cp target/wasm32-unknown-unknown/wasm/neobox_wasm.wasm client/public/neobox.wasm

echo "== web client"
(cd client && bun install --frozen-lockfile && bun run build)

echo "== server"
cargo build --release -p neobox-server

rm -rf dist-server
mkdir -p dist-server
cp target/release/neobox-server dist-server/
cp -r client/dist dist-server/client
cp -r maps dist-server/maps
echo "done: dist-server/"
