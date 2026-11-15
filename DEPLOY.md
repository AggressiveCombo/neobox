# Deploying neobox

This guide puts neobox online at `https://neobox.aggressivecombo.com` on a
small Linux server. No prior server experience is assumed: every command is
given. Expect about an hour the first time.

## What runs where (and why)

```mermaid
flowchart LR
  B[Browser] -- "HTTPS + WebSocket (TCP 443)" --> C[Caddy]
  C -- "HTTP (127.0.0.1:8080)" --> S[neobox-server]
  B -- "WebRTC game data (UDP 3478)" --> S
```

* **One program, `neobox-server`**, does everything: it serves the web page,
  runs the game rooms, relays player inputs, and hosts the admin page. It is
  written in Rust, uses very little memory (a few MB per room) and keeps
  accounts, levels, the map library and recorded menu clips in one SQLite
  file (no database server to run).
* **Caddy** sits in front of it and handles HTTPS. It obtains and renews the
  certificate from Let's Encrypt automatically.
* **Game traffic** uses a WebRTC data channel over UDP when possible
  (lowest latency: a lost packet never holds up the next one) and falls back
  to the WebSocket automatically when UDP is blocked (some office or school
  networks). Nothing to configure in the browser.
* **Jukebox:** players' browsers load YouTube's embedded player directly; the
  server only makes outbound HTTPS requests to `www.youtube.com/oembed` to
  read video titles. If outbound HTTPS is blocked, suggestions show the
  video id instead of the title.

Why these choices: a single binary is the simplest thing to run and update;
Caddy is the simplest way to get HTTPS right; UDP is what fast-paced games
need, but WebSocket fallback keeps the game reachable everywhere.

## Requirements

| Item | Minimum | Notes |
| --- | --- | --- |
| VPS | 1 vCPU, 1 GB RAM, 10 GB disk | 2 vCPU / 2 GB is comfortable for hundreds of players. Any provider works (Hetzner, OVH, DigitalOcean, Vultr…). Pick a region close to your players. |
| OS | Debian 12 or Ubuntu 24.04 (64-bit) | Commands below assume one of these. |
| Public IPv4 | 1 | Included with every VPS. |
| Domain | `neobox.aggressivecombo.com` | You need access to the DNS settings of `aggressivecombo.com`. |
| Open ports | TCP 22, TCP 80, TCP 443, UDP 3478 | 22 = SSH (your access), 80/443 = web, 3478 = game data. |
| Bandwidth | ~5 KB/s per player | 1 TB/month (typical included traffic) is plenty. |

## 1. Create the server

1. Create a VPS with Debian 12 or Ubuntu 24.04 at your provider. Add your SSH
   key when asked (or note the root password).
2. Note its **public IPv4 address**, below written `203.0.113.10`.
3. If the provider has a cloud firewall, allow inbound TCP 22, 80, 443 and
   UDP 3478.

## 2. Point the domain at it

In the DNS settings of `aggressivecombo.com`, add a record:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `neobox` | `203.0.113.10` | Auto / 300 |

If the DNS is on Cloudflare, set the record to **DNS only** (grey cloud).
Wait a few minutes, then check from your PC: `nslookup neobox.aggressivecombo.com`
must print the server's IP.

## 3. Prepare the server

Connect: `ssh root@203.0.113.10`, then run:

```sh
apt update && apt upgrade -y
apt install -y curl git unzip gnupg build-essential ufw sqlite3 debian-keyring debian-archive-keyring apt-transport-https

# firewall
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 3478/udp
ufw --force enable

# a user without privileges for the game server
useradd --system --home /opt/neobox --shell /usr/sbin/nologin neobox
mkdir -p /opt/neobox

# Caddy (HTTPS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# build tools: Rust and Bun
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
curl -fsSL https://bun.sh/install | bash
source ~/.cargo/env && export PATH="$HOME/.bun/bin:$PATH"
```

## 4. Build neobox

Get the source onto the server. Once the repository is published on GitHub:

```sh
git clone https://github.com/AggressiveCombo/neobox.git ~/neobox
cd ~/neobox && git checkout rewrite
```

(Before it is published, copy it from your PC instead. `scp -r` would also copy
the large `target` and `node_modules` folders, so pack the source first. In
PowerShell on your PC:

```
tar --exclude=target --exclude=node_modules --exclude=dist-server -czf neobox.tgz -C C:\Users\aggressivecombo neobox-rewrite
scp neobox.tgz root@203.0.113.10:
```

then on the server: `mkdir -p ~/neobox && tar -xzf ~/neobox.tgz -C ~/neobox --strip-components=1`.)

If the server has only 1 GB of RAM, add swap first: the release build can run
out of memory without it.

```sh
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

Then build (5–15 minutes the first time):

```sh
cd ~/neobox
bash deploy/build.sh
```

This produces `dist-server/` with the server binary, the web client and the
built-in maps.

## 5. Install

```sh
cd ~/neobox
cp -r dist-server/* /opt/neobox/
chown -R neobox:neobox /opt/neobox

cp deploy/neobox.env.example /etc/neobox.env
chmod 600 /etc/neobox.env
nano /etc/neobox.env      # set NEOBOX_ADMIN_PASSWORD (long and random); Ctrl+O, Enter, Ctrl+X

cp deploy/neobox.service /etc/systemd/system/neobox.service
systemctl daemon-reload
systemctl enable --now neobox

# room list distances and flags: DB-IP's free city database, checked daily
cp deploy/neobox-geoip.service deploy/neobox-geoip.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now neobox-geoip.timer
systemctl start neobox-geoip.service    # first download now (about 60 MB)

cp deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Set `NEOBOX_LOCATION` in `/etc/neobox.env` to the server's latitude and
longitude (your provider's data centre city is close enough, e.g.
`50.11,8.68` for Frankfurt) so the room list can show distances.

## 6. Check

* `systemctl status neobox` shows `active (running)`; the log line
  `WebRTC transport listening (UDP)` confirms UDP is enabled and shows the
  address it advertises to players (`public=`), and
  `geolocation database loaded` (within a minute of the first download)
  confirms distances and flags.
* Open `https://neobox.aggressivecombo.com`: the menu appears.
* Open `https://neobox.aggressivecombo.com/admin` and log in with the
  admin password. Join a game from another tab: the room and player appear
  live; the player's ping column shows `udp` when WebRTC works, `ws` when it
  fell back to the WebSocket.

If players always show `ws`: check that UDP 3478 is open (both `ufw` and
the provider's firewall). The advertised address in that log line must be the
server's **public** IPv4: some providers put a private address on the network
interface, and the server then advertises that. In that case set
`NEOBOX_RTC_PUBLIC=<public IPv4>:3478` in `/etc/neobox.env` (the port is
required; a value without it is ignored), then `systemctl restart neobox`.

## Updating

```sh
cd ~/neobox && git pull && bash deploy/build.sh
systemctl stop neobox
cp dist-server/neobox-server dist-server/geoip-update.sh /opt/neobox/
rm -rf /opt/neobox/client && cp -r dist-server/client /opt/neobox/
cp dist-server/maps/*.json /opt/neobox/maps/
chown -R neobox:neobox /opt/neobox
systemctl start neobox
```

Stopping ends running matches; players reconnect from the menu. Accounts,
friends and the map library are kept (they live in `/var/lib/neobox`, which
updates never touch).

`/opt/neobox/maps/rotation/maps2.json` (the fixed quick-play rotation) is
never overwritten, so your edits survive. When a release changes it, compare
with `diff ~/neobox/dist-server/maps/rotation/maps2.json /opt/neobox/maps/rotation/maps2.json`
and merge by hand.

## Backups

Everything players create is in one SQLite database,
`/var/lib/neobox/neobox.db`. The server keeps it in WAL mode, so copying the
file while the server runs can give a broken copy; use SQLite's online backup
instead. A daily backup that keeps the last 14 days:

```sh
mkdir -p /var/backups/neobox
cat > /etc/cron.daily/neobox-backup <<'EOF'
#!/bin/sh
sqlite3 /var/lib/neobox/neobox.db ".backup '/var/backups/neobox/neobox-$(date +%F).db'"
find /var/backups/neobox -name 'neobox-*.db' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/neobox-backup
```

Copy `/var/backups/neobox` off the server now and then (a VPS can be lost).
To restore: `systemctl stop neobox`, copy a backup to
`/var/lib/neobox/neobox.db`, delete `neobox.db-wal` and `neobox.db-shm` next to
it, `chown neobox:neobox /var/lib/neobox/neobox.db`, `systemctl start neobox`.

## Regional game servers (optional)

Players far from the server get more lag. Like the original game, neobox
can run extra game servers in other regions: the main server keeps the
website, accounts, the map library, the admin page and the room list, and
each **game node** only runs rooms. The room list shows every server's rooms
with their region and distance; new rooms and quick play go to the server
nearest to the player; joining a room connects the browser to that room's
server.

```mermaid
flowchart LR
  B[Browser] -- "website, room list, accounts" --> M[main server]
  B -- "game socket + UDP for a room on the node" --> N[game node]
  N -- "rooms every 2 s, experience, votes (HTTPS + secret)" --> M
  M -- "admin actions" --> N
```

On the **main server**, in `/etc/neobox.env`:

```sh
NEOBOX_REGION=Frankfurt
NEOBOX_LOCATION=50.11,8.68
NEOBOX_PUBLIC_URL=https://neobox.aggressivecombo.com
NEOBOX_CLUSTER_SECRET=<a long random secret: openssl rand -hex 32>
```

then `systemctl restart neobox`.

For **each node**: a second small VPS in the other region, with its own DNS
name (for example an `A` record `us.neobox` → the node's IP). On it, follow
steps 1 to 5 above with two differences: copy
`deploy/neobox-node.env.example` (instead of `neobox.env.example`) to
`/etc/neobox.env` and fill in the main server's URL, the same secret, the
node's own URL, region and location; and use the node block of
`deploy/Caddyfile` with the node's name. The node needs no backups: it keeps
no data.

Within a few seconds the main server logs the node joining, and its admin
page lists the node's rooms with their region. A node that stops sending
drops out of the room list after 10 seconds. Restarting a node ends its
matches like restarting the main server does: its players return to the
main server's room list, so update nodes when few people play.

## Everyday operations

| Task | Command / place |
| --- | --- |
| Live rooms, players, tick rate, latency, bandwidth, logs, kick/ban, close rooms | `https://neobox.aggressivecombo.com/admin` |
| Approve or reject maps uploaded to the public library; find and delete any map | `https://neobox.aggressivecombo.com/admin`, "Map approvals" and "Map library" |
| Review player and map reports (open, resolve, dismiss, delete), search accounts and set a new password | `https://neobox.aggressivecombo.com/admin`, "Reports" and "Accounts" |
| Server log | `journalctl -u neobox -f` |
| Restart | `systemctl restart neobox` |
| Add built-in maps | put map files in `/opt/neobox/maps/` (`.txt` with a Hitbox map code, or `.json` compact map JSON), then restart |
| Change quick play | edit `/opt/neobox/maps/rotation/maps2.json` (hitbox.io's `rotationmaps/maps2.json` format: `meta.qp_1`..`qp_10` are the modes with `title`, `description`, `maxPlayers`, `teams`, `gameMode`, `limit`; `meta.custom` sets the game mode and limit of new custom rooms; each map lists its `modes`, and the first `custom` map is a new custom room's map), then restart. The main server adds the four best-rated public library maps of the past week to every mode without teams; regional nodes use the main server's rotation |
| Change limits | edit `/etc/neobox.env` (see comments there), then restart |

## Configuration reference

All settings are environment variables (in `/etc/neobox.env`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEOBOX_ADMIN_PASSWORD` | (empty: admin page disabled) | Admin page password. |
| `NEOBOX_BIND` | `127.0.0.1:8080` | HTTP address (Caddy forwards to it). |
| `NEOBOX_STATIC` | `client` | Web client directory. |
| `NEOBOX_MAPS` | `maps` | Built-in maps directory. |
| `NEOBOX_DATA` | `data/neobox.db` (the service sets `/var/lib/neobox/neobox.db`) | SQLite database: accounts, friends, map library. Created on first start. |
| `NEOBOX_RTC_BIND` | `0.0.0.0:3478` | UDP address for WebRTC game data; `off` disables WebRTC. |
| `NEOBOX_RTC_PUBLIC` | auto-detected | Public `IP:port` browsers use to reach the UDP port. |
| `NEOBOX_MAX_ROOMS` | `200` | Room limit. |
| `NEOBOX_MAX_PLAYERS` | `32` | Players per room limit (rooms choose 1..this). |
| `NEOBOX_MAX_CONNS_PER_IP` | `8` | Simultaneous connections per IP address. |
| `NEOBOX_TRUST_PROXY` | `true` | Use the client IP forwarded by Caddy. Set `false` if the server is exposed directly. |
| `NEOBOX_GEOIP` | (empty: no distances or flags; the service sets `/var/lib/neobox/dbip-city-lite.mmdb`) | MaxMind-format city database for the room list (`neobox-geoip.timer` keeps DB-IP's free one current). |
| `NEOBOX_LOCATION` | (empty) | This server's `latitude,longitude`; room list distances are measured to it. |
| `NEOBOX_REGION` | (empty) | Region name shown in the room list when there are game nodes. |
| `NEOBOX_PUBLIC_URL` | (empty) | Base URL browsers reach this server at. Required on game nodes. |
| `NEOBOX_CLUSTER_SECRET` | (empty: no nodes) | Secret shared by the main server and its game nodes. |
| `NEOBOX_MAIN` | (empty: this is the main server) | On a game node: the main server's base URL. |
| `RUST_LOG` | `info` | Log detail (`debug` for more). |

## Running locally (development)

On your PC (Windows, macOS or Linux) with Rust and Bun installed:

```sh
bash deploy/build.sh
cd dist-server
NEOBOX_ADMIN_PASSWORD=dev ./neobox-server      # Windows PowerShell: $env:NEOBOX_ADMIN_PASSWORD="dev"; .\neobox-server.exe
```

Open `http://127.0.0.1:8080` (game) and `http://127.0.0.1:8080/admin`.
