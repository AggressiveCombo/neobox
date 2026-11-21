// Production build: bundles index.html (and everything it imports from src/)
// into dist/ (or $NEOBOX_CLIENT_OUT) and copies public/ next to it. dev/ is never imported here.
import { cp, readdir, rm } from "node:fs/promises";

const root = import.meta.dir;
const out = process.env.NEOBOX_CLIENT_OUT || `${root}/dist`;

await rm(out, { recursive: true, force: true });

// The wasm URL carries this hash (src/engine-loader.ts): an older build's worker misses its cache and fetches this build's copy.
const wasmFile = Bun.file(`${root}/public/neobox.wasm`);
const wasmVersion = (await wasmFile.exists()) ? new Bun.CryptoHasher("sha256").update(await wasmFile.bytes()).digest("hex").slice(0, 16) : "";
// The build id names this build to the bundle (BUILD_ID), the service worker and the server (build-id.txt).
const id = await buildId();
const result = await Bun.build({
  entrypoints: [`${root}/index.html`],
  outdir: out,
  minify: true,
  sourcemap: "linked",
  target: "browser",
  // Absolute asset URLs: a relative "./chunk-*.js" in index.html resolves under the page path, so a deep
  // unknown route would request a missing chunk and get the app shell back.
  publicPath: "/",
  // Fonts are served from public/fonts (also used by the server's admin page), not inlined.
  external: ["/fonts/*"],
  define: { WASM_VERSION: JSON.stringify(wasmVersion), BUILD_ID: JSON.stringify(id) },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await cp(`${root}/public`, out, { recursive: true });
await writeOfflineMaps(out);
await writeServiceWorker(out, id);
await Bun.write(`${out}/build-id.txt`, `${id}\n`);

if (!(await Bun.file(`${out}/neobox.wasm`).exists())) {
  console.warn("warning: neobox.wasm is missing; the integrator must build crates/wasm into client/public/");
}

/** The built-in maps the offline client needs, in the server's order: maps/*.json as {name, map} (the engine encodes them) and maps/*.txt as {name, code} (a map code). */
async function writeOfflineMaps(dir: string): Promise<void> {
  const mapsDir = `${root}/../maps`;
  const files = (await readdir(mapsDir)).filter((f) => f.endsWith(".json") || f.endsWith(".txt")).sort();
  const entries: ({ name: string; map: unknown } | { name: string; code: string })[] = [];
  for (const f of files) {
    const stem = f.replace(/\.(json|txt)$/, "");
    if (f.endsWith(".txt")) {
      entries.push({ name: stem, code: (await Bun.file(`${mapsDir}/${f}`).text()).trim() });
      continue;
    }
    const doc = (await Bun.file(`${mapsDir}/${f}`).json()) as { name?: unknown; map: unknown };
    entries.push({ name: typeof doc.name === "string" ? doc.name : stem, map: doc.map });
  }
  await Bun.write(`${dir}/offline-maps.json`, JSON.stringify(entries));
}

/**
 * The build id: a hash of every input the build reads, so it changes exactly when the shipped files or the server
 * they ship with would. The bundle carries it (BUILD_ID, src/version.ts), sw.js names its cache with it, and the
 * server reads build-id.txt to know which client it serves.
 */
async function buildId(): Promise<string> {
  const inputs: [label: string, dir: string, glob: string][] = [
    ["client/src", `${root}/src`, "**/*"],
    ["client/public", `${root}/public`, "**/*"],
    ["maps", `${root}/../maps`, "**/*"],
    ["crates", `${root}/../crates`, "**/*.{rs,toml}"],
  ];
  const files: [name: string, path: string][] = [];
  for (const [label, dir, glob] of inputs) {
    for await (const f of new Bun.Glob(glob).scan({ cwd: dir, onlyFiles: true })) {
      files.push([`${label}/${f.replaceAll("\\", "/")}`, `${dir}/${f}`]);
    }
  }
  for (const f of ["index.html", "service-worker.js", "build.ts"]) files.push([`client/${f}`, `${root}/${f}`]);
  files.push(["Cargo.lock", `${root}/../Cargo.lock`]);
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = new Bun.CryptoHasher("sha256");
  for (const [name, path] of files) {
    hash.update(name);
    hash.update(await Bun.file(path).bytes());
  }
  return hash.digest("hex").slice(0, 16);
}

/** sw.js: the service worker with this build's id and the files it precaches: every shipped file but source maps, sw.js itself, the share image, music and flags. */
async function writeServiceWorker(dir: string, build: string): Promise<void> {
  const files: string[] = [];
  for await (const raw of new Bun.Glob("**/*").scan({ cwd: dir })) {
    const f = raw.replaceAll("\\", "/");
    if (f.endsWith(".map") || f === "sw.js" || f === "og.png" || /^(music|flags)\//.test(f)) continue;
    files.push(f);
  }
  files.sort();
  const template = await Bun.file(`${root}/service-worker.js`).text();
  const sw = template.replaceAll("__BUILD__", build).replace("__PRECACHE__", () => JSON.stringify(files.map((f) => `/${f}`)));
  await Bun.write(`${dir}/sw.js`, sw);
}

let total = 0;
for (const o of result.outputs) {
  const gz = Bun.gzipSync(new Uint8Array(await o.arrayBuffer())).byteLength;
  total += gz;
  console.log(`${o.path.replace(root, "")}  ${o.size} B  (gzip ${gz} B)`);
}
console.log(`total JS/CSS gzip: ${total} B`);
