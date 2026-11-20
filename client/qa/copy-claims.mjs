// Copy-claims detector (RUBRIC D25, metric copy.claims.unsourced). It flags factual, comparative and threshold
// claims in player-facing copy and checks each one against the register in client/qa/copy-claims.json. Static
// analysis only: no browser, no build, no server.
// Run: node client/qa/copy-claims.mjs [--src DIR] [--register FILE]   (exit 1 when the metric is > 0)
//
// Source strings (extractSourceStrings). Heuristic:
// - client/src .ts/.tsx: parsed with the TypeScript parser, so comments and code are never read. String literals,
//   no-substitution templates, template text (interpolations shown as "{}") and JSX text count, except import/export
//   paths, type literals, object keys, element-access keys, case labels, require() arguments, console.* calls and
//   JSX attributes other than text attributes (alt, title, placeholder, aria-label, aria-description, label).
// - client/index.html: text nodes and content/alt/title/aria-label/placeholder attributes (script and style skipped).
// - .json files: string values.
// - Skipped: *.test.ts(x), *.d.ts, profanity-words.ts (a word list the filter matches against, not shown copy),
//   folders test/tests/__tests__/e2e/node_modules/dist. CSS is not scanned.
// - A literal is copy when isProse() accepts it, or when it sits under an if-condition with a numeric literal
//   (a threshold verdict such as "no lag"). Threshold tagging: each string carries the numbers of every enclosing
//   if-condition (then/else branches only), so `if (n <= 40) return "may lag"` yields thresholds [40].
//
// Claims (findClaims). A string is a candidate claim when it has:
//   comparative: as fast as, faster, slower, more, less, better, lower, higher
//   number/unit: digits or ms, fps, px, hz, seconds, minutes, hours, days, ticks, mb, kb
//   absolute: only, never, always, all, every, no, zero, guaranteed
//   compatibility: works with, compatible, supports, native, same as
//   verdict: lag, laggy, lagging, unplayable, playable
//   threshold: it sits under an if-condition with a numeric literal
//
// Register (checkRegister). Entry shape:
//   { id, text, basis, design?, source: {file, symbol?}, truth: {check, value: true|false, evidence?: [{file, contains}]} }
// - text: substring of the copy, unique within source.file.
// - basis: "measurement" (a measurement on this engine, evidence must point at its artifact), "design" (an explicit
//   design reason, in `design`), "code" (the copy states a fact the code computes), or "hitbox" (the number or
//   verdict was copied from hitbox.io without measurement on this engine). "hitbox" always counts as unsourced.
// - truth.value false means the claim is untrue at HEAD. true requires truth.evidence: each file must contain its
//   `contains` needle at HEAD.
// A claim is sourced when exactly one entry covers it and that entry passes. Any other flagged claim is unsourced
// and counts toward copy.claims.unsourced. Register problems (malformed entries, missing source text, entries that
// no longer point at a flagged claim, duplicates) are listed in failures but are not counted.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const METRIC = "copy.claims.unsourced";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const DEFAULT_REGISTER = path.join(HERE, "copy-claims.json");
const BASES = ["measurement", "design", "code", "hitbox"];
const LIMIT_OPS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

const RULES = [
  ["comparative", /\b(as fast as|faster|slower|more|less|better|lower|higher)\b/gi],
  ["number", /\d[\d.,]*|\b(?:ms|fps|px|hz|seconds?|minutes?|hours?|days?|ticks?|mb|kb)\b/gi],
  ["absolute", /\b(only|never|always|all|every|no|zero|guaranteed)\b/gi],
  ["compatibility", /\b(works with|compatible|supports|native|same as)\b/gi],
  ["verdict", /\b(lag\w*|unplayable|playable)\b/gi],
];

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", "e2e"]);
const TEXT_ATTRS = new Set(["alt", "title", "placeholder", "aria-label", "aria-description", "label"]);
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026",
  rsquo: "\u2019", lsquo: "\u2018", ldquo: "\u201c", rdquo: "\u201d", middot: "\u00b7", times: "\u00d7",
};

/** Resolves --src: a repo root (client/src below it), the client/src folder itself, or any folder. */
export function resolveSrc(srcDir) {
  const dir = path.resolve(srcDir);
  if (fs.existsSync(path.join(dir, "client", "src"))) return { root: dir, scanDir: path.join(dir, "client", "src") };
  if (path.basename(dir) === "src" && path.basename(path.dirname(dir)) === "client") {
    return { root: path.dirname(path.dirname(dir)), scanDir: dir };
  }
  return { root: dir, scanDir: dir };
}

function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Kebab-case class list, e.g. "bind-add is-capturing": every token hyphenated. Such strings are code, not copy. */
function isClassList(t) {
  return /^[a-z0-9-]+( [a-z0-9-]+)*$/.test(t) && t.split(" ").every((w) => w.includes("-"));
}

/** Prose copy, as opposed to identifiers, class lists, CSS values and code. */
export function isProse(text) {
  const t = text.replace(/\{\}/g, " ").trim();
  if (!/[A-Za-z]/.test(t)) return false;
  if (/=>|[;={}<>\\]|--|\bvar\(|^[#.]|:\/\/|^\/|\.(mp3|mp4|svg|png|wasm|json|ts)\b|\b\d+(px|rem|em|vh|vw)\b/.test(t)) return false;
  if (!/\s/.test(t) && /[-_]|[a-z][A-Z]/.test(t)) return false;
  if (isClassList(t)) return false;
  if (/^[A-Z][a-z]+[.!?:]?$/.test(t)) return true;
  return (t.match(/[A-Za-z]{3,}/g) ?? []).length >= 2;
}

/** A CSS value written to an element's style (`style.transform = "..."`, `style.setProperty(name, "...")`): not copy. */
function isStyleValue(node) {
  const p = node.parent;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === node) {
    const target = p.left;
    return ts.isPropertyAccessExpression(target) && (/(^|\.)style$/.test(target.expression.getText()) || target.name.text === "cssText");
  }
  return ts.isCallExpression(p) && p.arguments.includes(node) && /\.setProperty$/.test(p.expression.getText());
}

function isCodeLiteral(node) {
  const p = node.parent;
  if (isStyleValue(node)) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isCaseClause(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isJsxAttribute(p)) return !TEXT_ATTRS.has(p.name.getText());
  if (ts.isCallExpression(p)) {
    const callee = p.expression.getText();
    if (callee === "require" || callee.startsWith("console.")) return true;
  }
  return false;
}

/** Numbers compared against in an if-condition (n <= 40, count > 2). 0 and 1 are presence checks, not limits. */
function limitsIn(expr) {
  const out = [];
  const walk = (n) => {
    if (ts.isBinaryExpression(n) && LIMIT_OPS.has(n.operatorToken.kind)) {
      for (const side of [n.left, n.right]) if (ts.isNumericLiteral(side)) out.push(Number(side.text));
    }
    ts.forEachChild(n, walk);
  };
  walk(expr);
  return out.filter((v) => v > 1);
}


function tsStrings(file, src) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const visit = (node, thresholds) => {
    if (ts.isIfStatement(node)) {
      visit(node.expression, thresholds);
      const inner = [...thresholds, ...limitsIn(node.expression)];
      visit(node.thenStatement, inner);
      if (node.elseStatement) visit(node.elseStatement, inner);
      return;
    }
    const add = (text) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ line, text, thresholds: [...new Set(thresholds)] });
    };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (!isCodeLiteral(node)) add(ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((s) => `{}${s.literal.text}`).join("") : node.text);
    } else if (ts.isJsxText(node)) {
      add(decodeEntities(node.getText(sf)).replace(/\s+/g, " ").trim());
    }
    ts.forEachChild(node, (c) => visit(c, thresholds));
  };
  visit(sf, []);
  return out;
}

function htmlStrings(src) {
  const text = src.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " "));
  const lineAt = (i) => text.slice(0, i).split("\n").length;
  const out = [];
  for (const m of text.matchAll(/>([^<]+)</g)) {
    out.push({ line: lineAt(m.index), text: decodeEntities(m[1]).replace(/\s+/g, " ").trim(), thresholds: [] });
  }
  for (const m of text.matchAll(/\s(content|alt|title|aria-label|placeholder)="([^"]*)"/g)) {
    out.push({ line: lineAt(m.index), text: decodeEntities(m[2]), thresholds: [] });
  }
  return out;
}

function jsonStrings(src) {
  let data;
  try {
    data = JSON.parse(src);
  } catch {
    return [];
  }
  const lineOf = (needle) => {
    const i = src.indexOf(needle);
    return i < 0 ? 1 : src.slice(0, i).split("\n").length;
  };
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push({ line: lineOf(JSON.stringify(v).slice(1, -1)), text: v, thresholds: [] });
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(data);
  return out;
}

function copyFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) copyFiles(full, out);
    } else if (/\.(tsx?|html|json)$/.test(ent.name) && !/\.test\.tsx?$|\.d\.ts$|^profanity-words\.ts$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Player-facing copy strings: [{file, line, text, thresholds}], file relative to the repo root. */
export function extractSourceStrings(srcDir) {
  const { root, scanDir } = resolveSrc(srcDir);
  const files = copyFiles(scanDir);
  const index = path.join(root, "client", "index.html");
  if (fs.existsSync(index)) files.push(index);
  const out = [];
  for (const full of files) {
    const file = path.relative(root, full).split(path.sep).join("/");
    const src = fs.readFileSync(full, "utf8");
    const ext = path.extname(full);
    const found = ext === ".html" ? htmlStrings(src) : ext === ".json" ? jsonStrings(src) : tsStrings(full, src);
    for (const s of found) {
      const threshold = s.thresholds.length > 0 && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(s.text);
      if (threshold || isProse(s.text)) out.push({ file, line: s.line, text: s.text, thresholds: s.thresholds });
    }
  }
  return out;
}

/** Flagged claims: [{id, file, line, text, terms, groups}]. Id is file:line, suffixed #n for a second string there. */
export function findClaims(strings) {
  const seen = new Map();
  const claims = [];
  for (const s of strings) {
    if (isClassList(s.text.trim())) continue;
    const hits = [];
    for (const [group, re] of RULES) {
      for (const m of s.text.matchAll(re)) hits.push({ group, term: m[0].toLowerCase() });
    }
    for (const n of s.thresholds ?? []) hits.push({ group: "threshold", term: `threshold:${n}` });
    if (hits.length === 0) continue;
    let id = `${s.file}:${s.line}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `#${n}`;
    claims.push({
      id,
      file: s.file,
      line: s.line,
      text: s.text,
      terms: [...new Set(hits.map((h) => h.term))],
      groups: [...new Set(hits.map((h) => h.group))],
    });
  }
  return claims;
}

function shapeProblem(e) {
  if (!e || typeof e !== "object") return "not an object";
  if (typeof e.id !== "string" || !e.id) return "missing id";
  if (typeof e.text !== "string" || !e.text) return "missing text";
  if (!BASES.includes(e.basis)) return `basis must be one of ${BASES.join("|")}`;
  if (e.basis === "design" && (typeof e.design !== "string" || !e.design)) return "design reason needed for basis design";
  if (!e.source || typeof e.source.file !== "string" || !e.source.file) return "source.file missing";
  if (e.source.symbol !== undefined && typeof e.source.symbol !== "string") return "source.symbol must be a string";
  if (!e.truth || typeof e.truth.check !== "string" || !e.truth.check) return "truth.check missing";
  if (typeof e.truth.value !== "boolean") return "truth.value must be true or false";
  if (e.truth.value && !(Array.isArray(e.truth.evidence) && e.truth.evidence.length > 0)) {
    return "truth.evidence needed when truth.value is true";
  }
  return null;
}

/**
 * Checks flagged claims against a register (array or {claims: [...]}). Entry file paths are relative to `root`;
 * `strings` is every extracted string (so stale entries are told apart from unflagged text). Returns
 * {failures, verdicts}: verdicts maps claim id -> {entry, reason}, reason null when the claim is sourced.
 */
export function checkRegister(claims, register, { root, strings = [] }) {
  const entries = Array.isArray(register) ? register : register?.claims;
  const failures = [];
  const verdicts = new Map();
  if (!Array.isArray(entries)) return { failures: ["register: expected a claims array"], verdicts };

  const files = new Map();
  const read = (rel) => {
    if (!files.has(rel)) {
      const full = path.resolve(root, rel);
      const inside = full.startsWith(path.resolve(root) + path.sep);
      const ok = inside && fs.existsSync(full) && fs.statSync(full).isFile();
      files.set(rel, ok ? fs.readFileSync(full, "utf8") : null);
    }
    return files.get(rel);
  };

  const ids = new Set();
  for (const e of entries) {
    const problem = shapeProblem(e);
    if (problem) {
      failures.push(`entry ${e?.id ?? "?"}: malformed (${problem})`);
      continue;
    }
    if (ids.has(e.id)) {
      failures.push(`entry ${e.id}: duplicate id`);
      continue;
    }
    ids.add(e.id);

    const src = read(e.source.file);
    if (src === null) {
      failures.push(`entry ${e.id}: source file ${e.source.file} missing`);
      continue;
    }
    if (e.source.symbol !== undefined && !src.includes(e.source.symbol)) {
      failures.push(`entry ${e.id}: ${e.source.file} no longer contains symbol "${e.source.symbol}"`);
    }
    const inFile = strings.filter((s) => s.file === e.source.file);
    const exact = inFile.filter((s) => s.text === e.text);
    const hay = exact.length > 0 ? exact : inFile.filter((s) => s.text.includes(e.text));
    const matches = (t) => (exact.length > 0 ? t === e.text : t.includes(e.text));
    if (hay.length === 0) {
      failures.push(`entry ${e.id}: ${e.source.file} no longer contains text "${e.text}"`);
      continue;
    }
    const distinct = new Set(hay.map((s) => s.text));
    if (distinct.size > 1) {
      failures.push(`entry ${e.id}: text "${e.text}" is not unique in ${e.source.file} (${distinct.size} different copies)`);
      continue;
    }
    const own = claims.filter((c) => c.file === e.source.file && matches(c.text));
    const visible = claims.filter((c) => c.file === "visible" && matches(c.text));
    if (own.length === 0) {
      failures.push(`entry ${e.id}: text "${e.text}" in ${e.source.file} is not a flagged claim (stale entry)`);
      continue;
    }

    let reason = null;
    if (e.truth.value === false) {
      reason = `untrue at HEAD: ${e.truth.check}`;
    } else {
      const missing = (e.truth.evidence ?? []).find((ev) => {
        const body = ev && typeof ev.file === "string" && typeof ev.contains === "string" ? read(ev.file) : null;
        return body === null || !body.includes(ev.contains);
      });
      if (missing) reason = `evidence not found: ${missing?.file ?? "?"} lacks "${missing?.contains ?? "?"}"`;
    }
    if (reason === null && e.basis === "hitbox") reason = "copied from hitbox, not measured on this engine";
    for (const c of [...own, ...visible]) {
      if (verdicts.has(c.id)) {
        failures.push(`claim ${c.id}: matched by entries ${verdicts.get(c.id).entry} and ${e.id}`);
        verdicts.set(c.id, { entry: null, reason: "covered by two entries" });
      } else {
        verdicts.set(c.id, { entry: e.id, reason });
      }
    }
  }
  return { failures, verdicts };
}

/** Loads a register file. */
export function loadRegister(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Runs the detector. Returns {metrics: {[METRIC]: N}, failures, claims}. N counts flagged claims with no passing
 * entry (unregistered, untrue, basis hitbox, or missing evidence). Register problems are listed in failures only.
 */
export function runCopyClaims({ srcDir = REPO, register = { claims: [] }, visibleStrings = [] } = {}) {
  const { root } = resolveSrc(srcDir);
  const source = extractSourceStrings(srcDir);
  const known = new Set(source.map((s) => s.text));
  const extra = [];
  for (const v of visibleStrings) {
    const text = (typeof v === "string" ? v : (v?.text ?? "")).trim();
    if (!text || known.has(text) || !isProse(text)) continue;
    known.add(text);
    extra.push({ file: "visible", line: 0, text, thresholds: [] });
  }
  const strings = [...source, ...extra];
  const claims = findClaims(strings);
  const { failures, verdicts } = checkRegister(claims, register, { root, strings });

  const results = claims.map((c) => {
    const v = verdicts.get(c.id);
    const sourced = v !== undefined && v.reason === null;
    return { ...c, sourced, entry: v?.entry ?? null, reason: sourced ? null : (v?.reason ?? "unregistered") };
  });
  const unsourced = results.filter((c) => !c.sourced);
  const out = [...failures];
  for (const c of unsourced) {
    const short = c.text.length > 90 ? `${c.text.slice(0, 87)}...` : c.text;
    out.push(`${c.id} "${short}" [${c.terms.join(", ")}]: ${c.reason}`);
  }
  return { metrics: { [METRIC]: unsourced.length }, failures: out, claims: results };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--src") args.src = argv[++i];
    else if (a === "--register") args.register = argv[++i];
    else if (a.startsWith("--src=")) args.src = a.slice(6);
    else if (a.startsWith("--register=")) args.register = a.slice(11);
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const srcDir = args.src ? path.resolve(args.src) : REPO;
  const register = loadRegister(args.register ? path.resolve(args.register) : DEFAULT_REGISTER);
  const res = runCopyClaims({ srcDir, register });
  const n = res.metrics[METRIC];
  console.log(`${METRIC}=${n}`);
  console.log(`flagged claims: ${res.claims.length}, sourced: ${res.claims.length - n}`);
  for (const f of res.failures) console.log(`  ${f}`);
  return n > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`copy-claims: ${err.message}`);
    process.exitCode = 2;
  }
}
