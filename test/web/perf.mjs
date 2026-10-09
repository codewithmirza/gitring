// Performance check: the chart with N synthetic vessels (mock ?fleet=N).
//   node test/web/perf.mjs [N]
import { chromium } from "playwright";
const N = Number(process.argv[2] ?? 100);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`${process.env.BASE ?? "http://127.0.0.1:5182"}/?mock=1&t=34&fleet=${N}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
if (process.env.CSS) await page.addStyleTag({ content: process.env.CSS });
const vessels = await page.locator(".c-vessel").count();
const box = await page.locator(".c-chart").boundingBox();
await page.evaluate(() => {
  window.__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: "longtask", buffered: false });
  window.__frames = 0;
  const tick = () => { window.__frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const t0 = Date.now();
// pan and zoom continuously for ~3 s while the fleet moves
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
for (let i = 0; i < 60; i++) await page.mouse.move(box.x + box.width / 2 + Math.sin(i / 6) * 200, box.y + box.height / 2 + Math.cos(i / 6) * 120, { steps: 2 });
await page.mouse.up();
for (let i = 0; i < 20; i++) await page.mouse.wheel(0, i % 2 ? 100 : -100);
const secs = (Date.now() - t0) / 1000;
const res = await page.evaluate(() => ({ frames: window.__frames, long: window.__long }));
console.log(`vessels on chart: ${vessels}`);
console.log(`frames: ${res.frames} in ${secs.toFixed(1)} s → ${(res.frames / secs).toFixed(0)} fps`);
console.log(`long tasks: ${res.long.length}, max ${Math.max(0, ...res.long).toFixed(0)} ms, total ${res.long.reduce((a, b) => a + b, 0).toFixed(0)} ms`);
await page.screenshot({ path: process.env.OUT ?? "/dev/null" }).catch(() => {});
await browser.close();
