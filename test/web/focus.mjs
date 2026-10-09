// Keyboard pass: tab through the chart view and screenshot focus states.
import { chromium } from "playwright";
const out = process.argv[2] ?? "/tmp";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5182/?mock=1&t=34&freeze=1&theme=night", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const seen = [];
for (let i = 0; i < 40; i++) {
  await page.keyboard.press("Tab");
  const d = await page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName.toLowerCase()}${a.getAttribute("role") ? "[" + a.getAttribute("role") + "]" : ""} ${(a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 50)}` : "none";
  });
  seen.push(d);
  if (i === 2) await page.screenshot({ path: `${out}/focus-nav.png`, clip: { x: 0, y: 0, width: 760, height: 90 } });
}
console.log(seen.map((s, i) => `${String(i + 1).padStart(2)} ${s}`).join("\n"));
// focus a vessel
await page.locator('.c-vessel[data-attempt="at-dark-1"]').focus();
await page.screenshot({ path: `${out}/focus-vessel.png`, clip: { x: 480, y: 280, width: 400, height: 200 } });
await browser.close();
