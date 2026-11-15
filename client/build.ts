// Production build: bundles index.html (and everything it imports from src/)
// into dist/ (or $NEOBOX_CLIENT_OUT) and copies public/ next to it. dev/ is never imported here.
import { cp, rm } from "node:fs/promises";

const root = import.meta.dir;
const out = process.env.NEOBOX_CLIENT_OUT || `${root}/dist`;

await rm(out, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${root}/index.html`],
  outdir: out,
  minify: true,
  sourcemap: "linked",
  target: "browser",
  // Fonts are served from public/fonts (also used by the server's admin page), not inlined.
  external: ["/fonts/*"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await cp(`${root}/public`, out, { recursive: true });

if (!(await Bun.file(`${out}/neobox.wasm`).exists())) {
  console.warn("warning: neobox.wasm is missing; the integrator must build crates/wasm into client/public/");
}

let total = 0;
for (const o of result.outputs) {
  const gz = Bun.gzipSync(new Uint8Array(await o.arrayBuffer())).byteLength;
  total += gz;
  console.log(`${o.path.replace(root, "")}  ${o.size} B  (gzip ${gz} B)`);
}
console.log(`total JS/CSS gzip: ${total} B`);
