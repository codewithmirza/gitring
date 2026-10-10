// Interaction check against the mock harbor (the UI dev server must run on :5182).
//   node test/web/flows.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:5182";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
const step = (s) => console.log("·", s);
const expect = async (cond, msg) => {
  if (!(await cond)) {
    console.log("✗", msg);
    process.exitCode = 1;
  } else console.log("✓", msg);
};

// 1. Land an attempt from the compare lanes.
await page.goto(`${BASE}/intents/in-search?mock=1&t=80&freeze=1`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await expect(page.getByText("2 decisions").isVisible(), "judgment queue shows 2 decisions");
step("land PETREL-2");
await page.locator(".lane").first().getByRole("button", { name: "Land attempt" }).click();
await page.getByRole("dialog", { name: /Land PETREL-2/ }).waitFor();
await page.getByLabel("Why this attempt?").fill("Smaller diff. The search form stays on the list page.");
await page.getByRole("dialog").getByRole("button", { name: "Land attempt" }).click();
await page.getByText(/Landed on main/).first().waitFor({ timeout: 5000 });
await expect(page.locator(".lane.is-landed").count().then((n) => n === 1), "one lane shows landed");
await expect(page.locator(".lane.is-alternate").count().then((n) => n === 1), "the sibling stays as an alternate");
await expect(page.getByText("1 decision").isVisible(), "judgment queue drops to 1 decision");

// 2. The logbook has the new landing with the human reason.
step("open the logbook");
await page.getByRole("link", { name: "Logbook" }).first().click();
await page.waitForTimeout(400);
await expect(page.locator(".lrows > li").count().then((n) => n === 4), "logbook lists 4 landings");
await page.locator(".lrows > li").first().locator("a").click();
await page.waitForTimeout(800);
await expect(page.getByText("Smaller diff. The search form stays on the list page.", { exact: false }).first().isVisible(), "why trail shows the decision");
await expect(page.locator(".b-diff__file").count().then((n) => n >= 3), "why trail shows the landing diff");

// 3. Create and launch a new intent with the keyboard shortcut.
step("new intent");
await page.locator("body").press("Escape");
await page.locator("#main").click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press("n");
await page.getByRole("dialog", { name: "New intent" }).waitFor();
const dlg = page.getByRole("dialog", { name: "New intent" });
await dlg.getByRole("textbox", { name: "Title", exact: true }).fill("Show the stock count");
await dlg.getByRole("textbox", { name: "Goal", exact: true }).fill("Show In stock or Sold out under each price.");
await page.getByRole("button", { name: "Create and launch" }).click();
await page.waitForURL(/\/intents\/in-show-the-stock-count/);
await page.waitForTimeout(500);
await expect(page.locator(".lane").count().then((n) => n === 2), "two lanes for fan-out 2");
step("wait for the new attempts to finish");
await page.waitForTimeout(16000);
await expect(page.locator(".lane.is-ready").count().then((n) => n === 2), "both new attempts are ready");

// 4. Chart: select a vessel, read the detail, clear with Escape, zoom with the keyboard.
step("chart");
await page.goto(`${BASE}/?mock=1&t=34&freeze=1`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const vessels = await page.locator(".c-vessel").count();
await expect(Promise.resolve(vessels >= 6), `chart shows vessels (${vessels})`);
await page.locator('.c-vessel[data-attempt="at-search-1"]').click();
await expect(page.locator(".vdetail").isVisible(), "vessel detail opens");
await expect(page.url().includes("v=at-search-1"), "selection is in the URL");
await page.locator(".c-chart").focus();
await page.keyboard.press("Escape");
await expect(page.locator(".vdetail").count().then((n) => n === 0), "Escape clears the selection");
const before = await page.locator(".c-svg > g").nth(1).getAttribute("transform");
await page.keyboard.press("+");
const after = await page.locator(".c-svg > g").nth(1).getAttribute("transform");
await expect(Promise.resolve(before !== after), "plus key zooms the chart");
await page.locator(".c-buoy").first().click();
await expect(page.locator(".vdetail").isVisible(), "a buoy opens its vessel and correction");

// 5. Shortcuts dialog.
await page.locator(".c-chart").focus();
await page.keyboard.press("Escape");
await page.keyboard.press("?");
await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" }).isVisible(), "? opens the shortcuts");

if (errors.length) {
  console.log("page errors:\n  " + errors.join("\n  "));
  process.exitCode = 1;
}
await browser.close();
