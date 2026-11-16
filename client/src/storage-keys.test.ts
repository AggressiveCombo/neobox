import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STORAGE_KEYS } from "./storage-keys";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("every neobox storage key literal in client source is in the registry", () => {
  const known = new Set(STORAGE_KEYS.map((k) => k.key));
  const unlisted: string[] = [];
  for (const file of sourceFiles(import.meta.dir)) {
    const text = readFileSync(file, "utf8");
    // `neobox.wasm` is the engine asset URL, not a storage key.
    for (const match of text.matchAll(/["'`](neobox\.(?!wasm["'`])[A-Za-z][\w.]*)["'`]/g)) {
      if (!known.has(match[1])) unlisted.push(`${file}: ${match[1]}`);
    }
  }
  expect(unlisted).toEqual([]);
});

test("registry keys are unique and namespaced", () => {
  const keys = STORAGE_KEYS.map((k) => k.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) expect(key.startsWith("neobox.")).toBe(true);
});
