// Dump the mock harbor's ProjectState (for a fake live backend).  node test/web/dump-state.mjs out.json
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5182/?mock=1&t=80&freeze=1", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const st = await page.evaluate(() => JSON.stringify(window.__gitring.store.get().state));
writeFileSync(process.argv[2], st);
console.log("bytes", st.length);
await browser.close();
