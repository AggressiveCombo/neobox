// cvd.minDeltaE (RUBRIC D06): the smallest CIEDE2000 difference between two active slots of each colour-blind
// palette, after simulating the matching deficiency (Machado et al. 2009, severity 1.0, on linear RGB).
// Colours are imported from src/render/geometry.ts (PALETTES), so the check tracks the shipped table.
// Team set = red and blue; FFA set = the unique FFA slots. Pass: every palette x its own deficiency >= THRESHOLD.
// Other deficiency rows are informational. No browser. Writes <QA_OUT>/cvd.json.
// Usage: bun qa/cvd.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PALETTES } from "../src/render/geometry.ts";
import { outDir } from "./lib-qa.mjs";

const THRESHOLD = 15;

// Machado 2009 severity-1.0 matrices on linear RGB.
const MATRIX = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
// Each palette is checked against the deficiency it is designed for; the others are reported for information.
const OWN = { deuteranopia: "deuteranopia", protanopia: "protanopia", tritanopia: "tritanopia" };

const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const enc = (c) => {
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(s * 255)));
};
function simulate(rgb, mat) {
  const l = [lin((rgb >> 16) & 255), lin((rgb >> 8) & 255), lin(rgb & 255)];
  const o = mat.map((r) => r[0] * l[0] + r[1] * l[1] + r[2] * l[2]);
  return [enc(o[0]), enc(o[1]), enc(o[2])];
}
function toLab([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function de2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (a, b) => (a === 0 && b === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1 = h(a1p, b1), h2 = h(a2p, b2);
  const dL = L2 - L1, dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh) / 2);
  const Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hb = h1 + h2;
  if (C1p * C2p !== 0) { if (Math.abs(h1 - h2) > 180) hb = h1 + h2 + (h1 + h2 < 360 ? 360 : -360); hb /= 2; }
  const T = 1 - 0.17 * Math.cos(rad(hb - 30)) + 0.24 * Math.cos(rad(2 * hb)) + 0.32 * Math.cos(rad(3 * hb + 6)) - 0.2 * Math.cos(rad(4 * hb - 63));
  const dTh = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(rad(2 * dTh)) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
const hex = (c) => "#" + c.toString(16).padStart(6, "0");

/** Smallest pairwise CIEDE2000 among the colours after the deficiency simulation. */
function minDeltaE(cols, mat) {
  const labs = cols.map((c) => toLab(simulate(c, mat)));
  let min = Infinity, pair = null;
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) {
      const d = de2000(labs[i], labs[j]);
      if (d < min) { min = d; pair = [hex(cols[i]), hex(cols[j])]; }
    }
  }
  return { minDeltaE: +min.toFixed(2), pair: pair ?? [] };
}

const deficiencies = Object.keys(MATRIX);
const cases = [];
const out = { method: "Machado 2009 severity 1.0 on linear RGB; CIEDE2000 min over pairs of active slots", threshold: THRESHOLD, palettes: {} };
for (const [name, p] of Object.entries(PALETTES)) {
  const sets = { team: [p.red, p.blue], ffa: [...new Set(p.ffa)] };
  const row = {};
  for (const def of deficiencies) {
    for (const [set, cols] of Object.entries(sets)) {
      row[`${def}.${set}`] = minDeltaE(cols, MATRIX[def]);
    }
  }
  out.palettes[name] = row;
  for (const set of Object.keys(sets)) {
    const own = OWN[name];
    if (!own) continue; // default palette: informational only
    const v = row[`${own}.${set}`];
    cases.push({ id: `cvd.minDeltaE.${name}.${set}`, verdict: v.minDeltaE >= THRESHOLD ? "pass" : "fail", metrics: v });
  }
}

const dir = outDir();
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "cvd.json");
writeFileSync(file, `${JSON.stringify({ instrument: "cvd", ...out, cases }, null, 2)}\n`);
for (const c of cases) console.log(`${c.verdict.toUpperCase()} ${c.id} ${c.metrics.minDeltaE} ${c.metrics.pair.join(" vs ")}`);
console.log(file);
