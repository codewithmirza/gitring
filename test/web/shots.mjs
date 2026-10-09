// Visual QA: screenshot Gitring views in Day, Dusk and Night, desktop and phone.
//
//   node test/web/shots.mjs                     # all P0 views, all themes, both sizes
//   node test/web/shots.mjs chart day desktop   # filter by view / theme / size
//   BASE=http://127.0.0.1:5182 OUT=tmp/screenshots node test/web/shots.mjs
//
// The UI dev server must run: npx vite --config vite.ui.config.ts --port 5182 --host 127.0.0.1
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5182";
const OUT = process.env.OUT ?? "tmp/screenshots";
const args = process.argv.slice(2);

const VIEWS = {
  chart: { path: "/", t: 34 },
  "chart-selected": { path: "/?v=at-search-1", t: 34 },
  intent: { path: "/intents/in-search", t: 80 },
  "intent-landed": { path: "/intents/in-picks", t: 80 },
  logbook: { path: "/logbook", t: 80 },
  "logbook-detail": { path: "/logbook/ld-03", t: 80 },
  connect: { path: "/connect", t: 80 },
  sim: { path: "/sim", t: 80 },
  design: { path: "/design", t: 80 },
};
const THEMES = ["day", "dusk", "night"];
const SIZES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

const pick = (all) => {
  const chosen = all.filter((x) => args.includes(x));
  return chosen.length ? chosen : all;
};
const views = pick(Object.keys(VIEWS));
const themes = pick(THEMES);
const sizes = pick(Object.keys(SIZES));
const full = args.includes("full");

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let failures = 0;
for (const size of sizes) {
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: size === "mobile" ? 2 : 1, colorScheme: "light" });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`  [${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => {
    failures++;
    console.log(`  [pageerror] ${e.message}`);
  });
  for (const view of views) {
    for (const theme of themes) {
      const v = VIEWS[view];
      const sep = v.path.includes("?") ? "&" : "?";
      const url = `${BASE}${v.path}${sep}mock=1&t=${v.t}&freeze=1&theme=${theme}`;
      await page.goto(url, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(view.startsWith("intent") ? 1800 : 700);
      if (view === "sim") {
        await page.getByRole("button", { name: /Start simulation/ }).click().catch(() => {});
        await page.waitForTimeout(1600);
      }
      const file = `${OUT}/${view}-${theme}${size === "mobile" ? "-mobile" : ""}.png`;
      await page.screenshot({ path: file, fullPage: full });
      console.log("saved", file);
    }
  }
  await ctx.close();
}
await browser.close();
if (failures) {
  console.log(`${failures} page errors`);
  process.exitCode = 1;
}
