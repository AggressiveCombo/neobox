// Dev smoke test: drives the dev server through menu → browse → room → match in
// three passes (desktop, mobile, forced WebGL2). Start the server first with
// `bun client/dev/server.ts`, then run `node client/dev/smoke.mjs [baseUrl]`.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLAYWRIGHT = "C:/Users/aggressivecombo/hitbox-local/node_modules/playwright/index.mjs";
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "shots");
const BASE = process.argv[2] ?? "http://localhost:5173";
const STEP_TIMEOUT = 10_000;
const MATCH_SETTLE_MS = 2_000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Users/aggressivecombo/hitbox-local/ms-playwright/chromium-1228/chrome-win64/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];

const PASSES = [
  {
    name: "desktop",
    context: { viewport: { width: 1280, height: 720 } },
    args: [],
    expectRenderer: null,
  },
  {
    name: "mobile",
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    args: [],
    expectRenderer: null,
  },
  {
    name: "webgl2",
    context: { viewport: { width: 1280, height: 720 } },
    noWebGpu: true,
    expectRenderer: "webgl2",
  },
];

/** First existing Chromium binary: CHROME_PATH, the pinned copy, Playwright's bundled one, then system Chrome/Edge. */
function resolveChrome(chromium) {
  const bundled = chromium.executablePath();
  for (const candidate of [...CHROME_CANDIDATES, bundled]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("no Chromium binary found; set CHROME_PATH");
}

function shot(pass, step) {
  return path.join(SHOTS, `${pass.name}-${step}.png`);
}

async function runPass(chromium, executablePath, pass) {
  const failures = [];
  const browser = await chromium.launch({ executablePath, args: [...(pass.args ?? []), "--mute-audio"] });
  let renderer = "unknown";
  try {
    const context = await browser.newContext(pass.context);
    const page = await context.newPage();
    if (pass.noWebGpu) {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined });
      });
    }
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      if (msg.location().url.endsWith("/favicon.ico")) return;
      failures.push(`console error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => failures.push(`page error: ${err.message}`));

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const nameInput = page.getByPlaceholder("name", { exact: true });
    await nameInput.waitFor({ timeout: STEP_TIMEOUT });
    // The renderer is created when the match starts, so it is checked there.
    await page.screenshot({ path: shot(pass, "1-menu") });

    await nameInput.fill("tester");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor({ timeout: STEP_TIMEOUT });
    await page.screenshot({ path: shot(pass, "2-browse") });

    await page.getByLabel("room name", { exact: true }).fill("smoke room");
    await page.getByRole("button", { name: "Create room", exact: true }).click();
    const startBtn = page.getByRole("button", { name: "Start", exact: true });
    await startBtn.waitFor({ timeout: STEP_TIMEOUT });
    await page.screenshot({ path: shot(pass, "3-room") });

    await startBtn.click();
    await page.waitForTimeout(MATCH_SETTLE_MS);
    await page.locator(".hud-leave").waitFor({ timeout: STEP_TIMEOUT });
    renderer = await page.evaluate(() => document.documentElement.dataset.renderer ?? "none");
    if (pass.expectRenderer !== null && renderer !== pass.expectRenderer) {
      failures.push(`renderer is ${renderer}, expected ${pass.expectRenderer}`);
    }
    await page.screenshot({ path: shot(pass, "4-match") });
  } catch (err) {
    failures.push(`step failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  } finally {
    await browser.close();
  }
  return { renderer, failures };
}

const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
mkdirSync(SHOTS, { recursive: true });
const executablePath = resolveChrome(chromium);

let anyFailed = false;
for (const pass of PASSES) {
  const { renderer, failures } = await runPass(chromium, executablePath, pass);
  const status = failures.length === 0 ? "PASS" : "FAIL";
  console.log(`${status} ${pass.name} renderer=${renderer} shots=${SHOTS}`);
  for (const line of failures) console.log(`  - ${line}`);
  if (failures.length > 0) anyFailed = true;
}
process.exitCode = anyFailed ? 1 : 0;
