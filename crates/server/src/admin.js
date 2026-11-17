"use strict";
const $ = (s) => document.querySelector(s);
let selected = null;
let lastState = null;
let logSeq = 0;
const logLines = [];
const teamName = ["spec", "ffa", "red", "blue"];
const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB/s" : n >= 1024 ? (n / 1024).toFixed(1) + " kB/s" : n + " B/s";
const fmtTime = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + "h " : "") + m + "m " + (s % 60) + "s"; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const maskText = (m) => ["←", "→", "↑", "↓", "X", "Z", "C", "V"].filter((_, i) => m & (1 << i)).join(" ") || "·";

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { credentials: "same-origin" } : {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return r;
}
function showLogin() { $("#app").hidden = true; $("#login").hidden = false; $("#pw").focus(); }
function showApp() { $("#login").hidden = true; $("#app").hidden = false; loadClips(true); loadReports(true); loadAccounts(); }

$("#loginform").onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch("/admin/api/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $("#pw").value }) });
  if (r.ok) { $("#pw").value = ""; $("#loginerr").textContent = ""; showApp(); refresh(); }
  else $("#loginerr").textContent = await r.text();
};
$("#logout").onclick = async () => { await fetch("/admin/api/logout", { method: "POST", credentials: "same-origin" }); showLogin(); };
$("#sayallbtn").onclick = async () => { const t = $("#sayall").value.trim(); if (t) { await api("/admin/api/broadcast", { text: t }); $("#sayall").value = ""; } };

function cmd(code, body) { return api("/admin/api/rooms/" + encodeURIComponent(code), body); }

// A table body follows its rows. A row is kept while its key is listed, its cells are rewritten only where their html
// changed, and `setup` runs once for a new row, so the controls in a row keep focus and an open select stays open
// across the one-second refresh. Rows are moved only when the order changed.
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

function renderState(st) {
  lastState = st;
  const s = st.server;
  $("#srv").innerHTML = `<span>up <b>${fmtTime(s.uptime_s)}</b></span><span>connections <b>${s.connections}</b></span><span>rooms <b>${s.rooms}</b>/${s.max_rooms}</span><span>players <b>${s.players}</b></span><span>in <b>${fmtBytes(s.bytes_in_per_s)}</b></span><span>out <b>${fmtBytes(s.bytes_out_per_s)}</b></span><span class="muted">v${esc(s.version)}</span>`;
  const tb = $("#rooms tbody");
  $("#norooms").hidden = st.rooms.length > 0;
  syncRows(tb, st.rooms.map((r) => ({
    key: r.code,
    cls: r.code === selected ? "sel" : "",
    cells: [
      c(`<b>${esc(r.code)}</b>`),
      c(esc(r.region || "")),
      c(`${esc(r.name)}${r.password ? " 🔒" : ""}${r.public ? "" : " <span class=muted>(private)</span>"}`),
      c(`${r.players.length}/${r.max_players}`, "num"),
      c(r.in_match ? "<span class=pill>match " + fmtTime(r.match_seconds) + "</span>" : "lobby"),
      c(r.tick, "num"),
      c(r.tick_hz, "num"),
      c(`${r.step_avg_us.toFixed(0)} / ${r.step_max_us.toFixed(0)}`, "num"),
      c(`${fmtBytes(r.bytes_in_per_s)} / ${fmtBytes(r.bytes_out_per_s)}`, "num"),
      c(esc(r.map_name)),
    ],
    setup: (tr) => { tr.onclick = () => { selected = r.code; renderState(lastState); }; },
  })));
  const room = st.rooms.find((r) => r.code === selected);
  renderRoom(room);
}

function renderRoom(r) {
  const ptb = $("#players tbody");
  if (!r) { $("#roomtitle").textContent = "Room"; $("#roomdetail").innerHTML = "<span class=muted>Select a room.</span>"; syncRows(ptb, []); return; }
  $("#roomtitle").textContent = "Room " + r.code;
  const round = r.round;
  const set = r.settings || {};
  let scores = "";
  if (round) {
    scores = `<div class="row muted">round ${round.round} · intro ${round.intro} · round over ${round.round_over} · game over ${round.game_over} · red ${round.red} · blue ${round.blue} · bodies ${round.bodies} · projectiles ${round.projectiles}</div>` +
      "<table><thead><tr><th>Player</th><th>Team</th><th>Kills</th><th>Wins</th><th>Lives</th><th>Alive</th></tr></thead><tbody>" +
      round.players.map((p) => `<tr><td>${esc((r.players.find((q) => q.id === p.id) || {}).name || "#" + p.id)}</td><td class="t${p.team}">${teamName[p.team] || p.team}</td><td>${p.kills}</td><td>${p.wins}</td><td>${p.lives}</td><td>${p.alive ? "yes" : "no"}</td></tr>`).join("") + "</tbody></table>";
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
      <div class="row"><input id="say" placeholder="Message to this room" style="flex:1"><button id="saybtn">Send</button></div>
      <div id="scores"></div>`;
    $("#endmatch").onclick = () => cmd(r.code, { action: "end_match" });
    $("#sethz").onclick = async () => { const res = await cmd(r.code, { action: "set_tick_rate", hz: Number($("#hz").value) }); if (!res.ok) alert(await res.text()); };
    $("#setmax").onclick = () => cmd(r.code, { action: "set_max_players", max: Number($("#maxp").value) });
    $("#close").onclick = () => { if (confirm("Close room " + r.code + "?")) cmd(r.code, { action: "close" }); };
    $("#saybtn").onclick = () => { const t = $("#say").value.trim(); if (t) { cmd(r.code, { action: "say", text: t }); $("#say").value = ""; } };
    $("#hz").value = r.tick_hz;
    $("#maxp").value = r.max_players;
  }
  $("#roominfo").innerHTML = `<div class="row muted">${esc(r.name)} · mode ${set.game_mode} · ${r.in_match ? "in match" : "lobby"} · ${r.players.length}/${r.max_players} players · map ${esc(r.map_name)}</div>`;
  $("#scores").innerHTML = scores;
  syncRows(ptb, r.players.map((p) => ({
    key: `${r.code}:${p.id}`,
    cells: [
      c(p.id, "num"),
      c(`${esc(p.name)}${p.host ? " <span class=pill>host</span>" : ""}`),
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

async function refreshMaps() {
  try {
    const r = await api("/admin/api/maps/pending");
    if (r.ok) renderMaps(await r.json());
  } catch (_) {}
}
function renderMaps(maps) {
  const tb = $("#maps tbody");
  $("#nomaps").hidden = maps.length > 0;
  syncRows(tb, maps.map((m) => ({
    key: JSON.stringify(m),
    cells: [c(`<b>${esc(m.name)}</b>`), c(esc(m.author)), c(esc(m.created)), c(`${m.size} B`, "num")],
    setup: (tr) => {
      const actions = document.createElement("td");
      tr.appendChild(actions);
      const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
      mk("Copy code", () => copyMapCode(m));
      mk("Approve", () => decideMap(m, "approve"));
      mk("Reject", () => { if (confirm("Reject \"" + m.name + "\"? It stays hidden from everyone but its owner.")) decideMap(m, "reject"); }, "bad");
    },
  })));
}
async function decideMap(m, verb) {
  const r = await api("/admin/api/maps/" + m.id + "/" + verb, {});
  $("#mapmsg").textContent = r.ok ? (verb === "approve" ? "Approved " : "Rejected ") + m.name + "." : "Could not change " + m.name + " (HTTP " + r.status + ").";
  refreshMaps();
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

// Map library: every map, any status, newest first. A page holds 25 maps (ADMIN_PAGE_SIZE on the server).
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
    key: JSON.stringify(m),
    cells: [c(`<b>${esc(m.name)}</b>`), c(esc(m.author)), c(esc(m.status)), c(esc(m.visibility)), c(m.pick ? "yes" : ""), c(esc(m.created))],
    setup: (tr) => {
      const actions = document.createElement("td");
      tr.appendChild(actions);
      const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
      mk("Show code", () => showMapCode(m));
      mk(m.pick ? "Unpick" : "Pick", () => pickMap(m, !m.pick));
      mk("Delete", () => { if (confirm("Delete \"" + m.name + "\" for good? Its owner loses it and players can no longer open it.")) deleteMap(m); }, "bad");
    },
  })));
  const pages = Math.max(1, Math.ceil(total / LIB_PAGE));
  $("#libinfo").textContent = total + " maps · page " + (libPage + 1) + " of " + pages;
  $("#libprev").disabled = libPage === 0;
  $("#libnext").disabled = libPage + 1 >= pages;
}
async function showMapCode(m) {
  const r = await api("/admin/api/maps/" + m.id + "/code");
  if (!r.ok) { $("#libmsg").textContent = "Could not load " + m.name + " (HTTP " + r.status + ")."; return; }
  const { code } = await r.json();
  $("#libcode").value = code;
  $("#libcode").hidden = false;
  $("#libmsg").textContent = "Code of " + m.name + " (" + m.visibility + ", " + m.status + ").";
}
async function deleteMap(m) {
  const r = await api("/admin/api/maps/" + m.id + "/delete", {});
  $("#libmsg").textContent = r.ok ? "Deleted " + m.name + "." : "Could not delete " + m.name + " (HTTP " + r.status + ").";
  $("#libcode").hidden = true;
  refreshLibrary();
}
async function pickMap(m, on) {
  const r = await api("/admin/api/maps/" + m.id + "/pick", { pick: on });
  $("#libmsg").textContent = r.ok ? (on ? "Picked " : "Unpicked ") + m.name + "." : "Could not change the pick of " + m.name + " (HTTP " + r.status + ").";
  refreshLibrary();
}

$("#libq").oninput = () => { libPage = 0; refreshLibrary(); };
$("#libprev").onclick = () => { libPage--; refreshLibrary(); };
$("#libnext").onclick = () => { libPage++; refreshLibrary(); };
// Clips recorded with /record, newest first; "More" pages on from the last id shown.
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
      tr.innerHTML = `<td>${esc(c.recorder)}</td><td>${esc(c.map_name)}</td><td>${esc(new Date(c.created * 1000).toISOString())}</td><td class="num">${c.size} B</td><td></td>`;
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

// Reports from players, newest first; "More" pages on from the last id shown.
const REPORT_PAGE = 25;
let repCursor = null;
async function errorText(r) { return (await r.json().catch(() => ({}))).error || "HTTP " + r.status; }
async function loadReports(reset) {
  if (reset) { repCursor = null; $("#reports tbody").innerHTML = ""; $("#repdetail").textContent = ""; }
  const q = new URLSearchParams();
  if ($("#repstatus").value) q.set("status", $("#repstatus").value);
  if (repCursor !== null) q.set("before", repCursor);
  try {
    const r = await api("/admin/api/reports?" + q);
    if (!r.ok) { $("#repmsg").textContent = "Could not load reports: " + (await errorText(r)) + "."; return; }
    const reports = await r.json();
    const tb = $("#reports tbody");
    for (const rep of reports) {
      const tr = document.createElement("tr");
      const subject = rep.kind === "player" ? (rep.player ? rep.player.name : "(left the room)") : rep.map.name;
      tr.innerHTML = `<td>${esc(rep.kind)}</td><td>${esc(subject)}</td><td>${esc(rep.reason)}</td><td>${esc(rep.reporter.name)}</td><td>${esc(rep.room_code || "-")}</td><td>${esc(new Date(rep.created * 1000).toISOString())}</td><td></td>`;
      const actions = tr.lastChild;
      const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
      mk("Evidence", () => showReport(rep));
      if (rep.status === "open") { mk("Resolve", () => setReportStatus(rep, "resolved")); mk("Dismiss", () => setReportStatus(rep, "dismissed")); }
      else mk("Reopen", () => setReportStatus(rep, "open"));
      mk("Delete", () => { if (confirm("Delete report " + rep.id + " for good?")) deleteReport(rep); }, "bad");
      tb.appendChild(tr);
      repCursor = rep.id;
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
  for (const c of rep.chat) lines.push("  " + new Date(c.at * 1000).toISOString() + " " + c.name + ": " + c.text);
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

// Accounts: search by name, newest first; set a new password for a locked-out player.
async function loadAccounts() {
  try {
    const r = await api("/admin/api/accounts?q=" + encodeURIComponent($("#accq").value));
    if (!r.ok) { $("#accmsg").textContent = "Could not search accounts: " + (await errorText(r)) + "."; return; }
    const accounts = await r.json();
    const tb = $("#accounts tbody");
    tb.innerHTML = "";
    for (const a of accounts) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><b>${esc(a.name)}</b></td><td class="num">${a.xp}</td><td>${esc(new Date(a.created * 1000).toISOString())}</td><td></td>`;
      const set = document.createElement("button");
      set.textContent = "Set password";
      set.onclick = () => setPassword(a);
      tr.lastChild.appendChild(set);
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
$("#accq").oninput = () => loadAccounts();

async function refresh() {
  if ($("#app").hidden) return;
  try {
    const r = await api("/admin/api/state");
    if (r.ok) { renderState(await r.json()); refreshMaps(); refreshLibrary(); }
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
  const el = $("#logs");
  el.innerHTML = logLines.filter((l) => !f || (l.text + l.target + l.level).toLowerCase().includes(f)).slice(-500)
    .map((l) => `<div class="${l.level}">${new Date(l.time_ms).toLocaleTimeString()} ${l.level.padEnd(5)} ${esc(l.text)}</div>`).join("");
  if ($("#logfollow").checked) el.scrollTop = el.scrollHeight;
}
$("#logfilter").oninput = drawLogs;

// Live view: draws the server's authoritative state (frame buffer layout of docs/CLIENT-API.md).
const canvas = $("#view");
const ctx = canvas.getContext("2d");
async function pollView() {
  if (!selected || $("#app").hidden) return;
  let r;
  try { r = await api("/admin/api/rooms/" + encodeURIComponent(selected) + "/view"); } catch (_) { return; }
  if (r.status !== 200) { ctx.fillStyle = "#05070a"; ctx.fillRect(0, 0, canvas.width, canvas.height); $("#viewinfo").textContent = "No match running."; return; }
  const buf = await r.arrayBuffer();
  const u = new Uint32Array(buf), f = new Float32Array(buf);
  const aw = f[10] || 35, ah = f[11] || 22;
  const W = canvas.clientWidth * devicePixelRatio, H = canvas.clientHeight * devicePixelRatio;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const scale = Math.min(W / (aw + 2), H / (ah + 2));
  const ox = (W - aw * scale) / 2, oy = (H - ah * scale) / 2;
  const top = u[12], bot = u[13];
  const g = ctx.createLinearGradient(0, oy, 0, oy + ah * scale);
  const hex = (c) => "#" + c.toString(16).padStart(6, "0");
  g.addColorStop(0, hex(top)); g.addColorStop(1, hex(bot));
  ctx.fillStyle = "#05070a"; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.25; ctx.fillStyle = g; ctx.fillRect(ox, oy, aw * scale, ah * scale); ctx.globalAlpha = 1;
  const n = u[1], off = u[2];
  for (let i = 0; i < n; i += 3) {
    const a = off + i * 3;
    const c = u[a + 2];
    ctx.fillStyle = `rgba(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255},${((c >>> 24) & 255) / 255})`;
    ctx.beginPath();
    ctx.moveTo(ox + f[a] * scale, oy + f[a + 1] * scale);
    ctx.lineTo(ox + f[a + 3] * scale, oy + f[a + 4] * scale);
    ctx.lineTo(ox + f[a + 6] * scale, oy + f[a + 7] * scale);
    ctx.fill();
  }
  const pc = u[3], po = u[4];
  const names = {};
  const room = lastState && lastState.rooms.find((x) => x.code === selected);
  if (room) for (const p of room.players) names[p.id] = p.name;
  for (let i = 0; i < pc; i++) {
    const a = po + i * 12;
    const id = u[a], x = f[a + 1], y = f[a + 2], ang = f[a + 3], team = u[a + 4], size = f[a + 8];
    ctx.save();
    ctx.translate(ox + x * scale, oy + y * scale); ctx.rotate(ang);
    ctx.fillStyle = team === 2 ? "#d44234" : team === 3 ? "#347bd4" : "#2f9bff";
    const s = size * scale;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();
    ctx.fillStyle = "#fff"; ctx.font = `${Math.max(10, scale * 0.45)}px system-ui`; ctx.textAlign = "center";
    ctx.fillText(names[id] || "#" + id, ox + x * scale, oy + (y - size) * scale);
  }
  $("#viewinfo").textContent = `tick ${u[14]} · ${n / 3} triangles · ${pc} players`;
}

setInterval(refresh, 1000);
setInterval(pollLogs, 1500);
setInterval(pollView, 100);
// a logged-out page asks once and shows the login form; it never polls without a session
fetch("/admin/api/session", { credentials: "same-origin" })
  .then((r) => r.json())
  .then((s) => { if (s.admin) { showApp(); refresh(); pollLogs(); } else showLogin(); })
  .catch(showLogin);
