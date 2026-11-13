// Generates the reference-trajectory scenarios in tests/scenarios/.
// Hand-written scenarios live next to the generated ones; this script only
// (re)writes the files whose names start with "gen-".
//
//   node tools/oracle/gen-scenarios.cjs
const fs = require("fs");
const path = require("path");

const DIR = path.resolve(__dirname, "..", "..", "tests", "scenarios");

function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

// Random input timeline: movement-heavy with bursts of abilities.
function timeline(r, from, to, opts = {}) {
	const out = [];
	let t = from;
	const abilities = opts.abilities ?? [16, 32, 64, 128];
	while (t < to) {
		let m = 0;
		const move = r();
		if (move < 0.35) m |= 2;
		else if (move < 0.7) m |= 1;
		else if (move < 0.75) m |= 3; // both: exercises the original's left priority
		if (r() < 0.3) m |= 4;
		if (r() < 0.12) m |= 8;
		if (r() < (opts.abilityRate ?? 0.35)) m |= abilities[Math.floor(r() * abilities.length)];
		out.push([t, m]);
		t += 2 + Math.floor(r() * (opts.maxHold ?? 24));
	}
	out.push([to, 0]);
	return out;
}

function scenario(name, desc, map, players, ticks, seed, extra = {}) {
	const r = rng(seed);
	const inputs = {};
	for (const [id] of extra.inputPlayers || players) inputs[id] = timeline(r, 90 + Math.floor(r() * 10), ticks - 5, extra.timeline);
	const sc = { name, description: desc, map, settings: extra.settings || {}, players, seed: extra.matchSeed ?? seed, ticks, inputs };
	if (extra.events) sc.events = extra.events;
	if (extra.iP) sc.iP = true;
	fs.writeFileSync(path.join(DIR, name + ".json"), JSON.stringify(sc, null, 1) + "\n");
	return name;
}

const ffa4 = [[0, 1], [1, 1], [2, 1], [3, 1]];
const teams4 = [[0, 2], [1, 3], [2, 2], [3, 3]];
const made = [
	scenario("gen-arena-fuzz", "4 players, random inputs, default settings (lives mode)", "../maps/arena.json", ffa4, 1500, 11),
	scenario("gen-objects-fuzz", "4 players on the object map: dynamic bodies, joints, force zone, no-jump, freeze, kill, pass-through, turret, cap point", "../maps/objects.json", ffa4, 1800, 23),
	scenario("gen-objects-kills", "kills-to-win mode on the object map", "../maps/objects.json", ffa4, 1500, 37, { settings: { gameMode: 0, objectiveLimit: 3 } }),
	scenario("gen-teams-rounds", "team rounds (mode 3) with team pass-through walls and objectives", "../maps/teams.json", teams4, 2400, 41, { settings: { gameMode: 3, objectiveLimit: 2 } }),
	scenario("gen-teams-endless", "endless teams (mode 4): objective bodies and cap points", "../maps/teams.json", teams4, 1800, 43, { settings: { gameMode: 4 } }),
	scenario("gen-teams-lives", "lives teams (mode 5)", "../maps/teams.json", teams4, 1800, 47, { settings: { gameMode: 5, objectiveLimit: 3 } }),
	scenario("gen-rounds", "rounds (mode 2) with round transitions", "../maps/arena.json", ffa4, 2400, 53, { settings: { gameMode: 2, objectiveLimit: 2 } }),
	scenario("gen-endless", "endless FFA (mode 6)", "../maps/objects.json", ffa4, 1200, 59, { settings: { gameMode: 6 } }),
	scenario("gen-wrap", "player and body edge wrapping, kinematic wrap body", "../maps/wrap.json", ffa4, 1500, 61),
	scenario("gen-dash-egg", "dash and egg abilities enabled, bigger players", "../maps/arena.json", ffa4, 1500, 67, { settings: { dashEnabled: true, egEnabled: true, playerSize: 1.1 } }),
	scenario("gen-parachute", "parachute enabled, low gravity offset", "../maps/objects.json", ffa4, 1500, 71, { settings: { parachuteEnabled: true, gravityOffset: -5 } }),
	scenario("gen-tuned", "tuned settings: timeScale 35, push range 12, rocket bounces and homing, players collide", "../maps/arena.json", ffa4, 1500, 73, {
		settings: { timeScale: 35, pushRange: 12, rkBulletBounces: true, rkBulletTurnRate: 0.08, rkExplodeRadius: 2.5, pushPlayers: false },
	}),
	scenario("gen-joinleave", "late joins and leaves during the match", "../maps/arena.json", [[0, 1], [1, 1]], 1500, 79, {
		events: [[300, { join: [[2, 1]] }], [500, { join: [[3, 1]] }], [800, { remove: [1] }], [1000, { join: [[5, 1]] }]],
		inputPlayers: [[0, 1], [1, 1], [2, 1], [3, 1], [5, 1]],
	}),
];
console.log(made.join("\n"));
