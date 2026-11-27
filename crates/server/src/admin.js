"use strict";
const $ = (s) => document.querySelector(s);
let selected = null;
let autoSelectedOnce = false;
let lastState = null;
let viewPaused = false;
let logSeq = 0;
const logLines = [];
const teamName = ["spec", "ffa", "red", "blue"];
const modeNames = {
  0: "Kills",
  1: "Lives",
  2: "Rounds",
  3: "Team rounds",
  4: "Endless teams",
  5: "Lives teams",
  6: "Endless",
};
const levelRank = { TRACE: 0, DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB/s" : n >= 1024 ? (n / 1024).toFixed(1) + " kB/s" : n + " B/s";
const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " kB" : n + " B";
const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60; return (d ? d + "d " : "") + (h ? h + "h " : "") + m + "m " + (s % 60) + "s"; };
const fmtShortDate = (v) => {
  if (typeof v === "number") return new Date(v * 1000).toLocaleString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const maskText = (m) => ["←", "→", "↑", "↓", "X", "Z", "C", "V"].filter((_, i) => m & (1 << i)).join(" ") || "·";
const hex6 = (n) => "#" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");

// Rolling telemetry history for live sparklines (~2 minutes at 1s interval).
const HISTORY_MAX = 120;
const hist = { players: [], rooms: [], bwIn: [], bwOut: [], stepAvg: [], stepMax: [] };
function pushHist(key, val) {
  const arr = hist[key];
  arr.push(Number.isFinite(val) ? val : 0);
  if (arr.length > HISTORY_MAX) arr.shift();
}

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { credentials: "same-origin" } : {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return r;
}
function showLogin() { $("#app").hidden = true; $("#login").hidden = false; $("#pw").focus(); }
function showApp() { $("#login").hidden = true; $("#app").hidden = false; loadFeedback(true); loadClips(true); loadReports(true); loadAccounts(); }

$("#loginform").onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch("/admin/api/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $("#pw").value }) });
  if (r.ok) { $("#pw").value = ""; $("#loginerr").textContent = ""; showApp(); refresh(); pollLogs(); }
  else $("#loginerr").textContent = await r.text();
};
$("#logout").onclick = async () => { await fetch("/admin/api/logout", { method: "POST", credentials: "same-origin" }); showLogin(); };
$("#sayallbtn").onclick = async () => { const t = $("#sayall").value.trim(); if (t) { await api("/admin/api/broadcast", { text: t }); $("#sayall").value = ""; } };
$("#sayall").onkeydown = (e) => { if (e.key === "Enter") $("#sayallbtn").click(); };

function cmd(code, body) { return api("/admin/api/rooms/" + encodeURIComponent(code), body); }

// Table row reconciler: preserves existing rows & focused controls across 1s refreshes.
const rowCaches = new WeakMap();
const c = (html, cls = "") => ({ html: String(html), cls });
function syncRows(tb, rows) {
  const cache = rowCaches.get(tb) ?? new Map();
  rowCaches.set(tb, cache);
  const keep = new Set();
  const trs = rows.map(({ key, cls = "", cells, setup, sync }) => {
    keep.add(key);
    let row = cache.get(key);
    if (row === undefined) {
      row = { tr: document.createElement("tr"), shown: [] };
      for (let i = 0; i < cells.length; i++) row.tr.appendChild(document.createElement("td"));
      if (setup) setup(row.tr);
      cache.set(key, row);
    }
    row.tr.className = cls;
    cells.forEach((cell, i) => {
      const td = row.tr.cells[i];
      if (td.className !== cell.cls) td.className = cell.cls;
      if (row.shown[i] !== cell.html) {
        row.shown[i] = cell.html;
        td.innerHTML = cell.html;
      }
    });
    if (sync) sync(row.tr);
    return row.tr;
  });
  for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key);
  const listed = new Set(trs);
  for (const el of Array.from(tb.children)) if (!listed.has(el)) el.remove();
  trs.forEach((tr, i) => {
    if (tb.children[i] !== tr) tb.insertBefore(tr, tb.children[i] ?? null);
  });
}

function setBadge(id, count) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(count);
  el.hidden = !count;
}

function jumpTo(sel) {
  const el = $(sel);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// --- Shared FrameBuffer Canvas2D Renderer (used for Live Room/Lobby View AND Map Previews) ---
// Header layout (docs/CLIENT-API.md):
//   u[1]=worldVertCount, u[2]=worldVertOff (3 words/vert: x, y, abgr)
//   u[3]=playerCount, u[4]=playerOff (14 words/player!)
//   f[10]=arenaW, f[11]=arenaH, u[12]=bgTop, u[13]=bgBot, u[14]=tick
//   u[32]=barCount, u[33]=barOff (4 words: x, y, frac, rgb)
//   f[38..41]=fixedX0,fixedY0,fixedX1,fixedY1, f[42]=viewAspect
//   u[43]=turretCount, u[44]=turretOff (5 words: x, y, range, frac, rgb)
function drawFrameBuffer(canvas, buf, opts = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !buf || buf.byteLength < 180) return null;
  const u = new Uint32Array(buf), f = new Float32Array(buf);

  const dpr = Math.min(window.devicePixelRatio || 1, opts.dprMax || 2);
  const cssW = canvas.clientWidth || opts.fallbackW || 960;
  const cssH = canvas.clientHeight || opts.fallbackH || Math.round(cssW / 1.6);
  const W = Math.max(1, Math.round(cssW * dpr));
  const H = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }

  const n = u[1] || 0;
  const off = u[2] || 0;
  let aw = f[10] || 0;
  let ah = f[11] || 0;
  let minX = 0, minY = 0;
  const hasArena = aw > 0 && ah > 0;
  if (!hasArena) {
    // Unbounded map: fall back to static geometry bounds (f[38..41]) or triangle vertex bounds.
    const fx0 = f[38], fy0 = f[39], fx1 = f[40], fy1 = f[41];
    if (Number.isFinite(fx0) && Number.isFinite(fy0) && Number.isFinite(fx1) && Number.isFinite(fy1) && fx1 > fx0 && fy1 > fy0) {
      const padX = Math.max(2, (fx1 - fx0) * 0.08);
      const padY = Math.max(2, (fy1 - fy0) * 0.08);
      minX = fx0 - padX; minY = fy0 - padY;
      aw = (fx1 - fx0) + padX * 2;
      ah = (fy1 - fy0) + padY * 2;
    } else if (n > 0) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const vx = f[off + i * 3], vy = f[off + i * 3 + 1];
        if (vx < x0) x0 = vx; if (vx > x1) x1 = vx;
        if (vy < y0) y0 = vy; if (vy > y1) y1 = vy;
      }
      if (x1 > x0 && y1 > y0) {
        minX = x0 - 2; minY = y0 - 2; aw = (x1 - x0) + 4; ah = (y1 - y0) + 4;
      } else {
        aw = 35; ah = 22;
      }
    } else {
      aw = 35; ah = 22;
    }
  }

  const pad = opts.thumb ? 0.98 : 0.96;
  const scale = Math.min((W * pad) / aw, (H * pad) / ah);
  const rw = aw * scale, rh = ah * scale;
  const ox = (W - rw) / 2 - minX * scale;
  const oy = (H - rh) / 2 - minY * scale;
  const ax = (W - rw) / 2, ay = (H - rh) / 2;

  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.beginPath();
  ctx.rect(ax, ay, rw, rh);
  ctx.clip();

  // Map background gradient
  const top = u[12] || 0, bot = u[13] || 0;
  const g = ctx.createLinearGradient(0, ay, 0, ay + rh);
  g.addColorStop(0, hex6(top));
  g.addColorStop(1, hex6(bot));
  ctx.fillStyle = g;
  ctx.fillRect(ax, ay, rw, rh);

  // World geometry triangles (3 words per vertex: x, y, packed ABGR)
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(0.5, 0.55 * dpr);
  for (let i = 0; i + 2 < n; i += 3) {
    const a = off + i * 3;
    const c0 = u[a + 2], c1 = u[a + 5], c2 = u[a + 8];
    const r = (((c0 & 255) + (c1 & 255) + (c2 & 255)) / 3) | 0;
    const gr = ((((c0 >>> 8) & 255) + ((c1 >>> 8) & 255) + ((c2 >>> 8) & 255)) / 3) | 0;
    const b = ((((c0 >>> 16) & 255) + ((c1 >>> 16) & 255) + ((c2 >>> 16) & 255)) / 3) | 0;
    const al = (((c0 >>> 24) & 255) + ((c1 >>> 24) & 255) + ((c2 >>> 24) & 255)) / (3 * 255);
    if (al <= 0.002) continue;
    const col = `rgba(${r},${gr},${b},${al.toFixed(3)})`;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(ox + f[a] * scale, oy + f[a + 1] * scale);
    ctx.lineTo(ox + f[a + 3] * scale, oy + f[a + 4] * scale);
    ctx.lineTo(ox + f[a + 6] * scale, oy + f[a + 7] * scale);
    ctx.closePath();
    ctx.fill();
    if (al > 0.95 && !opts.thumb) {
      ctx.strokeStyle = col;
      ctx.stroke();
    }
  }

  // Turret range rings & health arcs (5 words each: x, y, range, frac, rgb)
  const tc = u[43] || 0, to = u[44] || 0;
  for (let i = 0; i < tc; i++) {
    const a = to + i * 5;
    const tx = ox + f[a] * scale, ty = oy + f[a + 1] * scale;
    const range = f[a + 2] * scale, frac = f[a + 3], rgb = u[a + 4];
    const col = hex6(rgb || 0xffffff);
    if (range > 2) {
      ctx.save();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.arc(tx, ty, range, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (!opts.thumb && frac > 0 && frac < 0.999) {
      const bw = 24 * dpr, bh = 3.5 * dpr;
      ctx.fillStyle = "rgba(0,0,0,.6)";
      ctx.fillRect(tx - bw / 2, ty - 14 * dpr, bw, bh);
      ctx.fillStyle = col;
      ctx.fillRect(tx - bw / 2, ty - 14 * dpr, bw * Math.max(0, Math.min(1, frac)), bh);
    }
  }

  // Body damage bars (4 words each: x, y, frac, rgb)
  const bc = u[32] || 0, bo = u[33] || 0;
  if (!opts.thumb) {
    for (let i = 0; i < bc; i++) {
      const a = bo + i * 4;
      const bx = ox + f[a] * scale, by = oy + f[a + 1] * scale;
      const frac = Math.max(0, Math.min(1, f[a + 2]));
      const bw = 28 * dpr, bh = 4 * dpr;
      ctx.fillStyle = "rgba(0,0,0,.6)";
      ctx.fillRect(bx - bw / 2, by - bh / 2, bw, bh);
      ctx.fillStyle = hex6(u[a + 3] || 0x44cc66);
      ctx.fillRect(bx - bw / 2, by - bh / 2, bw * frac, bh);
    }
  }

  // Players (14 words each!)
  const pc = u[3] || 0, po = u[4] || 0;
  const names = opts.names || {};
  const colors = opts.colors || {};
  const showNames = opts.showNames !== false && !opts.thumb;
  for (let i = 0; i < pc; i++) {
    const a = po + i * 14;
    const id = u[a], x = f[a + 1], y = f[a + 2], ang = f[a + 3], team = u[a + 4];
    const flags = u[a + 6], size = f[a + 8] || 1, health = f[a + 9];
    const ghost = (flags & 2) !== 0;
    const px = ox + x * scale, py = oy + y * scale, s = Math.max(4 * dpr, size * scale);
    const fill = team === 2 ? "#d44234" : team === 3 ? "#347bd4" : (colors[id] ? hex6(colors[id]) : "#f9fc91");

    ctx.save();
    if (ghost) ctx.globalAlpha = 0.35;
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.fillStyle = fill;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeStyle = "rgba(0,0,0,.65)";
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.restore();

    if (!opts.thumb && health > 0 && health < 0.99 && !ghost) {
      const bw = Math.max(s * 1.2, 20 * dpr), bh = 3 * dpr;
      ctx.fillStyle = "rgba(0,0,0,.65)";
      ctx.fillRect(px - bw / 2, py + s / 2 + 3 * dpr, bw, bh);
      ctx.fillStyle = health > 0.35 ? "#3acf60" : "#e34a6f";
      ctx.fillRect(px - bw / 2, py + s / 2 + 3 * dpr, bw * Math.max(0, Math.min(1, health)), bh);
    }

    if (showNames) {
      const label = names[id] || "#" + id;
      const fs = Math.max(10 * dpr, Math.min(14 * dpr, scale * 0.42));
      ctx.font = `600 ${fs}px "Hanken Grotesk", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const tw = ctx.measureText(label).width;
      const ly = py - s / 2 - 4 * dpr;
      ctx.fillStyle = "rgba(10,10,10,.72)";
      ctx.fillRect(px - tw / 2 - 4 * dpr, ly - fs - 2 * dpr, tw + 8 * dpr, fs + 3 * dpr);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, px, ly);
    }
  }

  // Optional spawn point overlay (used by Map Inspector)
  if (opts.showSpawns && Array.isArray(opts.spawns) && opts.spawns.length) {
    const r = Math.max(5 * dpr, Math.min(10 * dpr, scale * 0.42));
    for (const sp of opts.spawns) {
      const sx = ox + sp.x * scale, sy = oy + sp.y * scale;
      const col = sp.red && !sp.blue && !sp.ffa ? "#e53935"
        : sp.blue && !sp.red && !sp.ffa ? "#1e88e5"
        : sp.ffa && !sp.red && !sp.blue ? "#f59e0b"
        : "#a855f7";
      const tag = (sp.ffa ? "F" : "") + (sp.red ? "R" : "") + (sp.blue ? "B" : "") || "S";
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.88;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1.5, 1.5 * dpr);
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tag, sx, sy + 0.5 * dpr);
      ctx.restore();
    }
  }

  ctx.restore();
  // Crisp arena frame outline
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeRect(ax + 0.5, ay + 0.5, rw - 1, rh - 1);

  return { tick: u[14] || 0, triangles: Math.floor(n / 3), players: pc, arenaW: f[10] || 0, arenaH: f[11] || 0, viewAspect: f[42] || 1.6 };
}

// --- Sparkline Chart Renderer ---
function drawSpark(id, series, fmtVal) {
  const canvas = $(id);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(1, Math.round((canvas.clientWidth || 260) * dpr));
  const H = Math.max(1, Math.round((canvas.clientHeight || 64) * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  ctx.clearRect(0, 0, W, H);

  let maxV = 1;
  for (const s of series) for (const v of s.data) if (v > maxV) maxV = v;
  // Subtle baseline & mid gridlines
  ctx.strokeStyle = "rgba(10,10,10,.09)";
  ctx.lineWidth = Math.max(1, dpr);
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const y = Math.round((H - 4 * dpr) * frac) + 2 * dpr;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  const padY = 4 * dpr, plotH = H - padY * 2;
  for (const s of series) {
    const arr = s.data;
    if (arr.length < 2) continue;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = (i / (HISTORY_MAX - 1)) * W + (HISTORY_MAX - arr.length) / (HISTORY_MAX - 1) * W;
      const y = H - padY - (arr[i] / maxV) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.75 * dpr;
    ctx.stroke();
    if (s.fill) {
      ctx.lineTo(W, H - padY);
      const x0 = ((HISTORY_MAX - arr.length) / (HISTORY_MAX - 1)) * W;
      ctx.lineTo(x0, H - padY);
      ctx.closePath();
      ctx.fillStyle = s.fill;
      ctx.fill();
    }
  }
  if (fmtVal) {
    ctx.fillStyle = "rgba(92,92,92,.85)";
    ctx.font = `${10 * dpr}px "Hanken Grotesk", system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("max " + fmtVal(maxV), W - 2 * dpr, 1 * dpr);
  }
}

// --- Insights KPI rendering ---
function renderInsights(st) {
  const s = st.server;
  const ins = st.insights || {};
  const counts = ins.counts || {};
  const udp = ins.udp_players || 0, ws = ins.ws_players || 0;
  const avgPing = ins.avg_ping_ms || 0, p95Ping = ins.p95_ping_ms || 0;
  const avgStep = ins.avg_step_us || 0, maxStep = ins.max_step_us || 0;
  const budgetPct = Math.min(100, (maxStep / 33333) * 100);
  const stepClass = maxStep > 25000 ? "bad" : maxStep > 12000 ? "warn" : "";
  const pingClass = p95Ping >= 160 ? "bad-txt" : p95Ping >= 80 ? "warn-txt" : "good-txt";
  const pending = counts.pending_maps || 0;
  const reports = counts.open_reports || 0;
  const openBugs = counts.open_bugs || 0;
  const openSug = counts.open_suggestions || 0;
  const openFb = openBugs + openSug;
  const modes = (ins.modes || []).map((m) => `${modeNames[m.mode] || "Mode " + m.mode}: ${m.players}`).join(" · ") || "No active rooms";
  const nodes = ins.nodes || [];

  pushHist("players", s.players);
  pushHist("rooms", s.rooms);
  pushHist("bwIn", s.bytes_in_per_s);
  pushHist("bwOut", s.bytes_out_per_s);
  pushHist("stepAvg", avgStep);
  pushHist("stepMax", maxStep);

  setBadge("#nav-rooms", s.rooms);
  setBadge("#nav-maps", pending);
  setBadge("#nav-feedback", openFb);
  setBadge("#nav-reports", reports);

  $("#insights-sub").textContent = nodes.length
    ? `Primary + ${nodes.length} cluster node${nodes.length === 1 ? "" : "s"} (${nodes.map((n) => n.region).join(", ")})`
    : `Single node · ${s.connections} active connections`;

  $("#kpis").innerHTML = `
    <div class="kpi clickable" data-jump="#sec-rooms">
      <div class="k-lbl"><span>Players online</span><span>${udp} UDP · ${ws} WS</span></div>
      <div class="k-val">${s.players}</div>
      <div class="k-sub">${esc(modes)}</div>
    </div>
    <div class="kpi clickable" data-jump="#sec-rooms">
      <div class="k-lbl"><span>Rooms</span><span>cap ${s.max_rooms}</span></div>
      <div class="k-val">${s.rooms}</div>
      <div class="k-sub">${ins.in_match_rooms || 0} in match · ${ins.lobby_rooms || 0} in lobby</div>
    </div>
    <div class="kpi">
      <div class="k-lbl"><span>Player ping</span><span>p95</span></div>
      <div class="k-val ${p95Ping ? pingClass : ""}">${p95Ping ? `${Math.round(avgPing)} / ${p95Ping} ms` : "—"}</div>
      <div class="k-sub">${s.players ? "avg / p95 RTT across live rooms" : "No connected players"}</div>
    </div>
    <div class="kpi">
      <div class="k-lbl"><span>Sim step time</span><span>33.3ms budget</span></div>
      <div class="k-val">${maxStep ? `${Math.round(avgStep)} / ${Math.round(maxStep)} µs` : "0 µs"}</div>
      <div class="bar-track"><div class="bar-fill ${stepClass}" style="width:${budgetPct.toFixed(1)}%"></div></div>
    </div>
    <div class="kpi clickable ${pending > 0 ? "warn" : ""}" data-jump="#sec-maps">
      <div class="k-lbl"><span>Map approvals</span><span>queue</span></div>
      <div class="k-val ${pending > 0 ? "warn-txt" : ""}">${pending}</div>
      <div class="k-sub">${pending > 0 ? "Click to review pending maps" : "Queue clear"}</div>
    </div>
    <div class="kpi clickable ${openBugs > 0 ? "alert" : openSug > 0 ? "warn" : ""}" data-jump="#sec-feedback">
      <div class="k-lbl"><span>Bugs &amp; ideas</span><span>feedback</span></div>
      <div class="k-val ${openBugs > 0 ? "bad-txt" : openSug > 0 ? "warn-txt" : ""}">${openBugs} / ${openSug}</div>
      <div class="k-sub">${openFb > 0 ? `${openBugs} open bug${openBugs === 1 ? "" : "s"} · ${openSug} suggestion${openSug === 1 ? "" : "s"}` : "No open feedback"}</div>
    </div>
    <div class="kpi clickable ${reports > 0 ? "alert" : ""}" data-jump="#sec-reports">
      <div class="k-lbl"><span>Open reports</span><span>moderation</span></div>
      <div class="k-val ${reports > 0 ? "bad-txt" : ""}">${reports}</div>
      <div class="k-sub">${counts.accounts || 0} accounts · ${counts.maps || 0} maps · ${counts.clips || 0} clips</div>
    </div>`;
  for (const card of $("#kpis").querySelectorAll(".kpi[data-jump]")) {
    card.onclick = () => jumpTo(card.dataset.jump);
  }

  $("#chart-pop-lbl").textContent = `${s.players} players · ${s.rooms} rooms`;
  $("#chart-bw-lbl").textContent = `in ${fmtBytes(s.bytes_in_per_s)} · out ${fmtBytes(s.bytes_out_per_s)}`;
  $("#chart-step-lbl").textContent = `avg ${Math.round(avgStep)} µs · max ${Math.round(maxStep)} µs`;

  drawSpark("#chart-pop", [
    { data: hist.rooms, color: "#777777" },
    { data: hist.players, color: "#006fe0", fill: "rgba(0,111,224,.12)" },
  ], (v) => Math.round(v));
  drawSpark("#chart-bw", [
    { data: hist.bwIn, color: "#006fe0" },
    { data: hist.bwOut, color: "#18794e", fill: "rgba(24,121,78,.12)" },
  ], fmtBytes);
  drawSpark("#chart-step", [
    { data: hist.stepAvg, color: "#006fe0" },
    { data: hist.stepMax, color: "#b3261e", fill: "rgba(179,38,30,.1)" },
  ], (v) => Math.round(v) + "µs");
}

function renderState(st) {
  lastState = st;
  const s = st.server;
  $("#srv").innerHTML = `<span>up <b>${fmtTime(s.uptime_s)}</b></span><span>conn <b>${s.connections}</b></span><span>rooms <b>${s.rooms}</b>/${s.max_rooms}</span><span>players <b>${s.players}</b></span><span>in <b>${fmtBytes(s.bytes_in_per_s)}</b></span><span>out <b>${fmtBytes(s.bytes_out_per_s)}</b></span><span class="muted">v${esc(s.version)}</span>`;

  renderInsights(st);

  // Auto-select the first room on initial load so Live View works right away.
  if (!autoSelectedOnce && !selected && st.rooms.length > 0) {
    selected = st.rooms[0].code;
    autoSelectedOnce = true;
  }

  const tb = $("#rooms tbody");
  $("#norooms").hidden = st.rooms.length > 0;
  $("#rooms-sub").textContent = st.rooms.length ? `${st.rooms.length} active · click to inspect` : "No active rooms";
  syncRows(tb, st.rooms.map((r) => {
    const stepCls = r.step_max_us > 25000 ? "num bad-txt" : r.step_max_us > 12000 ? "num warn-txt" : "num";
    return {
      key: r.code,
      cls: r.code === selected ? "sel" : "",
      cells: [
        c(`<b>${esc(r.code)}</b>`),
        c(esc(r.region || "")),
        c(`${esc(r.name)}${r.password ? " 🔒" : ""}${r.public ? "" : " <span class=muted>(private)</span>"}`),
        c(esc(modeNames[r.game_mode] || "Mode " + r.game_mode)),
        c(`${r.players.length}/${r.max_players}`, "num"),
        c(r.in_match ? `<span class="pill live"><span class="dot"></span>match ${fmtTime(r.match_seconds)}</span>` : `<span class="pill lobby">lobby</span>`),
        c(`${r.tick} <span class=muted>@${r.tick_hz}</span>`, "num"),
        c(`${r.step_avg_us.toFixed(0)} / ${r.step_max_us.toFixed(0)}`, stepCls),
        c(`${fmtBytes(r.bytes_in_per_s)} / ${fmtBytes(r.bytes_out_per_s)}`, "num"),
        c(esc(r.map_name)),
      ],
      setup: (tr) => { tr.onclick = () => { selected = r.code; renderState(lastState); pollView(); }; },
    };
  }));
  const room = st.rooms.find((r) => r.code === selected);
  renderRoom(room);
}

function renderRoom(r) {
  const ptb = $("#players tbody");
  if (!r) {
    $("#roomtitle").textContent = "Room";
    $("#roomdetail").dataset.code = "";
    $("#roomdetail").innerHTML = "<span class=muted>Select a room to manage controls, scores, and live chat.</span>";
    $("#players-sub").textContent = "";
    syncRows(ptb, []);
    return;
  }
  $("#roomtitle").textContent = "Room " + r.code + " · " + r.name;
  $("#players-sub").textContent = `${r.players.length} / ${r.max_players} players`;
  const round = r.round;
  const set = r.settings || {};
  let scores = "";
  if (round) {
    scores = `<div class="row muted">round ${round.round} · red ${round.red} · blue ${round.blue} · bodies ${round.bodies} · projectiles ${round.projectiles}</div>` +
      "<div class=\"scroll\"><table><thead><tr><th>Player</th><th>Team</th><th class=num>Kills</th><th class=num>Wins</th><th class=num>Lives</th><th>Alive</th></tr></thead><tbody>" +
      round.players.map((p) => `<tr><td>${esc((r.players.find((q) => q.id === p.id) || {}).name || "#" + p.id)}</td><td class="t${p.team}">${teamName[p.team] || p.team}</td><td class=num>${p.kills}</td><td class=num>${p.wins}</td><td class=num>${p.lives}</td><td>${p.alive ? "yes" : "no"}</td></tr>`).join("") + "</tbody></table></div>";
  }
  if (!$("#roomdetail").dataset.code || $("#roomdetail").dataset.code !== r.code) {
    $("#roomdetail").dataset.code = r.code;
    $("#roomdetail").innerHTML = `
      <div id="roominfo"></div>
      <div class="row">
        <button id="endmatch">End match</button>
        <label>Tick rate <input id="hz" type="number" min="5" max="120" step="1" style="width:70px"></label><button id="sethz">Set</button>
        <label>Max players <input id="maxp" type="number" min="1" max="64" style="width:60px"></label><button id="setmax">Set</button>
        <button id="close" class="bad">Close room</button>
      </div>
      <div class="row"><input id="say" placeholder="Message to this room" style="flex:1"><button id="saybtn" class="primary">Send</button></div>
      <div id="scores"></div>
      <div class="muted" style="margin-top:8px;font-size:12px;font-weight:600">Recent room chat</div>
      <div id="roomchat" class="chat-box"></div>`;
    $("#endmatch").onclick = () => cmd(r.code, { action: "end_match" });
    $("#sethz").onclick = async () => { const res = await cmd(r.code, { action: "set_tick_rate", hz: Number($("#hz").value) }); if (!res.ok) alert(await res.text()); };
    $("#setmax").onclick = () => cmd(r.code, { action: "set_max_players", max: Number($("#maxp").value) });
    $("#close").onclick = () => { if (confirm("Close room " + r.code + "?")) cmd(r.code, { action: "close" }); };
    $("#saybtn").onclick = () => { const t = $("#say").value.trim(); if (t) { cmd(r.code, { action: "say", text: t }); $("#say").value = ""; } };
    $("#say").onkeydown = (e) => { if (e.key === "Enter") $("#saybtn").click(); };
    $("#hz").value = r.tick_hz;
    $("#maxp").value = r.max_players;
  }
  const jukebox = r.jukebox ? ` · ♪ ${esc(r.jukebox.title || r.jukebox.video)}` : "";
  $("#roominfo").innerHTML = `<div class="row muted">${esc(modeNames[set.game_mode] || "Mode " + set.game_mode)} · ${r.in_match ? "in match" : "lobby"} · ${r.players.length}/${r.max_players} players · map <b>${esc(r.map_name)}</b>${jukebox}</div>`;
  $("#scores").innerHTML = scores;

  const chatEl = $("#roomchat");
  if (chatEl) {
    const chat = r.recent_chat || [];
    const html = chat.length
      ? chat.map((m) => `<div class="chat-line"><span class="t">${esc(new Date(m.at * 1000).toLocaleTimeString())}</span><span class="n">${esc(m.name)}:</span>${esc(m.text)}</div>`).join("")
      : `<span class="muted">No recent chat messages.</span>`;
    if (chatEl.dataset.html !== html) {
      const atBottom = chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - 20;
      chatEl.dataset.html = html;
      chatEl.innerHTML = html;
      if (atBottom) chatEl.scrollTop = chatEl.scrollHeight;
    }
  }

  syncRows(ptb, r.players.map((p) => ({
    key: `${r.code}:${p.id}`,
    cells: [
      c(p.id, "num"),
      c(`<span class="dot" style="background:${hex6(p.color || 0xf9fc91)};border:1px solid rgba(0,0,0,.35);margin-right:5px"></span>${esc(p.name)}${p.host ? " <span class=pill>host</span>" : ""}`),
      c(teamName[p.team] || p.team, "t" + p.team),
      c(`${p.ping_ms} ms <span class=muted>${esc(p.transport)}</span>`, "num"),
      c(p.margin_ticks.toFixed(2), "num"),
      c(`${fmtBytes(p.bytes_in_per_s)} / ${fmtBytes(p.bytes_out_per_s)}`, "num"),
      c(maskText(p.input_mask)),
      c(fmtTime(p.connected_s)),
      c(esc(p.ip), "muted"),
    ],
    setup: (tr) => {
      const actions = document.createElement("td");
      tr.appendChild(actions);
      const mk = (label, body, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = () => cmd(r.code, body); actions.appendChild(b); };
      mk("Host", { action: "set_host", player: p.id });
      const sel = document.createElement("select");
      sel.innerHTML = teamName.map((t, i) => `<option value="${i}">${t}</option>`).join("");
      sel.onchange = () => cmd(r.code, { action: "set_team", player: p.id, team: Number(sel.value) });
      actions.appendChild(sel);
      mk("Kick", { action: "kick", player: p.id, ban: false }, "bad");
      mk("Ban", { action: "kick", player: p.id, ban: true }, "bad");
    },
    sync: (tr) => {
      const sel = tr.querySelector("select");
      if (sel.value !== String(p.team)) sel.value = String(p.team);
    },
  })));
}

// --- Cached Map Preview Loader (for Approvals, Library, and Inspector) ---
const previewCache = new Map();
function fetchMapPreview(id) {
  if (previewCache.has(id)) return previewCache.get(id);
  const p = api("/admin/api/maps/" + id + "/preview")
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
  previewCache.set(id, p);
  if (previewCache.size > 120) {
    const firstKey = previewCache.keys().next().value;
    previewCache.delete(firstKey);
  }
  return p;
}
function paintThumb(canvas, mapId) {
  if (!canvas || canvas.dataset.painted === String(mapId)) return;
  canvas.dataset.painted = String(mapId);
  fetchMapPreview(mapId).then((buf) => {
    if (!buf || !canvas.isConnected) return;
    drawFrameBuffer(canvas, buf, { thumb: true, showNames: false, fallbackW: 112, fallbackH: 70, dprMax: 2 });
  });
}

// --- Map Inspector Dialog (no code copying needed!) ---
let modalState = null;
const mapModal = $("#mapmodal");
$("#modalclose").onclick = () => mapModal.close();
mapModal.addEventListener("click", (e) => { if (e.target === mapModal) mapModal.close(); });
$("#modalspawns").onchange = () => redrawModalCanvas();

function redrawModalCanvas() {
  if (!modalState || !modalState.buf) return;
  const a = modalState.analysis || {};
  const info = drawFrameBuffer($("#modalcanvas"), modalState.buf, {
    showNames: false,
    showSpawns: $("#modalspawns").checked,
    spawns: a.spawn_points || [],
    fallbackW: 560,
    fallbackH: 350,
  });
  if (info) {
    const dim = a.arena_w > 0 && a.arena_h > 0
      ? `${a.arena_w} × ${a.arena_h} · ${a.wide ? "16:9 wide" : "16:10 classic"}`
      : `unbounded · ${a.wide ? "16:9 wide" : "16:10 classic"}`;
    $("#modaldim").textContent = `${dim} · ${info.triangles} triangles · ${a.spawns || 0} spawns`;
  }
}

async function openMapInspector(id) {
  modalState = { id, buf: null, detail: null, analysis: null };
  $("#modaltitle").innerHTML = `Map #${esc(id)} <span class="muted">loading…</span>`;
  $("#modaldim").textContent = "Loading preview…";
  $("#modalwarns").innerHTML = "";
  $("#modalstats").innerHTML = "";
  $("#modaldesc").hidden = true;
  $("#modalactions").innerHTML = "";
  $("#modalmsg").textContent = "";
  $("#modalcode").hidden = true;
  const ctx = $("#modalcanvas").getContext("2d");
  if (ctx) { ctx.fillStyle = "#0b0d12"; ctx.fillRect(0, 0, $("#modalcanvas").width, $("#modalcanvas").height); }
  if (!mapModal.open) mapModal.showModal();

  const [inspectRes, previewBuf] = await Promise.all([
    api("/admin/api/maps/" + id + "/inspect").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchMapPreview(id),
  ]);
  if (!modalState || modalState.id !== id) return;
  if (!inspectRes) {
    $("#modaltitle").textContent = "Map #" + id;
    $("#modalwarns").innerHTML = `<div class="warn-item err">Could not load map details.</div>`;
    return;
  }
  const d = inspectRes.detail;
  const a = inspectRes.analysis || {};
  modalState.detail = d;
  modalState.analysis = a;
  modalState.buf = previewBuf;

  const statusPill = `<span class="pill ${esc(d.status)}">${esc(d.status)}</span>`;
  const visPill = `<span class="pill">${esc(d.visibility)}</span>`;
  const pickPill = d.pick ? `<span class="pill pick">picked</span>` : "";
  $("#modaltitle").innerHTML = `${esc(d.name)} <span class="muted">by ${esc(d.author)}</span> ${statusPill} ${visPill} ${pickPill}`;

  // Warnings / automated sanity checks
  const warns = a.warnings || [];
  if (!a.ok) {
    $("#modalwarns").innerHTML = `<div class="warn-item err">Decode failed: ${esc(a.error || "invalid map")}</div>`;
  } else if (warns.length) {
    $("#modalwarns").innerHTML = warns.map((w) => `<div class="warn-item">${esc(w)}</div>`).join("");
  } else {
    $("#modalwarns").innerHTML = `<div class="warn-item ok">No structural issues detected.</div>`;
  }

  // Stats grid
  const statCells = [
    ["Bodies / Shapes", a.ok ? `${a.bodies} / ${a.shapes}` : "—"],
    ["Spawns (F/R/B)", a.ok ? `${a.spawns} (${a.spawns_ffa}/${a.spawns_red}/${a.spawns_blue})` : "—"],
    ["Joints / Turrets", a.ok ? `${a.joints} / ${a.turrets}` : "—"],
    ["Death / Obj", a.ok ? `${a.death_bodies} / ${a.objective_bodies}` : "—"],
    ["Checkpoints", a.ok ? `${a.checkpoints}` : "—"],
    ["Grapples / Caps", a.ok ? `${a.grapples} / ${a.caps}` : "—"],
    ["Gravity / Wrap", a.ok ? `${a.gravity} · ${a.wrap ? "wrap" : "walled"}` : "—"],
    ["Plays / Stars", `${d.plays} · ★${d.favourites}`],
    ["Votes / Size", `+${d.upvotes}/-${d.downvotes} · ${fmtSize(inspectRes.code_size || 0)}`],
  ];
  $("#modalstats").innerHTML = statCells.map(([l, v]) => `<div class="stat-cell"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span></div>`).join("");

  if (d.description) {
    $("#modaldesc").textContent = d.description;
    $("#modaldesc").hidden = false;
  } else {
    $("#modaldesc").hidden = true;
  }

  // Direct moderation actions
  const act = $("#modalactions");
  act.innerHTML = "";
  const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; act.appendChild(b); };
  if (d.status !== "approved") {
    mk("Approve", async () => {
      const r = await api("/admin/api/maps/" + d.id + "/approve", {});
      $("#modalmsg").textContent = r.ok ? "Approved." : "Failed (HTTP " + r.status + ").";
      refreshMaps(); refreshLibrary();
      if (r.ok) openMapInspector(d.id);
    }, "good");
  }
  if (d.status !== "rejected") {
    mk("Reject", async () => {
      const reason = rejectReason(d.name);
      if (!reason) return;
      const r = await api("/admin/api/maps/" + d.id + "/reject", { reason });
      $("#modalmsg").textContent = r.ok ? "Rejected." : "Failed (HTTP " + r.status + ").";
      refreshMaps(); refreshLibrary();
      if (r.ok) openMapInspector(d.id);
    }, "bad");
  }
  mk(d.pick ? "Unpick" : "Pick", async () => {
    const r = await api("/admin/api/maps/" + d.id + "/pick", { pick: !d.pick });
    $("#modalmsg").textContent = r.ok ? (!d.pick ? "Picked." : "Unpicked.") : "Failed (HTTP " + r.status + ").";
    refreshLibrary();
    if (r.ok) openMapInspector(d.id);
  });
  mk("Copy code", async () => {
    try {
      await navigator.clipboard.writeText(d.code);
      $("#modalmsg").textContent = "Copied map code to clipboard.";
    } catch (_) {
      $("#modalcode").value = d.code;
      $("#modalcode").hidden = false;
      $("#modalmsg").textContent = "Clipboard unavailable — copy the code below.";
    }
  });
  mk("Delete", async () => {
    if (!confirm("Delete \"" + d.name + "\" for good? Its owner loses it and players can no longer open it.")) return;
    const r = await api("/admin/api/maps/" + d.id + "/delete", {});
    if (r.ok) {
      previewCache.delete(d.id);
      mapModal.close();
      refreshMaps(); refreshLibrary();
    } else {
      $("#modalmsg").textContent = "Could not delete (HTTP " + r.status + ").";
    }
  }, "bad");

  // Paint canvas on next frame once modal layout is settled
  requestAnimationFrame(() => redrawModalCanvas());
}

// --- Map Approvals ---
async function refreshMaps() {
  try {
    const r = await api("/admin/api/maps/pending");
    if (r.ok) renderMaps(await r.json());
  } catch (_) {}
}
function renderMaps(maps) {
  const tb = $("#maps tbody");
  $("#nomaps").hidden = maps.length > 0;
  $("#maps-sub").textContent = maps.length
    ? `${maps.length} awaiting review — click preview or Inspect`
    : "Queue clear";
  syncRows(tb, maps.map((m) => ({
    key: "pending:" + m.id + ":" + m.size,
    cells: [
      c(`<canvas class="map-thumb" data-mapid="${m.id}" title="Click to inspect"></canvas>`),
      c(`<b>${esc(m.name)}</b>${m.description ? `<span class="desc">${esc(m.description)}</span>` : ""}`, "map-name-cell"),
      c(esc(m.author)),
      c(esc(fmtShortDate(m.created))),
      c(fmtSize(m.size), "num"),
    ],
    setup: (tr) => {
      const actions = document.createElement("td");
      tr.appendChild(actions);
      const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
      mk("Inspect", () => openMapInspector(m.id), "primary");
      mk("Approve", () => decideMap(m, "approve"), "good");
      mk("Reject", () => { const reason = rejectReason(m.name); if (reason) decideMap(m, "reject", { reason }); }, "bad");
      mk("Copy code", () => copyMapCode(m));
    },
    sync: (tr) => {
      const cv = tr.querySelector("canvas.map-thumb");
      if (cv) {
        cv.onclick = () => openMapInspector(m.id);
        paintThumb(cv, m.id);
      }
    },
  })));
}
async function decideMap(m, verb, body = {}) {
  const r = await api("/admin/api/maps/" + m.id + "/" + verb, body);
  $("#mapmsg").textContent = r.ok ? (verb === "approve" ? "Approved " : "Rejected ") + m.name + "." : "Could not change " + m.name + " (HTTP " + r.status + ").";
  refreshMaps();
  refreshLibrary();
}

function rejectReason(name) {
  const reason = prompt("Why is \"" + name + "\" removed? The author sees this reason in the library.");
  return reason && reason.trim() ? reason.trim() : null;
}
async function copyMapCode(m) {
  const r = await api("/admin/api/maps/" + m.id + "/code");
  if (!r.ok) { $("#mapmsg").textContent = "Could not load " + m.name + " (HTTP " + r.status + ")."; return; }
  const { code } = await r.json();
  $("#mapcode").hidden = true;
  try {
    await navigator.clipboard.writeText(code);
    $("#mapmsg").textContent = "Copied the code of " + m.name + ".";
  } catch (_) {
    $("#mapcode").value = code;
    $("#mapcode").hidden = false;
    $("#mapmsg").textContent = "Clipboard unavailable: copy the code below.";
  }
}

// --- Map Library ---
const LIB_PAGE = 25;
let libPage = 0;
async function refreshLibrary() {
  try {
    const r = await api("/admin/api/maps?q=" + encodeURIComponent($("#libq").value) + "&page=" + libPage);
    if (r.ok) renderLibrary(await r.json());
  } catch (_) {}
}
function renderLibrary({ total, maps }) {
  if (!maps.length && libPage > 0) { libPage--; refreshLibrary(); return; }
  syncRows($("#library tbody"), maps.map((m) => ({
    key: `lib:${m.id}:${m.status}:${m.visibility}:${m.pick}`,
    cells: [
      c(`<canvas class="map-thumb" data-mapid="${m.id}" title="Click to inspect"></canvas>`),
      c(`<b>${esc(m.name)}</b>${m.description ? `<span class="desc">${esc(m.description)}</span>` : ""}`, "map-name-cell"),
      c(esc(m.author)),
      c(`<span class="pill ${esc(m.status)}">${esc(m.status)}</span>`),
      c(esc(m.visibility)),
      c(m.pick ? `<span class="pill pick">pick</span>` : ""),
      c(esc(fmtShortDate(m.created))),
    ],
    setup: (tr) => {
      const actions = document.createElement("td");
      tr.appendChild(actions);
      const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
      mk("Inspect", () => openMapInspector(m.id), "primary");
      mk(m.pick ? "Unpick" : "Pick", () => pickMap(m, !m.pick));
      mk("Delete", () => { if (confirm("Delete \"" + m.name + "\" for good? Its owner loses it and players can no longer open it.")) deleteMap(m); }, "bad");
    },
    sync: (tr) => {
      const cv = tr.querySelector("canvas.map-thumb");
      if (cv) {
        cv.onclick = () => openMapInspector(m.id);
        paintThumb(cv, m.id);
      }
    },
  })));
  const pages = Math.max(1, Math.ceil(total / LIB_PAGE));
  $("#libinfo").textContent = total + " maps · page " + (libPage + 1) + " of " + pages;
  $("#libprev").disabled = libPage === 0;
  $("#libnext").disabled = libPage + 1 >= pages;
}
async function deleteMap(m) {
  const r = await api("/admin/api/maps/" + m.id + "/delete", {});
  $("#libmsg").textContent = r.ok ? "Deleted " + m.name + "." : "Could not delete " + m.name + " (HTTP " + r.status + ").";
  $("#libcode").hidden = true;
  previewCache.delete(m.id);
  refreshLibrary();
  refreshMaps();
}
async function pickMap(m, on) {
  const r = await api("/admin/api/maps/" + m.id + "/pick", { pick: on });
  $("#libmsg").textContent = r.ok ? (on ? "Picked " : "Unpicked ") + m.name + "." : "Could not change the pick of " + m.name + " (HTTP " + r.status + ").";
  refreshLibrary();
}
$("#libq").oninput = () => { libPage = 0; refreshLibrary(); };
$("#libprev").onclick = () => { libPage--; refreshLibrary(); };
$("#libnext").onclick = () => { libPage++; refreshLibrary(); };

// --- Clips ---
const CLIP_PAGE = 25;
let clipCursor = null;
async function loadClips(reset) {
  if (reset) { clipCursor = null; $("#clips tbody").innerHTML = ""; }
  try {
    const r = await api("/admin/api/clips" + (clipCursor === null ? "" : "?before=" + clipCursor));
    if (!r.ok) { $("#clipmsg").textContent = "Could not load clips (HTTP " + r.status + ")."; return; }
    const clips = await r.json();
    const tb = $("#clips tbody");
    for (const c of clips) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(c.recorder)}</td><td>${esc(c.map_name)}</td><td>${esc(fmtShortDate(c.created))}</td><td class="num">${fmtSize(c.size)}</td><td></td>`;
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "bad";
      del.onclick = () => { if (confirm("Delete this clip for good?")) deleteClip(c.id); };
      tr.lastChild.appendChild(del);
      tb.appendChild(tr);
      clipCursor = c.id;
    }
    $("#noclips").hidden = tb.children.length > 0;
    $("#clipmore").disabled = clips.length < CLIP_PAGE;
  } catch (_) {}
}
async function deleteClip(id) {
  const r = await api("/admin/api/clips/" + id + "/delete", {});
  $("#clipmsg").textContent = r.ok ? "Deleted clip " + id + "." : "Could not delete clip " + id + " (HTTP " + r.status + ").";
  loadClips(true);
}
$("#clipmore").onclick = () => loadClips(false);

// --- Bugs & Suggestions (Player Feedback) ---
const FB_PAGE = 25;
let fbCursor = null;
async function loadFeedback(reset) {
  if (reset) { fbCursor = null; $("#feedback tbody").innerHTML = ""; $("#fbdetail").hidden = true; $("#fbdetail").textContent = ""; }
  const q = new URLSearchParams();
  if ($("#fbkind").value) q.set("kind", $("#fbkind").value);
  if ($("#fbstatus").value) q.set("status", $("#fbstatus").value);
  if (fbCursor !== null) q.set("before", fbCursor);
  try {
    const r = await api("/admin/api/feedback?" + q);
    if (!r.ok) { $("#fbmsg").textContent = "Could not load feedback: " + (await errorText(r)) + "."; return; }
    const items = await r.json();
    const tb = $("#feedback tbody");
    for (const item of items) {
      const tr = document.createElement("tr");
      const kindPill = item.kind === "bug"
        ? `<span class="pill rejected">bug</span>`
        : `<span class="pill lobby">suggestion</span>`;
      const statusPill = `<span class="pill ${item.status === "open" ? "pending" : item.status === "resolved" ? "approved" : ""}">${esc(item.status)}</span>`;
      const preview = item.message.length > 90 ? item.message.slice(0, 90) + "…" : item.message;
      const authorTag = `${esc(item.author_name)}${item.author_account === null ? " <span class=muted>(guest)</span>" : ""}`;
      tr.innerHTML = `<td>${kindPill}</td><td class="map-name-cell">${esc(preview)}</td><td><span class="pill">${esc(item.screen || "-")}</span></td><td>${authorTag}</td><td>${esc(fmtShortDate(item.created))}</td><td>${statusPill}</td><td></td>`;
      const actions = tr.lastChild;
      const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
      mk("Details", () => showFeedback(item), "primary");
      if (item.status === "open") {
        mk("Resolve", () => setFeedbackStatus(item, "resolved"), "good");
        mk("Dismiss", () => setFeedbackStatus(item, "dismissed"));
      } else {
        mk("Reopen", () => setFeedbackStatus(item, "open"));
      }
      mk("Delete", () => { if (confirm("Delete feedback #" + item.id + " for good?")) deleteFeedback(item); }, "bad");
      tb.appendChild(tr);
      fbCursor = item.id;
    }
    $("#nofb").hidden = tb.children.length > 0;
    $("#fbmore").disabled = items.length < FB_PAGE;
  } catch (_) {}
}
function showFeedback(item) {
  const lines = [
    `#${item.id} [${item.kind.toUpperCase()}] (${item.status})`,
    `Author: ${item.author_name} (${item.author_account === null ? "guest" : "account " + item.author_account}, ${item.author_ip})`,
    `Screen: ${item.screen || "-"}`,
    `Context: ${item.context || "-"}`,
    `Created: ${fmtShortDate(item.created)}`,
    "",
    item.message,
  ];
  $("#fbdetail").textContent = lines.join("\n");
  $("#fbdetail").hidden = false;
}
async function setFeedbackStatus(item, status) {
  const r = await api("/admin/api/feedback/" + item.id + "/status", { status });
  $("#fbmsg").textContent = r.ok ? `Feedback #${item.id} marked ${status}.` : `Could not update #${item.id}: ${await errorText(r)}.`;
  loadFeedback(true);
}
async function deleteFeedback(item) {
  const r = await api("/admin/api/feedback/" + item.id + "/delete", {});
  $("#fbmsg").textContent = r.ok ? `Deleted feedback #${item.id}.` : `Could not delete #${item.id}: ${await errorText(r)}.`;
  loadFeedback(true);
}
$("#fbkind").onchange = () => loadFeedback(true);
$("#fbstatus").onchange = () => loadFeedback(true);
$("#fbrefresh").onclick = () => loadFeedback(true);
$("#fbmore").onclick = () => loadFeedback(false);

// --- Reports ---
const REPORT_PAGE = 25;
const REPORT_CATEGORY_LABELS = { illegal: "Illegal content", harassment: "Harassment or hate", cheating: "Cheating", spam: "Spam", inappropriate: "Inappropriate name or map", other: "Other" };
let repOffset = 0;
async function errorText(r) { return (await r.json().catch(() => ({}))).error || "HTTP " + r.status; }
async function loadReports(reset) {
  if (reset) { repOffset = 0; $("#reports tbody").innerHTML = ""; $("#repdetail").textContent = ""; }
  const q = new URLSearchParams();
  if ($("#repstatus").value) q.set("status", $("#repstatus").value);
  q.set("offset", repOffset);
  try {
    const r = await api("/admin/api/reports?" + q);
    if (!r.ok) { $("#repmsg").textContent = "Could not load reports: " + (await errorText(r)) + "."; return; }
    const reports = await r.json();
    repOffset += reports.length;
    const tb = $("#reports tbody");
    for (const rep of reports) {
      const tr = document.createElement("tr");
      const subject = rep.kind === "player" ? (rep.player ? rep.player.name : "(left the room)") : rep.map.name;
      tr.innerHTML = `<td>${esc(rep.kind)}</td><td>${esc(REPORT_CATEGORY_LABELS[rep.category] || rep.category)}</td><td>${esc(subject)}</td><td>${esc(rep.reason)}</td><td>${esc(rep.reporter.name)}</td><td>${esc(rep.room_code || "-")}</td><td>${esc(fmtShortDate(rep.created))}</td><td></td>`;
      const actions = tr.lastChild;
      const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
      mk("Evidence", () => showReport(rep));
      if (rep.map && rep.map.id !== null && rep.map.id !== undefined) {
        mk("Inspect map", () => openMapInspector(rep.map.id), "primary");
      }
      if (rep.status === "open") { mk("Resolve", () => setReportStatus(rep, "resolved"), "good"); mk("Dismiss", () => setReportStatus(rep, "dismissed")); }
      else mk("Reopen", () => setReportStatus(rep, "open"));
      mk("Delete", () => { if (confirm("Delete report " + rep.id + " for good?")) deleteReport(rep); }, "bad");
      tb.appendChild(tr);
    }
    $("#norep").hidden = tb.children.length > 0;
    $("#repmore").disabled = reports.length < REPORT_PAGE;
  } catch (_) {}
}
function showReport(rep) {
  const who = (p) => p.name + " (" + (p.account === null ? "guest" : "account " + p.account) + ", " + p.ip + ")";
  const lines = ["Reason: " + rep.reason, "Reporter: " + who(rep.reporter)];
  if (rep.player) lines.push("Player: " + who(rep.player));
  if (rep.map) lines.push("Map: " + rep.map.name + " by " + rep.map.author + (rep.map.id === null ? " (built in)" : " (library " + rep.map.id + ")"));
  lines.push("Room: " + rep.room_name + " (" + rep.room_code + ")", "Chat:");
  for (const ch of rep.chat) lines.push("  " + new Date(ch.at * 1000).toLocaleTimeString() + " " + ch.name + ": " + ch.text);
  $("#repdetail").textContent = lines.join("\n");
}
async function setReportStatus(rep, status) {
  const r = await api("/admin/api/reports/" + rep.id + "/status", { status });
  $("#repmsg").textContent = r.ok ? "Report " + rep.id + " is now " + status + "." : "Could not update report " + rep.id + ": " + (await errorText(r)) + ".";
  loadReports(true);
}
async function deleteReport(rep) {
  const r = await api("/admin/api/reports/" + rep.id + "/delete", {});
  $("#repmsg").textContent = r.ok ? "Deleted report " + rep.id + "." : "Could not delete report " + rep.id + ": " + (await errorText(r)) + ".";
  loadReports(true);
}
$("#repstatus").onchange = () => loadReports(true);
$("#repmore").onclick = () => loadReports(false);

// --- Accounts ---
async function loadAccounts() {
  loadSanctions();
  try {
    const r = await api("/admin/api/accounts?q=" + encodeURIComponent($("#accq").value));
    if (!r.ok) { $("#accmsg").textContent = "Could not search accounts: " + (await errorText(r)) + "."; return; }
    const accounts = await r.json();
    const tb = $("#accounts tbody");
    tb.innerHTML = "";
    for (const a of accounts) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><b>${esc(a.name)}</b></td><td class="num">${a.xp}</td><td>${esc(fmtShortDate(a.created))}</td><td></td>`;
      const actions = tr.lastChild;
      const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
      mk("Set password", () => setPassword(a));
      mk("Rename", () => renameAccount(a));
      mk("Suspend", () => suspendAccount(a), "bad");
      mk("Delete", () => deleteAccount(a), "bad");
      tb.appendChild(tr);
    }
    $("#noacc").hidden = accounts.length > 0;
  } catch (_) {}
}
async function setPassword(a) {
  const password = prompt("New password for " + a.name + ". Its sessions are signed out.");
  if (!password) return;
  const r = await api("/admin/api/accounts/" + a.id + "/password", { password });
  $("#accmsg").textContent = r.ok ? "Password of " + a.name + " set." : "Could not set the password of " + a.name + ": " + (await errorText(r)) + ".";
}
async function renameAccount(a) {
  const name = prompt("New name for " + a.name + ":");
  if (!name) return;
  const r = await api("/admin/api/accounts/" + a.id + "/rename", { name });
  $("#accmsg").textContent = r.ok ? a.name + " is now " + name + "." : "Could not rename " + a.name + ": " + (await errorText(r)) + ".";
  loadAccounts();
}
async function suspendAccount(a) {
  const days = prompt("Suspend " + a.name + " for how many days? Leave empty for good.");
  if (days === null) return;
  const reason = prompt("Reason, shown to the player and in the sanctions list:");
  if (!reason) return;
  const body = { reason };
  if (days.trim() !== "") {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) { $("#accmsg").textContent = "Days must be a whole number, 1 or more."; return; }
    body.days = n;
  }
  const r = await api("/admin/api/accounts/" + a.id + "/suspend", body);
  $("#accmsg").textContent = r.ok ? a.name + " is suspended." : "Could not suspend " + a.name + ": " + (await errorText(r)) + ".";
  loadSanctions();
}
async function deleteAccount(a) {
  if (!confirm("Delete account " + a.name + " and everything it owns? This cannot be undone.")) return;
  const r = await api("/admin/api/accounts/" + a.id + "/delete", {});
  $("#accmsg").textContent = r.ok ? "Deleted " + a.name + "." : "Could not delete " + a.name + ": " + (await errorText(r)) + ".";
  loadAccounts();
}

// --- Sanctions ---
function untilText(until) { return until === null || until === undefined ? "permanently" : fmtShortDate(until); }
async function loadSanctions() {
  try {
    const r = await api("/admin/api/sanctions");
    if (!r.ok) { $("#accmsg").textContent = "Could not load sanctions: " + (await errorText(r)) + "."; return; }
    const s = await r.json();
    const tb = $("#sanctions tbody");
    tb.innerHTML = "";
    const row = (kind, subject, x, lift) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${kind}</td><td>${esc(subject)}</td><td>${esc(x.reason)}</td><td>${esc(untilText(x.until))}</td><td></td>`;
      const b = document.createElement("button");
      b.textContent = "Lift";
      b.onclick = lift;
      tr.lastChild.appendChild(b);
      tb.appendChild(tr);
    };
    for (const x of s.suspensions) row("Suspended account", x.name, x, () => liftSuspension(x));
    for (const x of s.ip_bans) row("IP ban", x.ip, x, () => liftIpBan(x.ip));
    $("#nosanc").hidden = tb.children.length > 0;
  } catch (_) {}
}
async function liftSuspension(x) {
  const r = await api("/admin/api/accounts/" + x.account_id + "/unsuspend", {});
  $("#accmsg").textContent = r.ok ? "Lifted the suspension of " + x.name + "." : "Could not lift the suspension of " + x.name + ": " + (await errorText(r)) + ".";
  loadSanctions();
}
async function liftIpBan(ip) {
  const r = await api("/admin/api/ip-bans/lift", { ip });
  $("#accmsg").textContent = r.ok ? "Lifted the ban on " + ip + "." : "Could not lift the ban on " + ip + ": " + (await errorText(r)) + ".";
  loadSanctions();
}
$("#banbtn").onclick = async () => {
  const ip = $("#banip").value.trim();
  const reason = $("#banreason").value.trim();
  const days = $("#bandays").value.trim();
  if (!ip || !reason) { $("#accmsg").textContent = "An IP ban needs an address and a reason."; return; }
  const body = { ip, reason };
  if (days !== "") {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) { $("#accmsg").textContent = "Days must be a whole number, 1 or more."; return; }
    body.days = n;
  }
  const r = await api("/admin/api/ip-bans", body);
  $("#accmsg").textContent = r.ok ? "Banned " + ip + "." : "Could not ban " + ip + ": " + (await errorText(r)) + ".";
  if (r.ok) { $("#banip").value = ""; $("#banreason").value = ""; $("#bandays").value = ""; }
  loadSanctions();
};
$("#accq").oninput = () => loadAccounts();

// --- Polling & Logs ---
let tickCount = 0;
async function refresh() {
  if ($("#app").hidden) return;
  try {
    const r = await api("/admin/api/state");
    if (r.ok) {
      renderState(await r.json());
      if (tickCount % 3 === 0) {
        refreshMaps();
        refreshLibrary();
      }
      tickCount++;
    }
  } catch (_) {}
}

async function pollLogs() {
  if ($("#app").hidden) return;
  try {
    const r = await api("/admin/api/logs?since=" + logSeq);
    if (!r.ok) return;
    const lines = await r.json();
    for (const l of lines) { logSeq = Math.max(logSeq, l.seq); logLines.push(l); }
    while (logLines.length > 2000) logLines.shift();
    if (lines.length) drawLogs();
  } catch (_) {}
}
function drawLogs() {
  const f = $("#logfilter").value.toLowerCase();
  const minRank = Number($("#loglevel").value) || 0;
  const el = $("#logs");
  el.innerHTML = logLines
    .filter((l) => (levelRank[l.level] ?? 0) >= minRank && (!f || (l.text + " " + l.target + " " + l.level).toLowerCase().includes(f)))
    .slice(-500)
    .map((l) => `<div class="${l.level}">${new Date(l.time_ms).toLocaleTimeString()} ${l.level.padEnd(5)} ${esc(l.text)}</div>`)
    .join("");
  if ($("#logfollow").checked) el.scrollTop = el.scrollHeight;
}
$("#logfilter").oninput = drawLogs;
$("#loglevel").onchange = drawLogs;
$("#logclear").onclick = () => { logLines.length = 0; drawLogs(); };

// --- Live Room / Lobby Viewer ---
const viewCanvas = $("#view");
let viewBusy = false;
$("#viewpause").onclick = () => {
  viewPaused = !viewPaused;
  $("#viewpause").textContent = viewPaused ? "Resume" : "Pause";
};

function clearView(badge, msg) {
  const ctx = viewCanvas.getContext("2d");
  if (ctx) { ctx.fillStyle = "#0b0d12"; ctx.fillRect(0, 0, viewCanvas.width, viewCanvas.height); }
  const b = $("#viewbadge");
  b.className = "pill";
  b.textContent = badge;
  $("#viewinfo").textContent = msg;
}

async function pollView() {
  if (viewPaused || viewBusy || $("#app").hidden) return;
  if (!selected) { clearView("Idle", "Select a room to view its live match or lobby map."); return; }
  const room = lastState && lastState.rooms.find((x) => x.code === selected);
  if (lastState && !room) { clearView("Closed", "Selected room is no longer active."); return; }
  viewBusy = true;
  try {
    const r = await api("/admin/api/rooms/" + encodeURIComponent(selected) + "/view");
    if (r.status !== 200) {
      clearView("Unavailable", "Map preview unavailable for this room.");
      return;
    }
    const mode = r.headers.get("x-neobox-mode") || (room && room.in_match ? "match" : "lobby");
    const buf = await r.arrayBuffer();
    const names = {}, colors = {};
    if (room) {
      for (const p of room.players) { names[p.id] = p.name; colors[p.id] = p.color; }
    }
    const info = drawFrameBuffer(viewCanvas, buf, {
      names,
      colors,
      showNames: $("#viewnames").checked,
      fallbackW: 960,
      fallbackH: 600,
    });
    const b = $("#viewbadge");
    if (mode === "match") {
      b.className = "pill live";
      b.innerHTML = `<span class="dot"></span>Live match`;
      $("#viewinfo").textContent = info
        ? `room ${selected} · tick ${info.tick} · ${info.players} players · ${info.triangles} triangles`
        : `room ${selected}`;
    } else {
      b.className = "pill lobby";
      b.innerHTML = `<span class="dot"></span>Lobby preview`;
      const mapTitle = room ? room.map_name : "";
      $("#viewinfo").textContent = info
        ? `room ${selected} (lobby) · ${mapTitle} · ${room ? room.players.length : 0} players waiting · ${info.triangles} triangles`
        : `room ${selected} (lobby)`;
    }
  } catch (_) {
  } finally {
    viewBusy = false;
  }
}

setInterval(refresh, 1000);
setInterval(pollLogs, 1500);
setInterval(pollView, 120);

// Initial session check: only starts polling once authenticated.
fetch("/admin/api/session", { credentials: "same-origin" })
  .then((r) => r.json())
  .then((s) => { if (s.admin) { showApp(); refresh(); pollLogs(); } else showLogin(); })
  .catch(showLogin);
