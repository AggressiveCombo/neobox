// Reads every capture record under outRoot (<engine>/<theme>/<W>x<H>/<state>.json), validates it
// against thresholds.json, and writes outRoot/summary.md: failures by metric, then by engine, theme,
// size and state, with example screenshot paths. Imports nothing from the browser stack.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateRecord } from "./thresholds.mjs";

const MAX_EXAMPLES = 3;
const TOP = 8;

/** Every capture record (JSON with a `state` and `metrics`) below root. */
function* records(root) {
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      yield* records(full);
    } else if (entry.endsWith(".json") && entry !== "summary.json") {
      const record = JSON.parse(readFileSync(full, "utf8"));
      if (record.state && record.metrics) yield { record, file: full };
    }
  }
}

/** Metric key a failure string names, e.g. "overflow.docX=736 (max 0)" -> "overflow.docX". */
const keyOf = (failure) => (failure.startsWith("error:") ? "error" : failure.split("=")[0]);
const valueOf = (failure) => {
  const m = /=(-?[\d.]+)/.exec(failure);
  return m ? Number(m[1]) : null;
};

function tally(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
  return map;
}

const sortedTop = (map, n = TOP) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

/** Writes summary.md and returns its text. */
export function writeSummary(outRoot, label = path.basename(outRoot), note = "") {
  const all = [];
  for (const { record, file } of records(outRoot)) {
    const png = file.replace(/\.json$/, ".png");
    all.push({ record, png: existsSync(png) ? png : null, failures: validateRecord(record) });
  }

  const failing = all.filter((c) => c.failures.length > 0);
  const errors = all.filter((c) => c.record.error);
  const byMetric = new Map();
  for (const capture of failing) {
    for (const failure of capture.failures) {
      const key = keyOf(failure);
      if (!byMetric.has(key)) byMetric.set(key, { captures: [], values: [] });
      const entry = byMetric.get(key);
      entry.captures.push(capture);
      const v = valueOf(failure);
      if (v !== null) entry.values.push(v);
    }
  }

  const lines = [];
  lines.push(`# ${label}`, "");
  lines.push(`Captures: ${all.length}. Passing: ${all.length - failing.length}. Failing: ${failing.length}. Capture errors: ${errors.length}.`, "");
  if (note) lines.push(note, "");
  lines.push("## Failing metrics", "");
  lines.push("| metric | captures failing | worst value | example |", "| --- | ---: | ---: | --- |");
  const ranked = [...byMetric.entries()].sort((a, b) => b[1].captures.length - a[1].captures.length);
  for (const [key, { captures, values }] of ranked) {
    const worst = values.length ? Math.max(...values) : "-";
    lines.push(`| ${key} | ${captures.length} | ${worst} | ${captures.find((c) => c.png)?.png ?? "no png"} |`);
  }
  lines.push("");

  for (const [key, { captures }] of ranked) {
    lines.push(`## ${key}`, "");
    const dims = {
      engine: (c) => c.record.engine,
      theme: (c) => c.record.theme,
      size: (c) => `${c.record.viewport.W}x${c.record.viewport.H}`,
      state: (c) => c.record.state,
    };
    for (const [dim, pick] of Object.entries(dims)) {
      const counts = new Map();
      for (const c of captures) tally(counts, pick(c));
      lines.push(`- by ${dim}: ${sortedTop(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
    lines.push("- examples:");
    for (const c of captures.slice(0, MAX_EXAMPLES)) {
      const detail = c.failures.find((f) => keyOf(f) === key);
      lines.push(`  - ${c.record.engine} ${c.record.theme} ${c.record.viewport.W}x${c.record.viewport.H} ${c.record.state}: ${detail} -> ${c.png ?? "no png"}`);
    }
    lines.push("");
  }

  if (errors.length) {
    lines.push("## Capture errors", "");
    const byState = new Map();
    for (const c of errors) tally(byState, `${c.record.state}: ${c.record.error}`);
    for (const [k, n] of sortedTop(byState, 50)) lines.push(`- ${n} x ${k}`);
    lines.push("");
  }

  const text = `${lines.join("\n")}\n`;
  writeFileSync(path.join(outRoot, "summary.md"), text);
  return text;
}

if (process.argv[1] && process.argv[1].endsWith("summarize.mjs")) {
  const root = process.argv[2] ?? "C:/Users/aggressivecombo/neobox-scratch/qa/round0";
  process.stdout.write(writeSummary(root, process.argv[3] ?? path.basename(root)));
}
