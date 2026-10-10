// Browser checks of the code view, the history, the overview and the request layer, against the mock
// Worker in test/web/code-mock.mjs.
//
//   npm run build && node test/web/code-mock.mjs 8797 &
//   node test/web/code-e2e.mjs            (BASE=http://127.0.0.1:8797, CHROMIUM=/opt/pw-browsers/chromium)
//
// The code view needs the /code route of the app shell. Without it (this branch alone) the code checks
// say so and stop; the other checks still run.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:8797";
const MAIN = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
let failures = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) console.log("✓", msg);
  else {
    failures++;
    console.log("✗", msg, extra);
  }
};
const reset = () => fetch(`${BASE}/__mock/reset`, { method: "POST" });
const log = async () => (await (await fetch(`${BASE}/__mock/log`)).json()).filter((r) => !r.asset);
const assets = async () => (await (await fetch(`${BASE}/__mock/log`)).json()).filter((r) => r.asset).map((r) => r.path);
const count = (entries, re) => entries.filter((r) => re.test(`${r.method} ${r.path}`)).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });

async function open(width, height, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: opts.reducedMotion ?? "no-preference", hasTouch: width < 600, isMobile: false });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/status of 404/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

const noOverflow = async (page, name) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  ok(o.sw <= o.cw && o.bw <= o.cw, `${name}: no horizontal overflow (${o.sw}/${o.cw})`);
};
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a?.tagName, role: a?.getAttribute("role"), label: (a?.getAttribute("aria-label") || a?.textContent || "").trim().slice(0, 80), cls: a?.className ?? "" };
});

/* ───────────── A. boot, requests, live connection ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".c-svg--world").first().waitFor({ timeout: 10_000 });
  let l = await log();
  ok(count(l, /^GET \/api\/me$/) === 1, "boot: one /api/me");
  ok(count(l, /^GET \/api\/projects$/) === 1, "boot: one /api/projects");
  ok(count(l, /^GET \/api\/projects\/shop\/state$/) === 1, "boot: one state request");
  ok(count(l, /^WS \/ws\/shop$/) === 1, "boot: one WebSocket");
  const me = l.find((r) => r.path === "/api/me");
  const st = l.find((r) => r.path === "/api/projects/shop/state");
  ok(me && st && Math.abs(st.at - me.at) < 60, "boot: the state request does not wait for the account requests", `${st?.at - me?.at} ms`);
  ok((await assets()).some((a) => /\/assets\/Chart-[\w-]+\.js$/.test(a)), "overview: the map loads as its own chunk");
  ok((await assets()).some((a) => /\/assets\/react-[\w-]+\.js$/.test(a)), "React loads as its own chunk");

  // Moving between views does not ask again for the account or the state.
  for (const name of ["History", "Tasks", "Overview", "History"]) {
    await page.getByRole("link", { name, exact: true }).first().click();
    await page.waitForLoadState("networkidle");
  }
  l = await log();
  ok(count(l, /^GET \/api\/me$/) === 1 && count(l, /^GET \/api\/projects$/) === 1 && count(l, /\/state$/) === 1, "navigation: no new account or state requests", JSON.stringify(l.map((r) => r.path)));
  const before = l.length;
  await sleep(6500);
  l = await log();
  ok(l.length === before, "idle 6.5 s: no polling", JSON.stringify(l.slice(before).map((r) => r.path)));

  // The socket drops: the app reconnects, and the snapshot of the new socket resyncs (no state request).
  await fetch(`${BASE}/__mock/drop`, { method: "POST" });
  let reconnected = false;
  for (let i = 0; i < 40 && !reconnected; i++) {
    await sleep(250);
    reconnected = count(await log(), /^WS \/ws\/shop$/) >= 2;
  }
  ok(reconnected, "socket drop: the app reconnects");
  await sleep(6000);
  l = await log();
  ok(count(l, /\/state$/) === 1, "reconnect: the snapshot over the socket resyncs, no state request");
  ok(!errors.length, "boot: no page errors", errors.join(" | "));
  await ctx.close();
}

/* ───────────── B. history ───────────── */
for (const [w, h] of [
  [1280, 820],
  [375, 760],
]) {
  await reset();
  const tag = `history ${w}px`;
  const { ctx, page, errors } = await open(w, h);
  await page.goto(`${BASE}/history?project=shop`, { waitUntil: "networkidle" });
  const rows = page.locator("a[data-lrow]");
  await rows.first().waitFor();
  ok((await rows.count()) === 2, `${tag}: two merges`);
  const days = await page.locator(".lday__label").allTextContents();
  // The merges are 1 h and 26 h old: two day groups, the newer one today or (right after midnight) yesterday.
  ok(days.length === 2 && days[0] !== days[1] && /^(Today|Yesterday)$/.test(days[0]), `${tag}: rows grouped by day`, days.join(","));
  const fileHref = await page.locator(".lrow__file").first().getAttribute("href");
  ok(fileHref?.startsWith(`/code/${MAIN}/`) && fileHref.includes("project=shop"), `${tag}: rows link to their files in the code view`, fileHref);
  await noOverflow(page, tag);

  await page.getByLabel("Filter the merges").fill("readme");
  await sleep(100);
  ok((await rows.count()) === 1, `${tag}: filter by a file name`);
  await page.getByLabel("Filter the merges").fill("");

  if (w > 600) {
    await rows.first().hover();
    await sleep(400);
    ok(count(await log(), /landings\/l1$/) === 1, `${tag}: hover starts loading the record`);
    await rows.first().click();
    await page.getByRole("heading", { name: "Fix the footer links", level: 1 }).waitFor();
    await page.locator(".why__files").waitFor();
    ok(count(await log(), /landings\/l1$/) === 1, `${tag}: the record opens from memory (no second request)`);
    const why = page.getByRole("button", { name: "Why", exact: true }).first();
    if (await why.count()) {
      await why.click();
      ok((await page.locator(".evid").count()) >= 1, `${tag}: a conflict check shows its evidence`);
    } else ok((await page.locator(".evid").count()) >= 1, `${tag}: the last change request check shows its evidence`);
    ok((await page.locator(".why__files a").count()) >= 1, `${tag}: the record links the changed files`);
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/history\?project=shop$/);
    await sleep(100);
    const f = await focused(page);
    ok(f.tag === "A" && /Fix the footer links/.test(f.label), `${tag}: Escape closes the record and focus goes back to its row`, JSON.stringify(f));
    await page.keyboard.press("j");
    ok(/Write the first page/.test((await focused(page)).label), `${tag}: j moves to the next row`);
    await page.keyboard.press("k");
    ok(/Fix the footer links/.test((await focused(page)).label), `${tag}: k moves to the row above`);
    await page.keyboard.press("k");
    ok((await focused(page)).tag === "INPUT", `${tag}: k on the first row goes to the filter`);
    await page.locator("h1").first().click();
    await page.keyboard.press("j");
    ok(/Fix the footer links/.test((await focused(page)).label), `${tag}: j from the page moves to the first row`);
  } else {
    await rows.first().click();
    await page.getByRole("heading", { name: "Fix the footer links", level: 1 }).waitFor();
    await page.locator(".why__files").waitFor();
    await noOverflow(page, `${tag} record`);
  }
  ok(!errors.length, `${tag}: no page errors`, errors.join(" | "));
  await ctx.close();
}

/* ───────────── C. code view ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/code?project=shop`, { waitUntil: "networkidle" });
  const routed = await page.locator(".cv").count();
  if (!routed) {
    console.log("· code view: the /code route is not in this app shell (merge the shell branch to check it)");
  } else {
    const tag = "code 1280px";
    await page.getByRole("tree").waitFor();
    ok(await page.locator(".cv-static").getByText("Saltmarsh shop").count(), `${tag}: README shows under the file list`);
    ok(await page.getByRole("heading", { name: "Where agents work" }).isVisible(), `${tag}: "Where agents work" shows`);
    let l = await log();
    ok(!count(l, /\/tree\?ref=main/), `${tag}: main's tree comes from the live state (no request)`);

    // Open a file from the tree (folders where agents work are open already).
    const src = page.getByRole("treeitem", { name: /^src, folder/ });
    ok((await src.getAttribute("aria-expanded")) === "true", `${tag}: folders where agents work start open`);
    await page.getByRole("treeitem", { name: /^cart\.js/ }).click();
    await page.waitForURL(/\/code\/main\/src\/cart\.js/);
    await page.locator(".cv-line").first().waitFor();
    l = await log();
    ok(count(l, new RegExp(`file\\?ref=${MAIN}&path=src%2Fcart\\.js`)) === 1, `${tag}: main files load by commit id (cacheable forever)`);
    ok((await page.locator(".cv-lane--change").count()) > 0 && (await page.locator(".cv-lane--keepout").count()) > 0, `${tag}: the gutter marks changed lines and keep-out lines`);
    ok((await page.locator(".cv-lane.is-approx").count()) > 0, `${tag}: lines on an older base are dashed`);
    const ctxText = await page.locator(".cv-ctx").textContent();
    ok(/PETREL-2/.test(ctxText) && /KESTREL-7/.test(ctxText) && /Change request to/.test(ctxText), `${tag}: who works on the file`, ctxText);
    ok((await page.locator(".tk-kw").count()) > 0 && (await page.locator(".tk-com").count()) > 0, `${tag}: syntax colors`);

    // The gutter mark opens a popover with the work copy and its change.
    await page.locator(".cv-gut--btn").first().click();
    const pop = page.getByRole("dialog", { name: /Who works on line/ });
    await pop.waitFor();
    ok(await pop.getByText(/PETREL-2/).count(), `${tag}: the mark names the agent`);
    ok(await pop.getByRole("link", { name: "Show the change" }).count(), `${tag}: the mark links to the change`);
    await page.keyboard.press("Escape");
    ok(!(await pop.count()), `${tag}: Escape closes the mark popover`);

    // j moves to the marks.
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press("j");
    await sleep(150);
    ok((await page.locator(".cv-line.is-flash").count()) > 0, `${tag}: j moves to a mark`);
    ok((await focused(page)).cls.includes("cv-gut--btn"), `${tag}: j puts the focus on the mark`);

    // Line selection in the address, and go to line.
    await page.locator('.cv-ln[data-n="20"]').click();
    await page.waitForURL(/#L20$/);
    ok((await page.locator(".cv-line.is-sel").count()) === 1, `${tag}: a click on a line number selects it`);
    await page.locator('.cv-ln[data-n="24"]').click({ modifiers: ["Shift"] });
    await page.waitForURL(/#L20-L24$/);
    ok((await page.locator(".cv-line.is-sel").count()) === 5, `${tag}: Shift-click selects a range`);
    await page.locator("body").press("l");
    const lineBox = page.getByLabel(/Line or range/);
    await lineBox.waitFor();
    await lineBox.fill("45");
    await lineBox.press("Enter");
    await page.waitForURL(/#L45$/);
    ok(true, `${tag}: l goes to a line`);

    // More: the rare actions, in a menu that grows from its button.
    const more = page.getByRole("button", { name: "More" });
    await more.click();
    const menu = page.getByRole("menu", { name: "More actions" });
    await menu.waitFor();
    ok((await focused(page)).role === "menuitem", `${tag}: the menu puts the focus on its first item`);
    await page.keyboard.press("ArrowDown");
    ok(/Copy path/.test((await focused(page)).label), `${tag}: ↓ moves in the menu`);
    await page.keyboard.press("Enter");
    await page.getByText("Path copied").waitFor();
    ok(!(await menu.count()) && (await more.getAttribute("aria-expanded")) === "false", `${tag}: choosing an item closes the menu`);
    ok((await page.evaluate(() => navigator.clipboard.readText()).catch(() => "")) === "src/cart.js", `${tag}: Copy path copies the path`);

    // y copies a link with the commit.
    await page.locator("body").press("y");
    await sleep(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    ok(clip.includes(`/code/${MAIN}/src/cart.js`) && clip.includes("#L45") && clip.includes("project=shop"), `${tag}: y copies a link with the commit`, clip);

    // t: the file finder.
    await page.locator("body").press("t");
    const finder = page.getByRole("combobox", { name: "File name or path" });
    await finder.waitFor();
    ok((await focused(page)).role === "combobox", `${tag}: t opens the finder with focus in it`);
    await finder.fill("theme");
    await sleep(150);
    ok((await page.getByRole("option").first().textContent())?.includes("theme.css"), `${tag}: the finder ranks theme.css first`);
    await finder.press("Enter");
    await page.waitForURL(/\/code\/main\/src\/styles\/theme\.css/);
    ok(true, `${tag}: Enter opens the file`);
    ok((await focused(page)).tag !== "INPUT", `${tag}: the finder closes after the choice`);

    // w: switch to a work copy (the path stays).
    await page.locator("body").press("w");
    const refBox = page.getByRole("combobox", { name: /Filter main and the work copies/ });
    await refBox.waitFor();
    await refBox.fill("total");
    await refBox.press("Enter");
    await page.waitForURL(/\/code\/at_s1\/src\/styles\/theme\.css/);
    await page.getByRole("treeitem", { name: /^cart\.js, changed in this work copy/ }).waitFor();
    ok(true, `${tag}: w switches to the work copy and the tree marks its changes`);
    await page.getByRole("treeitem", { name: /^cart\.js, changed/ }).click();
    await page.waitForURL(/\/code\/at_s1\/src\/cart\.js/);
    await page.locator(".cv-lane--own").first().waitFor();
    ok(true, `${tag}: the work copy's own changed lines are marked`);
    await page.locator("body").press("d");
    await page.waitForURL(/view=diff/);
    await page.locator(".cv-diff .cv-drow--add").first().waitFor();
    ok((await page.getByRole("tree").getByRole("treeitem").filter({ hasText: ".js" }).count()) === 2, `${tag}: the diff shows only the changed files in the tree`);

    // A change of the work copy: its tree loads again (one request) and shows the new file.
    await fetch(`${BASE}/__mock/reset?data=keep`, { method: "POST" });
    await fetch(`${BASE}/__mock/bump`, { method: "POST" });
    await page.getByRole("treeitem", { name: /total\.test\.js/ }).waitFor({ timeout: 5000 });
    l = await log();
    ok(count(l, /attempts\/at_s1\/diff/) === 1, `${tag}: one diff request after the work copy changed`, JSON.stringify(l.map((r) => r.path)));
    // Back to main and to the work copy: the tree revalidates with its ETag (304).
    await page.goto(`${BASE}/code/main/src/cart.js?project=shop`, { waitUntil: "networkidle" });
    await fetch(`${BASE}/__mock/reset?data=keep`, { method: "POST" });
    await page.locator("body").press("w");
    await page.getByRole("combobox", { name: /Filter main and the work copies/ }).fill("total");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/code\/at_s1\//);
    await page.waitForLoadState("networkidle");
    l = await log();
    const treeReq = l.filter((r) => r.path.startsWith("/api/projects/shop/tree?ref=at_s1"));
    ok(treeReq.length <= 1, `${tag}: at most one tree request for the work copy`, JSON.stringify(treeReq));

    // A large file: only the lines on screen exist in the page.
    await page.goto(`${BASE}/code/main/data/big.json?project=shop`, { waitUntil: "networkidle" });
    await page.locator(".cv-line").first().waitFor();
    const n = await page.locator(".cv-line").count();
    ok(n < 200, `${tag}: a 20,002-line file renders ${n} lines`);
    await page.locator(".cv-lines").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.locator('.cv-ln[data-n="20002"]').waitFor({ timeout: 3000 });
    ok(true, `${tag}: the end of a large file renders after a scroll`);
    await page.goto(`${BASE}/code/main/data/big.json?project=shop#L15000`, { waitUntil: "networkidle" });
    await page.locator('.cv-line.is-sel[data-line="15000"]').waitFor({ timeout: 3000 });
    ok(true, `${tag}: a line in the address scrolls into view`);

    // Other states.
    await page.goto(`${BASE}/code/main/public/logo.png?project=shop`, { waitUntil: "networkidle" });
    ok(await page.getByText("gitring does not show binary files").count(), `${tag}: binary files say so`);
    await page.goto(`${BASE}/code/nope?project=shop`, { waitUntil: "networkidle" });
    ok(await page.getByText("gitring does not know this ref").count(), `${tag}: an unknown ref says so`);
    await page.goto(`${BASE}/code/at_f1?project=shop`, { waitUntil: "networkidle" });
    ok(await page.getByText("This work copy merged").count(), `${tag}: a merged work copy points to main`);
    await page.goto(`${BASE}/code/at_s2?view=diff&project=shop`, { waitUntil: "networkidle" });
    await page.locator(".cv-alldiffs").waitFor();
    ok((await page.locator(".cv-diff").count()) === 3, `${tag}: all changes of a work copy (3 files)`);

    // The tree with the keyboard: one tab stop, arrows, Enter.
    await page.goto(`${BASE}/code?project=shop`, { waitUntil: "networkidle" });
    await page.getByRole("tree").waitFor();
    const first = page.getByRole("treeitem").first();
    await first.focus();
    await page.keyboard.press("ArrowDown");
    const a = await focused(page);
    ok(a.role === "treeitem", `${tag}: ↓ moves in the tree`, JSON.stringify(a));
    ok((await page.locator('[role="treeitem"][tabindex="0"]').count()) === 1, `${tag}: the tree has one tab stop`);
    await noOverflow(page, tag);
  }
  ok(!errors.length, "code 1280px: no page errors", errors.join(" | "));
  await ctx.close();
}

/* ───────────── D. code view on a phone ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(375, 760);
  await page.goto(`${BASE}/code?project=shop`, { waitUntil: "networkidle" });
  if (await page.locator(".cv").count()) {
    const tag = "code 375px";
    await page.getByRole("tree").waitFor();
    ok(!(await page.locator(".cv-main").isVisible()), `${tag}: the files fill the screen first`);
    await noOverflow(page, `${tag} files`);
    await page.getByRole("treeitem", { name: /^README\.md/ }).click();
    await page.waitForURL(/\/code\/main\/README\.md/);
    await page.locator(".cv-line").first().waitFor();
    ok(!(await page.locator(".cv-tree").isVisible()), `${tag}: a file fills the screen`);
    const box = await page.locator(".cv-tool").first().boundingBox();
    ok(box && box.height >= 44, `${tag}: touch targets are 44 px high`, JSON.stringify(box));
    await noOverflow(page, `${tag} file`);
    await page.getByRole("button", { name: "Show the files" }).click();
    ok(await page.locator(".cv-tree").isVisible(), `${tag}: Files shows the tree again`);
    await page.goto(`${BASE}/code/main/src/cart.js?project=shop`, { waitUntil: "networkidle" });
    await page.locator(".cv-line").first().waitFor();
    await noOverflow(page, `${tag} cart.js`);
    await page.locator('[aria-label="Show the code or the changes (d)"], .cv-refbtn').first().click();
    const sheet = page.getByRole("dialog");
    await sheet.first().waitFor();
    const sb = await sheet.first().boundingBox();
    ok(sb && sb.x >= 0 && sb.x + sb.width <= 375 + 1, `${tag}: the ref picker fits the screen`, JSON.stringify(sb));
    await page.keyboard.press("Escape");
  }
  ok(!errors.length, "code 375px: no page errors", errors.join(" | "));
  await ctx.close();
}

/* ───────────── E. overview on a phone ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(375, 760);
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".c-svg--world").first().waitFor();
  await noOverflow(page, "overview 375px");
  ok(!errors.length, "overview 375px: no page errors", errors.join(" | "));
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
