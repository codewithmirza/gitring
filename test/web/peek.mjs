// Visual QA helper: open a URL, scroll an element into view, report iframes, screenshot.
//   node test/web/peek.mjs "<url>" out.png [selector] [width] [height]
import { chromium } from "playwright";
const [, , url, out, selector = "", width = "1440", height = "900"] = process.argv;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);
if (selector) await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "start" }), selector);
await page.waitForTimeout(1200);
for (const f of page.frames()) {
  if (f === page.mainFrame()) continue;
  try {
    const t = await f.evaluate(() => document.title + " | " + (document.body?.innerText || "").slice(0, 140).replace(/\s+/g, " "));
    console.log("frame:", t);
  } catch (e) {
    console.log("frame error:", e.message);
  }
}
await page.screenshot({ path: out });
await browser.close();
