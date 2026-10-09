// CPU profile of chart panning with N synthetic vessels: prints the top self-time functions.
import { chromium } from "playwright";
const N = Number(process.argv[2] ?? 100);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:5182/?mock=1&t=34&fleet=${N}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
const box = await page.locator(".c-chart").boundingBox();
await page.mouse.move(box.x + 400, box.y + 300);
await page.mouse.down();
for (let i = 0; i < 40; i++) await page.mouse.move(box.x + 400 + Math.sin(i / 5) * 150, box.y + 300 + Math.cos(i / 5) * 100);
await page.mouse.up();
const { profile } = await cdp.send("Profiler.stop");
const self = new Map();
const dt = profile.timeDeltas;
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-1)[0]}:${n.callFrame.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log("total sampled ms", (total / 1000).toFixed(0));
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log((v / 1000).toFixed(1).padStart(8), "ms", k));
await browser.close();
