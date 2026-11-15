// Copies the 4x3 country flags of flag-icons into client/public/flags (the room list shows the host's flag).
//
// Source: flag-icons, https://github.com/lipis/flag-icons (licence in the package: MIT). The LICENSE file is
// copied next to the SVGs.
// Usage: node tools/flags/fetch.mjs
// The package is fetched with `npm pack` and unpacked with `tar`; the version is pinned here.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const VERSION = "7.2.3";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../client/public/flags");

const work = await mkdtemp(join(tmpdir(), "flag-icons-"));
try {
  // shell: true so npm.cmd resolves on Windows; the arguments are fixed and contain no spaces.
  const { stdout } = await exec("npm", ["pack", `flag-icons@${VERSION}`, "--pack-destination", work], { shell: true });
  const tarball = join(work, stdout.trim().split("\n").pop().trim());
  await exec("tar", ["-xzf", tarball, "-C", work]);

  const src = join(work, "package/flags/4x3");
  const svgs = (await readdir(src)).filter((f) => f.endsWith(".svg"));
  await mkdir(outDir, { recursive: true });
  for (const f of svgs) await copyFile(join(src, f), join(outDir, f));
  await copyFile(join(work, "package/LICENSE"), join(outDir, "LICENSE-flag-icons.txt"));
  console.log(`copied ${svgs.length} flags (flag-icons ${VERSION}) to ${outDir}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
