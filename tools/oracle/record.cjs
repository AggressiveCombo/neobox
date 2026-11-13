// Records reference trajectories from the ORIGINAL Hitbox.io simulation.
//
// Requires a running oracle host (tools/oracle/oracle-host.cjs) whose page is
// the original client in a started match. The recorder builds a fresh match
// state from a scenario's map and players with the original's own match-start
// routine, then calls the original's pure step function tick by tick with the
// scenario's inputs, and stores every tick's full serialized state.
//
//   node tools/oracle/record.cjs tests/scenarios/*.json
//   ORACLE=http://localhost:9333 node tools/oracle/record.cjs <files...>
//
// Output: tests/reference/<name>.json.gz (or $ORACLE_OUT/<name>.json.gz)
//   { scenario, states: [ <state arrays after tick 0>, <after tick 1>, ... ] }
// where each state is the original's full array serialization (14 buckets).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ORACLE = process.env.ORACLE || "http://localhost:9333";
const ROOT = path.resolve(__dirname, "..", "..");
const OUT = process.env.ORACLE_OUT || path.join(ROOT, "tests", "reference");

function encodeMap(map) {
	const json = JSON.stringify(map);
	return encodeURIComponent(zlib.deflateSync(Buffer.from(json, "latin1")).toString("base64"));
}

function loadMapCode(sc, dir) {
	if (sc.mapCode) return sc.mapCode;
	const file = path.resolve(dir, sc.map);
	const text = fs.readFileSync(file, "utf8").trim();
	if (file.endsWith(".txt")) return text;
	return encodeMap(JSON.parse(text));
}

// The snippet runs inside the original client page.
function snippet(sc, mapCode) {
	return `
const kr = window.multiplayerSession.KR;
const S = kr.uL.constructor;
const lobby = new S(); lobby.ac(${JSON.stringify(mapCode)});
const T9 = kr.hg.AD().constructor;
const Jo = new kr.Jo.constructor();
const set = ${JSON.stringify(sc.settings || {})};
for (const k of Object.keys(set)) { const r = Jo.wi(k, String(set[k])); if (r.startsWith("Couldn't")) throw new Error(r); }
let s = kr.zI.Q_({ tP: [{ state: lobby }], seed: ${sc.seed | 0}, iP: ${!!sc.iP}, sP: ${sc.skipIntro ? 1 : 0}, eP: ${JSON.stringify(sc.players)}, x_: Jo });
const masks = {};
const changes = ${JSON.stringify(sc.inputs || {})};
const events = ${JSON.stringify(sc.events || [])};
const states = [];
const init = s.F({ Ta: true });
for (let t = 0; t < ${sc.ticks | 0}; t++) {
  for (const id of Object.keys(changes)) for (const [tick, mask] of changes[id]) if (tick === t) masks[id] = mask;
  const inp = [];
  for (const id of Object.keys(masks)) {
    const m = masks[id], i = new T9();
    i.left = !!(m & 1); i.right = !!(m & 2); i.Di = !!(m & 4); i.Li = !!(m & 8);
    i.En = !!(m & 16); i.Bn = !!(m & 32); i.In = !!(m & 64); i.Fn = !!(m & 128);
    inp[id] = i;
  }
  let ev = null;
  for (const [tick, e] of events) if (tick === t) ev = { Vo: e.remove || [], Xo: (e.join || []).map(([id, N]) => ({ id, N })) };
  s = kr.zI.step(s, inp, ev, Jo);
  // the original game loop's round transitions (GL): next round when the
  // round-over countdown ends; next map in rotation after a game over
  {
    const ir = s.ir[0];
    const rot = !!ir.Lo;
    const roundDone = 0 == ir._o;
    const gameDone = rot && 0 == ir.xo;
    if (roundDone || gameDone) {
      const list = [{ state: lobby }];
      let idx = 0;
      if (gameDone) idx = ++ir.Io % list.length;
      else if (roundDone && rot) idx = ir.Io % list.length;
      s = kr.zI.nP(list[idx], s, Jo);
      if (gameDone) s.ir[0].Pi.forEach((r) => { r.Fi = 0; });
    }
  }
  states.push(s.F({ Ta: true }));
}
return { init, states };
`;
}

async function record(file) {
	const sc = JSON.parse(fs.readFileSync(file, "utf8"));
	const mapCode = loadMapCode(sc, path.dirname(file));
	const res = await fetch(ORACLE + "/eval", { method: "POST", body: snippet(sc, mapCode) });
	const text = await res.text();
	if (!res.ok) throw new Error(`${sc.name}: oracle error ${res.status}: ${text.slice(0, 500)}`);
	const { init, states } = JSON.parse(text);
	fs.mkdirSync(OUT, { recursive: true });
	const out = path.join(OUT, sc.name + ".json.gz");
	fs.writeFileSync(out, zlib.gzipSync(JSON.stringify({ scenario: sc, mapCode, init, states }), { level: 9 }));
	console.log(`${sc.name}: ${states.length} ticks -> ${path.relative(ROOT, out)}`);
}

(async () => {
	const files = process.argv.slice(2);
	if (!files.length) {
		console.error("usage: node tools/oracle/record.cjs <scenario.json...>");
		process.exit(2);
	}
	for (const f of files) await record(f);
})().catch((e) => {
	console.error(e.message || e);
	process.exit(1);
});
