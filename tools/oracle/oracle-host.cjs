// Oracle host: drives the ORIGINAL Hitbox.io client (served by a local
// hitbox-local server) into a started single-player match in headless
// Chromium, then exposes an HTTP endpoint that evaluates JavaScript inside
// the page. Used to record reference trajectories from the original game.
//
//   BASE=http://localhost:8090 PORT=9333 node tools/oracle/oracle-host.cjs
//   curl -s localhost:9333/eval --data-binary @snippet.js
//
// The snippet is evaluated as the body of an async function; its return
// value is JSON-serialized into the response.
const http = require("http");
const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:8090";
const PORT = Number(process.env.PORT || 9333);
const EXE = process.env.PW_CHROMIUM || undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enterMatch(page) {
	await page.goto(BASE + "/game2.html", { waitUntil: "domcontentloaded", timeout: 60000 });
	await sleep(12000);
	await page.mouse.click(445, 430);
	await sleep(1500);
	await page.waitForSelector("input.nameInput:visible", { timeout: 30000 });
	await page.fill("input.nameInput", "Oracle");
	await page.mouse.click(635, 442);
	await sleep(4000);
	await page.click(".bigButton.custom");
	await sleep(2000);
	await page.mouse.click(340, 577);
	await sleep(1500);
	await page.waitForSelector("input.nameField", { timeout: 15000 });
	await page.fill("input.nameField", "OracleRoom");
	await page.click(".createWindow .createButton");
	await sleep(3000);
	if (process.env.NO_START) return;
	await page.getByText("START", { exact: true }).first().click();
	await page.waitForFunction(
		() => {
			const kr = window.multiplayerSession && window.multiplayerSession.KR;
			return kr && kr.uL && kr.uL.Ho && kr.uL.Ho.length >= 1 && kr.AI > 90;
		},
		null,
		{ timeout: 60000 },
	);
}

(async () => {
	const browser = await chromium.launch({ headless: true, executablePath: EXE });
	const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
	page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 300)));
	await enterMatch(page);
	console.log("oracle ready");
	http
		.createServer(async (req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", async () => {
				try {
					if (req.url === "/screenshot") {
						const png = await page.screenshot();
						res.writeHead(200, { "content-type": "image/png" });
						res.end(png);
						return;
					}
					const out = await page.evaluate(
						(src) => new Function("return (async () => {" + src + "})()")(),
						body,
					);
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(out));
				} catch (e) {
					res.writeHead(500);
					res.end(String(e && e.stack ? e.stack : e));
				}
			});
		})
		.listen(PORT, () => console.log("oracle listening on " + PORT));
})();
