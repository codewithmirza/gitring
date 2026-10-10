// Browser checks of the app shell against the mock API (test/web/shell-mock.mjs).
//   npm run build && node test/web/shell-mock.mjs 8799 &
//   node test/web/shell-e2e.mjs            (BASE=http://127.0.0.1:8799)
// Checks: sign-in popover, command palette, task composer (optimistic row, failed send keeps the text),
// decisions queue, inline panels, account page, keyboard paths and focus return, no modal dialogs,
// requests (no refetch on route change, no polling), and no horizontal overflow at 1280 and 375 px.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:8799";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log("✓", msg);
  else {
    failures++;
    console.log("✗", msg);
  }
};
const reset = () => fetch(`${BASE}/__mock/reset`, { method: "POST" });
const requests = async () => (await (await fetch(`${BASE}/__mock/log`)).json()).map((r) => `${r.method} ${r.path}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });

async function open(width, height, { signedIn = false, reducedMotion = "no-preference" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The mock answers 503 on purpose for a task titled "…fail…": the browser logs that load as an error.
  page.on("console", (m) => m.type() === "error" && !/status of 503/.test(m.text()) && errors.push(m.text()));
  if (signedIn) await page.goto(`${BASE}/auth/github/start?return=/projects`, { waitUntil: "networkidle" });
  return { ctx, page, errors };
}

const noOverflow = async (page, name) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  ok(o.sw <= o.cw && o.bw <= o.cw, `${name}: no horizontal overflow (${o.sw}/${o.cw})`);
};
const focusedText = (page) => page.evaluate(() => (document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent || "").trim().slice(0, 80));
const inPopover = (page) => page.evaluate(() => Boolean(document.activeElement?.closest(".b-pop")));

/* ───────────── visitor ───────────── */
for (const [w, h] of [
  [1280, 820],
  [375, 760],
]) {
  await reset();
  const { ctx, page, errors } = await open(w, h);
  const tag = `visitor ${w}px`;
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  ok(!(await page.getByText("Try the sample").count()), `${tag}: no sample on the start page`);
  ok(await page.getByRole("heading", { name: "Add gitring to your agent" }).isVisible(), `${tag}: the MCP connector section shows`);
  ok((await page.locator(".home__urlvalue").textContent())?.endsWith("/mcp"), `${tag}: the MCP URL ends with /mcp`);
  await noOverflow(page, `${tag} home`);

  const signInBtn = page.locator("[data-signin-anchor]");
  await signInBtn.click();
  const dlg = page.getByRole("dialog", { name: "Sign in to gitring" });
  await dlg.waitFor();
  ok(await signInBtn.getAttribute("aria-expanded") === "true", `${tag}: Sign in has aria-expanded=true`);
  ok(await page.locator(".b-pop__tail").isVisible(), `${tag}: the sign-in popover has a tail`);
  ok(await dlg.getByRole("link", { name: "Continue with GitHub" }).isVisible(), `${tag}: Continue with GitHub`);
  ok(await dlg.getByRole("link", { name: "Continue with Google" }).isVisible(), `${tag}: Continue with Google`);
  ok((await dlg.locator(".brand-mark--github path").count()) === 1 && (await dlg.locator("img.brand-mark--google").count()) === 1, `${tag}: both provider marks render`);
  ok(await inPopover(page), `${tag}: focus moved into the sign-in popover`);
  await noOverflow(page, `${tag} sign-in open`);
  if (w < 560) ok(await page.locator(".b-pop[data-sheet]").count() === 1, `${tag}: the popover is a sheet on a phone`);
  await page.keyboard.press("Escape");
  ok(!(await dlg.count()), `${tag}: Escape closes the sign-in popover`);
  ok(await page.evaluate(() => document.activeElement?.hasAttribute("data-signin-anchor")), `${tag}: focus returns to Sign in`);
  ok((await page.locator("dialog").count()) === 0, `${tag}: no modal <dialog> on the page`);

  // Last used provider goes first (the click leaves for the provider, so set it by hand).
  await page.evaluate(() => localStorage.setItem("gitring.lastProvider", "google"));
  await signInBtn.click();
  const first = await page.locator(".signin__buttons .b-provider").first().textContent();
  ok(first?.includes("Google") && first.includes("Last used"), `${tag}: the last used provider is first, tagged`);
  await page.keyboard.press("Escape");

  // A failed sign-in comes back with the reason in the panel.
  await page.goto(`${BASE}/?signin_error=stopped&provider=github`, { waitUntil: "networkidle" });
  await page.getByText("You stopped the sign-in. Nothing changed.").waitFor({ timeout: 3000 }).catch(() => {});
  ok(await page.getByText("You stopped the sign-in. Nothing changed.").isVisible(), `${tag}: a stopped sign-in shows the reason`);
  ok(!page.url().includes("signin_error"), `${tag}: the error leaves the address`);
  await page.keyboard.press("Escape");

  // Palette from the keyboard, also for visitors.
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type("connect");
  const opt = page.getByRole("option", { name: /Connect an agent/ });
  ok(await opt.first().isVisible(), `${tag}: the palette finds "Connect an agent" while typing`);
  ok(await page.getByRole("combobox").inputValue() === "connect", `${tag}: keys typed right after ${MOD}+K reach the input`);
  await noOverflow(page, `${tag} palette open`);
  await page.keyboard.press("Enter");
  await page.waitForURL(/home-connect/);
  ok(page.url().includes("#home-connect"), `${tag}: Enter runs the palette item (a visitor gets the connector steps)`);
  ok(await page.getByRole("heading", { name: "Add gitring to your agent" }).isVisible(), `${tag}: the connector steps are in view`);
  ok(errors.length === 0, `${tag}: no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── signed in, desktop ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820, { signedIn: true });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  ok(/\/overview\?project=shop/.test(page.url()), "a signed-in person on / goes to their project");
  await fetch(`${BASE}/__mock/reset`, { method: "POST" }).catch(() => {});
  // The log restarts; the session cookie is gone with the reset, so sign in again and count from here.
  await page.goto(`${BASE}/auth/github/start?return=/overview?project=shop`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  let log = await requests();
  const count = (re) => log.filter((r) => re.test(r)).length;
  ok(count(/^GET \/api\/projects\/shop\/state/) === 1, `one state request at boot (${count(/^GET \/api\/projects\/shop\/state/)})`);
  ok(count(/^GET \/api\/me$/) === 1 && count(/^GET \/api\/projects$/) === 1, "one /api/me and one /api/projects at boot");
  ok(count(/^WS \/ws\/shop/) === 1, "one live socket");

  // Route changes read live state: no refetch.
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await page.waitForURL(/\/tasks/);
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await page.waitForURL(/\/history/);
  await page.keyboard.press("g");
  await page.keyboard.press("o");
  await page.waitForURL(/\/overview/);
  await page.waitForTimeout(1500);
  log = await requests();
  ok(count(/^GET \/api\/projects\/shop\/state/) === 1, "no state refetch on route changes (g t, g h, g o)");
  ok(log.length <= 6, `no polling: ${log.length} requests in total (${log.join(", ")})`);

  // Composer: n, title, Enter, goal, Ctrl+Enter → a "Sending…" row at once, then the real task.
  await page.keyboard.press("n");
  const title = page.getByRole("textbox", { name: "Title" });
  await title.waitFor();
  ok(await title.evaluate((el) => el === document.activeElement), "n opens the composer with the title focused");
  await page.keyboard.type("Show the stock count");
  await page.keyboard.press("Enter");
  ok(await page.getByRole("textbox", { name: "Goal" }).evaluate((el) => el === document.activeElement), "Enter in the title moves to the goal");
  await page.keyboard.type("Show In stock or Sold out under each price.");
  ok((await page.getByRole("button", { name: /Create and start 2 agents/ }).count()) === 1, "the create button says what happens (2 agents)");
  await page.keyboard.press(`${MOD}+Enter`);
  ok(await page.getByText("Sending…").first().isVisible(), "the new task shows at once as Sending…");
  await page.locator(".irow:not(.irow--pending)").filter({ hasText: "Show the stock count" }).last().waitFor({ timeout: 4000 });
  await page.waitForTimeout(400);
  ok((await page.locator(".irow--pending").count()) === 0, "the Sending… row goes when the live state has the task");

  // A failed send keeps the text.
  await page.keyboard.press("n");
  await title.waitFor();
  await page.keyboard.type("This will fail");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.getByText(/Your text is safe/).waitFor({ timeout: 4000 });
  ok((await title.inputValue()) === "This will fail", "after a failed send the title comes back");
  ok(await page.getByText(/The project is busy/).first().isVisible(), "the error says what happened");
  await page.keyboard.press("Escape");
  ok(await page.locator(".composer__ghost").getByText("Draft").isVisible(), "Escape closes the composer and keeps a draft");

  // Shortcuts popover.
  await page.locator("#main").click({ position: { x: 600, y: 300 } }).catch(() => {});
  await page.keyboard.press("?");
  const keys = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await keys.waitFor();
  ok(await keys.isVisible(), "? opens the shortcuts popover");
  await page.keyboard.press("Escape");
  ok(!(await keys.count()), "Escape closes the shortcuts popover");

  // Decisions: one suggested action, Enter runs it.
  const queue = page.locator(".topbar__queue");
  await queue.click();
  const merge = page.getByRole("button", { name: "Merge PETREL-2" });
  await merge.waitFor();
  ok(await merge.evaluate((el) => el === document.activeElement), "the suggested action has focus");
  await page.keyboard.press("Enter");
  await page.getByText(/Merged into main/).first().waitFor({ timeout: 4000 });
  ok(await page.getByText(/Merged into main/).first().isVisible(), "Enter on the suggestion merges (toast)");
  await page.waitForTimeout(300);
  ok((await queue.getAttribute("aria-label"))?.startsWith("No decisions"), "the decision count clears");
  await page.keyboard.press("Escape");

  // Project switcher: type to filter, Escape returns focus.
  const sw = page.locator(".acct-switch");
  await sw.click();
  await page.keyboard.type("inf");
  ok((await page.getByRole("option").count()) === 1 && (await page.getByRole("option").first().textContent())?.includes("Infra"), "the project switcher filters while typing");
  await page.keyboard.press("Escape");
  ok(await sw.evaluate((el) => el === document.activeElement), "Escape returns focus to the project switcher");

  // User menu: a real menu with arrow keys.
  await page.locator(".acct-me").click();
  const menu = page.getByRole("menu", { name: "Account" });
  await menu.waitFor();
  const firstItem = await focusedText(page);
  await page.keyboard.press("ArrowDown");
  const second = await focusedText(page);
  ok(firstItem.startsWith("Account") && second.startsWith("Projects"), `the menu moves with arrow keys (${firstItem} → ${second})`);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/account/);
  ok(page.url().includes("/account"), "Enter on Account opens /account");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── task page and account, desktop ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820, { signedIn: true });
  await page.goto(`${BASE}/tasks/i_search?project=shop`, { waitUntil: "networkidle" });
  const lane = page.locator(".lane").first();
  const mergeBtn = lane.getByRole("button", { name: "Merge", exact: true });
  await mergeBtn.click();
  const panel = page.getByRole("form", { name: /Merge the work of PETREL-2/ });
  await panel.waitFor();
  ok((await panel.locator("textarea").inputValue()).includes("8 of 8 tests pass"), "the merge reason is filled in from the facts");
  ok(await panel.getByRole("button", { name: "Merge into main and update the pull request" }).isVisible(), "the merge button states the result (GitHub pull request)");
  await page.keyboard.press("Escape");
  ok(!(await panel.count()), "Escape closes the merge panel");
  ok(await mergeBtn.evaluate((el) => el === document.activeElement), "focus returns to Merge");

  await page.getByRole("button", { name: "Change the goal" }).click();
  const amend = page.getByRole("form", { name: "Change the goal" });
  await amend.locator("textarea").fill("Add a search to the shop. Match titles and authors.");
  await amend.getByRole("button", { name: "Save as version 2" }).click();
  await page.getByText("Goal changed (version 2)").waitFor({ timeout: 4000 });
  ok(await page.getByText("Match titles and authors").first().isVisible(), "the goal changes in place");

  await lane.getByRole("button", { name: /Show the diff/ }).click();
  await lane.locator(".b-diff__file").first().waitFor({ timeout: 4000 });
  ok((await lane.locator(".b-diff__file").count()) === 2, "the diff opens inside the work copy");
  ok((await page.locator("dialog").count()) === 0, "no modal <dialog> on the task page");

  // Account: revoke an app with a second click, create a key, disconnect GitHub.
  await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  const claude = page.locator(".acct-row").filter({ hasText: "Claude" });
  await claude.getByRole("button", { name: "Revoke Claude" }).click();
  ok(await claude.getByText("The app stops at once. Its work copies stay.").isVisible(), "Revoke asks in place and says the result");
  ok(await claude.getByRole("button", { name: "Revoke" }).evaluate((el) => el === document.activeElement), "the confirm button takes the focus");
  await page.keyboard.press("Escape");
  ok(await claude.getByRole("button", { name: "Revoke Claude" }).isVisible(), "Escape keeps the app");
  await claude.getByRole("button", { name: "Revoke Claude" }).click();
  await page.waitForTimeout(350);
  await claude.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.waitForTimeout(500);
  ok((await page.locator(".acct-row").filter({ hasText: "Claude" }).count()) === 0, "a second click revokes the app");
  await page.getByRole("button", { name: "Create key" }).click();
  await page.getByLabel("Key name").fill("ci runner");
  await page.keyboard.press("Enter");
  await page.getByText(/Copy the key “ci runner” now/).waitFor({ timeout: 4000 });
  ok(await page.getByText(/gitring shows it only once/).isVisible(), "a new key shows once with a copy button");
  const gh = page.locator(".acct-row").filter({ hasText: "GitHub" });
  await gh.getByRole("button", { name: "Disconnect GitHub" }).click();
  await page.waitForTimeout(350);
  await gh.getByRole("button", { name: "Disconnect", exact: true }).click();
  await gh.getByRole("button", { name: "Connect GitHub" }).waitFor({ timeout: 4000 });
  ok(await gh.getByRole("button", { name: "Connect GitHub" }).isVisible(), "Disconnect GitHub shows Connect GitHub after");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── phone ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(375, 760, { signedIn: true });
  for (const path of ["/overview?project=shop", "/tasks?project=shop", "/tasks/i_search?project=shop", "/history?project=shop", "/account", "/code?project=shop"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await noOverflow(page, `phone ${path}`);
  }
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  ok(await page.locator(".bottomnav").isVisible(), "phones get the bottom bar");
  ok(!(await page.locator(".topbar__nav").isVisible()), "phones hide the top tabs");
  await page.locator(".topbar__queue").click();
  ok(await page.locator(".b-pop[data-sheet]").count() === 1, "the decisions popover is a sheet on a phone");
  await noOverflow(page, "phone decisions open");
  await page.keyboard.press("Escape");
  await page.locator(".bottomnav").getByRole("link", { name: "Tasks" }).click();
  await page.waitForURL(/\/tasks/);
  await page.locator(".composer__ghost").click();
  await noOverflow(page, "phone composer open");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── reduced motion ───────────── */
{
  await reset();
  const { ctx, page } = await open(1280, 820, { reducedMotion: "reduce" });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator("[data-signin-anchor]").click();
  const anim = await page.locator(".b-pop").evaluate((el) => getComputedStyle(el).animationName);
  ok(anim === "b-fade-in", `reduced motion: the popover only fades (${anim})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
