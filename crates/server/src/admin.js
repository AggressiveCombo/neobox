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
function showApp() { $("#login").hidden = true; $("#app").hidden = false; loadClips(true); }

$("#loginform").onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch("/admin/api/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $("#pw").value }) });
  if (r.ok) { $("#pw").value = ""; $("#loginerr").textContent = ""; showApp(); refresh(); }
  else $("#loginerr").textContent = await r.text();
};
$("#logout").onclick = async () => { await fetch("/admin/api/logout", { method: "POST", credentials: "same-origin" }); showLogin(); };
$("#sayallbtn").onclick = async () => { const t = $("#sayall").value.trim(); if (t) { await api("/admin/api/broadcast", { text: t }); $("#sayall").value = ""; } };

function cmd(code, body) { return api("/admin/api/rooms/" + encodeURIComponent(code), body); }

function renderState(st) {
  lastState = st;
  const s = st.server;
  $("#srv").innerHTML = `<span>up <b>${fmtTime(s.uptime_s)}</b></span><span>connections <b>${s.connections}</b></span><span>rooms <b>${s.rooms}</b>/${s.max_rooms}</span><span>players <b>${s.players}</b></span><span>in <b>${fmtBytes(s.bytes_in_per_s)}</b></span><span>out <b>${fmtBytes(s.bytes_out_per_s)}</b></span><span class="muted">v${esc(s.version)}</span>`;
  const tb = $("#rooms tbody");
  tb.innerHTML = "";
  $("#norooms").hidden = st.rooms.length > 0;
  for (const r of st.rooms) {
    const tr = document.createElement("tr");
    if (r.code === selected) tr.className = "sel";
    tr.innerHTML = `<td><b>${esc(r.code)}</b></td><td>${esc(r.name)}${r.password ? " 🔒" : ""}${r.public ? "" : " <span class=muted>(private)</span>"}</td><td>${r.players.length}/${r.max_players}</td><td>${r.in_match ? "<span class=pill>match " + fmtTime(r.match_seconds) + "</span>" : "lobby"}</td><td>${r.tick}</td><td>${r.tick_hz}</td><td>${r.step_avg_us.toFixed(0)} / ${r.step_max_us.toFixed(0)}</td><td>${fmtBytes(r.bytes_in_per_s)} / ${fmtBytes(r.bytes_out_per_s)}</td><td>${esc(r.map_name)}</td>`;
    tr.onclick = () => { selected = r.code; renderState(lastState); };
    tb.appendChild(tr);
  }
  const room = st.rooms.find((r) => r.code === selected);
  renderRoom(room);
}

function renderRoom(r) {
  const ptb = $("#players tbody");
  if (!r) { $("#roomtitle").textContent = "Room"; $("#roomdetail").innerHTML = "<span class=muted>Select a room.</span>"; ptb.innerHTML = ""; return; }
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
    $("#sethz").onclick = () => cmd(r.code, { action: "set_tick_rate", hz: Number($("#hz").value) });
    $("#setmax").onclick = () => cmd(r.code, { action: "set_max_players", max: Number($("#maxp").value) });
    $("#close").onclick = () => { if (confirm("Close room " + r.code + "?")) cmd(r.code, { action: "close" }); };
    $("#saybtn").onclick = () => { const t = $("#say").value.trim(); if (t) { cmd(r.code, { action: "say", text: t }); $("#say").value = ""; } };
    $("#hz").value = r.tick_hz;
    $("#maxp").value = r.max_players;
  }
  $("#roominfo").innerHTML = `<div class="row muted">${esc(r.name)} · mode ${set.game_mode} · ${r.in_match ? "in match" : "lobby"} · ${r.players.length}/${r.max_players} players · map ${esc(r.map_name)}</div>`;
  $("#scores").innerHTML = scores;
  ptb.innerHTML = "";
  for (const p of r.players) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.id}</td><td>${esc(p.name)}${p.host ? " <span class=pill>host</span>" : ""}</td><td class="t${p.team}">${teamName[p.team] || p.team}</td><td>${p.ping_ms} ms <span class=muted>${esc(p.transport)}</span></td><td>${p.margin_ticks.toFixed(2)}</td><td>${fmtBytes(p.bytes_in_per_s)} / ${fmtBytes(p.bytes_out_per_s)}</td><td>${maskText(p.input_mask)}</td><td>${fmtTime(p.connected_s)}</td><td class="muted">${esc(p.ip)}</td><td></td>`;
    const actions = tr.lastChild;
    const mk = (label, body, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = () => cmd(r.code, body); actions.appendChild(b); };
    mk("Host", { action: "set_host", player: p.id });
    const sel = document.createElement("select");
    sel.innerHTML = teamName.map((t, i) => `<option value="${i}" ${i === p.team ? "selected" : ""}>${t}</option>`).join("");
    sel.onchange = () => cmd(r.code, { action: "set_team", player: p.id, team: Number(sel.value) });
    actions.appendChild(sel);
    mk("Kick", { action: "kick", player: p.id, ban: false }, "bad");
    mk("Ban", { action: "kick", player: p.id, ban: true }, "bad");
    ptb.appendChild(tr);
  }
}

async function refreshMaps() {
  try {
    const r = await api("/admin/api/maps/pending");
    if (r.ok) renderMaps(await r.json());
  } catch (_) {}
}
function renderMaps(maps) {
  const tb = $("#maps tbody");
  tb.innerHTML = "";
  $("#nomaps").hidden = maps.length > 0;
  for (const m of maps) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><b>${esc(m.name)}</b></td><td>${esc(m.author)}</td><td>${esc(m.created)}</td><td>${m.size} B</td><td></td>`;
    const actions = tr.lastChild;
    const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
    mk("Copy code", () => copyMapCode(m));
    mk("Approve", () => decideMap(m, "approve"));
    mk("Reject", () => { if (confirm("Reject \"" + m.name + "\"? It stays hidden from everyone but its owner.")) decideMap(m, "reject"); }, "bad");
    tb.appendChild(tr);
  }
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
  const tb = $("#library tbody");
  tb.innerHTML = "";
  for (const m of maps) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><b>${esc(m.name)}</b></td><td>${esc(m.author)}</td><td>${esc(m.status)}</td><td>${esc(m.visibility)}</td><td>${m.pick ? "yes" : ""}</td><td>${esc(m.created)}</td><td></td>`;
    const actions = tr.lastChild;
    const mk = (label, fn, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; actions.appendChild(b); };
    mk("Show code", () => showMapCode(m));
    mk(m.pick ? "Unpick" : "Pick", () => pickMap(m, !m.pick));
    mk("Delete", () => { if (confirm("Delete \"" + m.name + "\" for good? Its owner loses it and players can no longer open it.")) deleteMap(m); }, "bad");
    tb.appendChild(tr);
  }
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
      tr.innerHTML = `<td>${esc(c.recorder)}</td><td>${esc(c.map_name)}</td><td>${esc(new Date(c.created * 1000).toISOString())}</td><td>${c.size} B</td><td></td>`;
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
