// Browser checks for projects, the new-project picker, settings and connect, against test/web/mock-api.mjs.
//
//   npx vite build --config vite.ui.config.ts
//   node test/web/mock-api.mjs 5199 tmp/ui-build &
//   node test/web/onboarding-flow.mjs            # BASE=http://127.0.0.1:5199
//
// Each check prints ✓ or ✗; any ✗ sets the exit code to 1.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:5199";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
let failed = 0;
const errors = [];

function check(ok, msg, detail) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}${detail !== undefined ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
  }
}
const step = (s) => console.log(`\n▸ ${s}`);
/** innerText puts flex items on their own lines: compare text with single spaces. */
const textOf = async (loc) => (await loc.innerText()).replace(/\s+/g, " ").trim();
/** Wait up to `ms` for a locator to show; true when it does. */
const shows = (loc, ms = 4000) =>
  loc
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
const reset = () => fetch(`${BASE}/__mock/reset`, { method: "POST" });
const log = async () => (await fetch(`${BASE}/__mock/log`)).json();
const count = (entries, method, re) => entries.filter((e) => e.method === method && re.test(e.path)).length;

async function open(scenario, { width = 1280, height = 860, theme = "day", reduced = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference" });
  await ctx.addCookies([{ name: "mock", value: scenario, url: BASE }]);
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("gitring.theme", t);
    } catch {
      /* no storage */
    }
  }, theme);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${scenario}] ${e.message} at ${page.url()}\n${(e.stack ?? "").split("\n").slice(0, 4).join("\n")}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`[${scenario}] ${m.text()}`);
  });
  return { ctx, page };
}

const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a ? { tag: a.tagName.toLowerCase(), role: a.getAttribute("role"), name: a.getAttribute("aria-label") ?? a.textContent?.trim().slice(0, 60), value: a.value ?? null } : null;
});
const noOverflow = (page) => page.evaluate(() => {
  const main = document.getElementById("main");
  return document.documentElement.scrollWidth <= document.documentElement.clientWidth && (!main || main.scrollWidth <= main.clientWidth + 1);
});

/* ───────────── colors: WCAG contrast from computed styles ───────────── */
const contrastOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const parse = (s) => {
      s = s.trim();
      let m = /^rgba?\(([^)]+)\)$/.exec(s);
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p[3] ?? 1 };
      }
      m = /^oklch\(([^)]+)\)$/.exec(s);
      const lin2srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
      const fromOklab = (L, A, B, alpha) => {
        const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
        const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
        const s_ = L - 0.0894841775 * A - 1.291485548 * B;
        const l = l_ ** 3, mm = m_ ** 3, ss = s_ ** 3;
        const clamp = (x) => Math.min(1, Math.max(0, x));
        return {
          r: clamp(lin2srgb(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss)),
          g: clamp(lin2srgb(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss)),
          b: clamp(lin2srgb(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss)),
          a: alpha,
        };
      };
      if (m) {
        const [main, alpha] = m[1].split("/");
        const p = main.trim().split(/\s+/);
        const L = p[0].endsWith("%") ? parseFloat(p[0]) / 100 : parseFloat(p[0]);
        const C = parseFloat(p[1]);
        const H = (parseFloat(p[2]) || 0) * (Math.PI / 180);
        return fromOklab(L, C * Math.cos(H), C * Math.sin(H), alpha ? parseFloat(alpha) : 1);
      }
      m = /^oklab\(([^)]+)\)$/.exec(s);
      if (m) {
        const [main, alpha] = m[1].split("/");
        const p = main.trim().split(/\s+/).map(parseFloat);
        return fromOklab(p[0], p[1], p[2], alpha ? parseFloat(alpha) : 1);
      }
      m = /^color\(srgb ([^)]+)\)$/.exec(s);
      if (m) {
        const [main, alpha] = m[1].split("/");
        const p = main.trim().split(/\s+/).map(parseFloat);
        return { r: p[0], g: p[1], b: p[2], a: alpha ? parseFloat(alpha) : 1 };
      }
      return { r: 0, g: 0, b: 0, a: 0 };
    };
    const over = (top, below) => ({ r: top.r * top.a + below.r * (1 - top.a), g: top.g * top.a + below.g * (1 - top.a), b: top.b * top.a + below.b * (1 - top.a), a: 1 });
    const layers = [];
    for (let n = el; n; n = n.parentElement) layers.push(parse(getComputedStyle(n).backgroundColor));
    let bg = { r: 1, g: 1, b: 1, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i].a > 0) bg = over(layers[i], bg);
    const fg = over(parse(getComputedStyle(el).color), bg);
    const lum = (c) => {
      const f = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
  }, selector);

/* ═════════════ A. projects + picker, keyboard and requests ═════════════ */
step("A. Projects page and the picker (GitHub connected, 1280 px)");
{
  await reset();
  const { ctx, page } = await open("github");
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Your projects/ }).waitFor();
  let l = await log();
  check(count(l, "GET", /^\/api\/projects$/) === 1, "the project list loads once (boot only)", count(l, "GET", /^\/api\/projects$/));
  check((await page.locator("body").innerText()).toLowerCase().includes("sample") === false, "no sample text on the page");

  const trigger = page.getByRole("button", { name: "New project" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.waitFor();
  await page.waitForTimeout(250);
  check((await trigger.getAttribute("aria-expanded")) === "true", "the trigger says aria-expanded=true");
  check((await trigger.getAttribute("aria-controls")) === (await dialog.getAttribute("id")), "aria-controls points at the panel");
  let a = await active(page);
  check(a?.role === "combobox", "focus moves into the combobox", a);

  const geo = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("New project")).getBoundingClientRect();
    const t = document.querySelector(".np-pop__tail").getBoundingClientRect();
    const p = document.querySelector(".np-pop").getBoundingClientRect();
    return { bx: b.left + b.width / 2, tx: t.left + t.width / 2, tTop: t.top, pTop: p.top, bBottom: b.bottom };
  });
  check(Math.abs(geo.bx - geo.tx) <= 2, "the tail points at the button", geo);
  check(geo.tTop < geo.pTop && geo.pTop > geo.bBottom, "the tail sits between the button and the panel", geo);

  await page.waitForSelector('[role="option"]:has-text("mirza/gitring")');
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector(".np-pop")).animationName);
  check(anim === "np-grow", "the panel grows from its tail", anim);
  check((await page.locator(".np-chip").count()) === 3, "account chips: All accounts, mirza, acme");

  await page.keyboard.type("gitr", { delay: 40 });
  await page.waitForTimeout(700);
  const first = page.locator('[role="option"]').first();
  check((await first.innerText()).includes("mirza/gitring"), "typing filters in memory: mirza/gitring is first");
  const ad = await page.getByRole("combobox").getAttribute("aria-activedescendant");
  check(ad === (await first.getAttribute("id")), "aria-activedescendant names the active row");
  l = await log();
  check(count(l, "GET", /^\/api\/github\/repos$/) === 1, "one repository request for the list", count(l, "GET", /^\/api\/github\/repos/));
  check(count(l, "GET", /^\/api\/github\/repos\?q=/) === 0, "no request per keystroke (the list is complete)");

  await page.keyboard.press("ArrowDown");
  check((await page.locator('[role="option"][aria-selected="true"]').innerText()).includes("mirza/gitring-web"), "ArrowDown moves to the next row");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check((await dialog.count()) === 0, "Escape closes the panel");
  a = await active(page);
  check(a?.name?.includes("New project"), "focus returns to the trigger", a);
  check((await trigger.getAttribute("aria-expanded")) === "false", "the trigger says aria-expanded=false");

  await trigger.click();
  await dialog.waitFor();
  await page.waitForTimeout(200);
  check((await page.getByRole("combobox").inputValue()) === "gitr", "the draft stays after Escape");
  await page.mouse.click(40, 600);
  await page.waitForTimeout(150);
  check((await dialog.count()) === 0, "a click outside closes the panel");
  await page.keyboard.press("Shift+N");
  await dialog.waitFor();
  await page.waitForTimeout(200);
  check((await page.getByRole("combobox").inputValue()) === "gitr", "Shift+N opens it again with the draft");
  l = await log();
  check(count(l, "GET", /^\/api\/github\/repos/) === 1, "the reopened list comes from the cache", count(l, "GET", /^\/api\/github\/repos/));

  // Pick, check the guesses, create with Enter.
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: /mirza\/gitring/ }).waitFor();
  a = await active(page);
  check(a?.tag === "input" && a.value === "gitring", "the name field has focus with the guessed name", a);
  await page.waitForSelector('input[value="npm ci"]');
  check((await page.locator('input[value="npm test"]').count()) === 1, "the test command comes from the guess");
  check((await page.getByRole("radio", { name: "Pull request" }).getAttribute("aria-checked")) === "true", "sync defaults to a pull request");
  check((await page.getByRole("radio", { name: "Private" }).getAttribute("aria-checked")) === "true", "a private repository makes a private project");
  check(await page.getByText("package-lock.json is in the repository").isVisible(), "each guess shows its reason");
  l = await log();
  check(count(l, "GET", /^\/api\/github\/guess/) === 1, "one guess request per pick");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/overview\?project=gitring-/, { timeout: 8000 });
  const id = new URL(page.url()).searchParams.get("project");
  const body = await (await fetch(`${BASE}/api/projects/${id}/__body`, { headers: { cookie: "mock=github" } })).json();
  check(body?.source?.kind === "github" && body.source.repo === "mirza/gitring" && body.source.branch === "main", "POST /api/projects sends the GitHub source", body?.source);
  check(body?.settings?.github?.mode === "pull-request" && body.settings.github.repo === "mirza/gitring" && body.settings.github.branch === "gitring", "…and the GitHub sync settings", body?.settings?.github);
  check(body?.settings?.checks?.runner === "container" && body.settings.checks.install === "npm ci" && body.settings.checks.test === "npm test", "…and the test commands", body?.settings?.checks);
  check(body?.visibility === "private", "…and the visibility");
  await page.getByText("gitring imports mirza/gitring from GitHub").waitFor({ timeout: 8000 });
  check(true, "the overview shows the import panel");
  l = await log();
  check(count(l, "GET", /^\/api\/projects$/) === 2, "creating sends no extra list request (the new page loads the list once)", count(l, "GET", /^\/api\/projects$/));
  await ctx.close();
}

/* ═════════════ B. pasted URLs ═════════════ */
step("B. Pasted URLs");
{
  await reset();
  const { ctx, page } = await open("github");
  await page.goto(`${BASE}/projects?new=1`, { waitUntil: "networkidle" });
  await page.getByRole("dialog", { name: "New project" }).waitFor();
  await page.waitForTimeout(200);
  await page.keyboard.insertText("https://gitlab.com/acme/tool");
  await page.waitForTimeout(150);
  check((await textOf(page.locator('[role="option"]').first())).includes("Import gitlab.com/acme/tool"), "a pasted URL puts an import row on top");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Import a public repository" }).waitFor();
  const a = await active(page);
  check(a?.value === "tool", "the name comes from the URL and has focus", a);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/overview\?project=tool-/, { timeout: 8000 });
  const id = new URL(page.url()).searchParams.get("project");
  const body = await (await fetch(`${BASE}/api/projects/${id}/__body`, { headers: { cookie: "mock=github" } })).json();
  check(body?.source?.kind === "git" && body.source.url === "https://gitlab.com/acme/tool", "click, paste, Enter, Enter creates a git project", body?.source);
  check(body?.visibility === "public", "a public URL makes a public project (same as the repository)");

  await page.goto(`${BASE}/projects?new=1`, { waitUntil: "networkidle" });
  await page.getByRole("dialog", { name: "New project" }).waitFor();
  await page.waitForTimeout(200);
  await page.keyboard.insertText("github.com/vercel/next.js");
  await page.waitForTimeout(150);
  check((await textOf(page.locator('[role="option"]').first())).includes("Import github.com/vercel/next.js"), "a GitHub URL outside the list gets an import row");
  await page.keyboard.press("Enter");
  await page.waitForSelector('input[value="canary"]');
  check(await page.getByText("Stays in gitring.", { exact: true }).isVisible(), "without push rights, sync stays off");
  check(await page.getByText("You cannot push to this repository, so merged code stays in gitring.").isVisible(), "…and says why");

  await page.getByRole("button", { name: "All sources" }).click();
  await page.waitForTimeout(150);
  await page.getByRole("combobox").fill("http://gitlab.com/x/y");
  check(await page.getByRole("note").getByText("gitring imports https URLs only.").isVisible(), "an http URL gets a plain reason");
  await ctx.close();
}

/* ═════════════ B2. a link opens the picker at a repository ═════════════ */
step("B2. A link to one repository (?new=1&repo=owner/name)");
{
  await reset();
  const { ctx, page } = await open("github");
  await page.goto(`${BASE}/projects?new=1&repo=mirza%2Fml-notes`, { waitUntil: "networkidle" });
  await page.waitForSelector('input[value="pytest"]');
  const a = await active(page);
  check(a?.tag === "input" && a.value === "ml-notes", "the name field has focus when the panel opens at a step", a);
  const sel = await page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement ? [el.selectionStart, el.selectionEnd, el.value.length] : null;
  });
  check(sel && sel[0] === 0 && sel[1] === sel[2], "the guessed name is selected, so typing replaces it", sel);
  check((await page.locator('input[value="trunk"]').count()) === 1, "the branch is the default branch of the repository");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/overview\?project=ml-notes-/, { timeout: 8000 });
  check(true, "Enter creates the project");
  await ctx.close();
}

/* ═════════════ B3. upload a folder, push with git, empty project ═════════════ */
step("B3. Upload a folder, push with git, empty project");
{
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "np-upload-"));
  const dir = path.join(root, "my-site");
  for (const [f, text] of [
    ["README.md", "# My site\n"],
    ["src/index.js", "export default {};\n"],
    ["node_modules/x/index.js", "module.exports = 1;\n"],
    [".git/config", "[core]\n"],
  ]) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await writeFile(path.join(dir, f), text);
  }
  await reset();
  const { ctx, page } = await open("github");
  await page.goto(`${BASE}/projects?new=1`, { waitUntil: "networkidle" });
  await page.waitForSelector('[role="option"]:has-text("mirza/gitring")');
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("option", { name: /Upload a folder/ }).click();
  await (await chooser).setFiles(dir);
  await page.getByRole("heading", { name: "Upload a folder" }).waitFor();
  check(await shows(page.getByText(/2 files, 1 KB\. 2 files stay out/)), "the folder summary counts kept and skipped files");
  const a = await active(page);
  check(a?.value === "my-site", "the name comes from the folder and has focus", a);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/overview\?project=my-site-/, { timeout: 8000 });
  let id = new URL(page.url()).searchParams.get("project");
  let body = await (await fetch(`${BASE}/api/projects/${id}/__body`, { headers: { cookie: "mock=github" } })).json();
  const paths = (body?.files ?? []).map((f) => f.path).sort();
  check(body?.source?.kind === "upload" && JSON.stringify(paths) === JSON.stringify(["README.md", "src/index.js"]), "the upload sends the kept files only", paths);
  check(body?.visibility === "private", "an upload is private by default");

  await page.goto(`${BASE}/projects?new=1`, { waitUntil: "networkidle" });
  await page.waitForSelector('[role="option"]:has-text("mirza/gitring")');
  await page.getByRole("option", { name: /Push with git/ }).click();
  await page.getByRole("heading", { name: "Push with git" }).waitFor();
  await page.keyboard.type("Shop");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/overview\?project=shop-/, { timeout: 8000 });
  id = new URL(page.url()).searchParams.get("project");
  body = await (await fetch(`${BASE}/api/projects/${id}/__body`, { headers: { cookie: "mock=github" } })).json();
  check(body?.source?.kind === "push" && body.name === "Shop", "typing replaces the default name; push creates a push project", body);
  await page.getByRole("heading", { name: "Push your repository" }).waitFor();
  await page.getByRole("button", { name: "Show the push command" }).click();
  check(await shows(page.getByText(/git push https:\/\/x:tok_123@artifacts\.example/)), "the overview shows the push command");

  await page.goto(`${BASE}/projects?new=empty`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Empty project" }).waitFor();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/overview\?project=new-project-/, { timeout: 8000 });
  check(await shows(page.getByRole("heading", { name: "Main has no files yet" })), "an empty project asks for the first task");
  await ctx.close();
}

/* ═════════════ C. errors keep the draft and show the next step ═════════════ */
step("C. Errors");
{
  await reset();
  const { ctx, page } = await open("github");
  await page.goto(`${BASE}/projects?new=1&repo=acme%2Flocked`, { waitUntil: "networkidle" });
  await page.getByText("An owner of acme must approve the GitHub app.").waitFor();
  check(await page.getByRole("link", { name: /Install the GitHub App/ }).isVisible(), "a 403 guess offers the GitHub App install");
  check(await page.getByRole("button", { name: "Import it by its URL" }).isVisible(), "…and the URL import");

  await page.getByRole("button", { name: "All sources" }).click();
  await page.getByRole("combobox").fill("payments");
  await page.keyboard.press("Enter");
  await page.waitForSelector('input[value="npm ci"]');
  await page.keyboard.press("Enter");
  await page.getByText(/The project was not created\. An owner of acme must approve/).waitFor();
  check(true, "a refused creation shows the reason in place");
  check((await page.getByRole("dialog", { name: "New project" }).count()) === 1, "the panel stays open with the choices");

  await page.getByRole("button", { name: "All sources" }).click();
  await page.getByRole("combobox").fill("broken");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Try again" }).waitFor();
  check(await page.getByText("GitHub did not answer. Try again.").isVisible(), "a failed guess shows the server sentence and Try again");
  await ctx.close();
}

/* ═════════════ D. no GitHub connection: Connect GitHub comes back filled ═════════════ */
step("D. Google sign-in without GitHub");
{
  await reset();
  const { ctx, page } = await open("google");
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("dialog", { name: "New project" }).waitFor();
  await page.waitForTimeout(200);
  check((await textOf(page.locator('[role="option"]').first())).includes("Connect GitHub"), "the first row is Connect GitHub");
  let l = await log();
  check(count(l, "GET", /^\/api\/github\/repos/) === 0, "no repository request without a connection");
  await page.keyboard.type("next");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  // Back to the first row (Connect GitHub), then Enter.
  for (let i = 0; i < 6 && !(await textOf(page.locator('[role="option"][aria-selected="true"]'))).includes("Connect GitHub"); i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/projects\?new=1&q=next/, { timeout: 8000 });
  l = await log();
  check(l.some((e) => /^\/auth\/github\/start\?link=1&return=%2Fprojects%3Fnew%3D1%26q%3Dnext$/.test(e.path)), "Connect GitHub goes to GitHub and back with the text", l.filter((e) => e.path.startsWith("/auth")).map((e) => e.path));
  await page.getByRole("dialog", { name: "New project" }).waitFor();
  await page.waitForTimeout(600);
  check((await page.getByRole("combobox").inputValue()) === "next", "the picker opens again, filled");
  await ctx.close();
}

/* ═════════════ E. signed out and no providers ═════════════ */
step("E. Signed out");
{
  await reset();
  const { ctx, page } = await open("signedout");
  await ctx.addCookies([{ name: "gitring_last", value: "google", url: BASE }]);
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New project" }).click();
  const gh = page.getByRole("link", { name: /Continue with GitHub/ });
  await gh.waitFor();
  check((await gh.getAttribute("href")) === "/auth/github/start?return=%2Fprojects%3Fnew%3D1", "Continue with GitHub returns to the picker");
  const links = await page.locator(".np-provider").allInnerTexts();
  check(links[0].includes("Google") && links[0].includes("Last used"), "the last-used provider comes first", links);
  check((await page.locator(".np-provider svg path[fill='#4285F4']").count()) === 1, "the Google mark keeps its colors");
  await ctx.close();
  const b = await open("noprov");
  await b.page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await b.page.getByRole("button", { name: "New project" }).click();
  check(await b.page.getByText("Sign-in is not set up on this server yet.").isVisible(), "no providers: a plain sentence");
  await b.ctx.close();
}

/* ═════════════ F. first project: the picker on the page ═════════════ */
step("F. A person without projects");
{
  await reset();
  const { ctx, page } = await open("fresh");
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Start your first project" }).waitFor();
  check((await page.getByRole("button", { name: "New project" }).count()) === 0, "no extra button: the picker is on the page");
  let a = await active(page);
  check(a?.role !== "combobox", "the page does not steal focus on load", a);
  await page.keyboard.press("Shift+N");
  a = await active(page);
  check(a?.role === "combobox", "Shift+N focuses the picker", a);
  await page.waitForSelector('[role="option"]:has-text("mirza/gitring")');
  check(true, "the repositories show at once");
  await ctx.close();
}

/* ═════════════ G. phones: a sheet under the button, no horizontal scroll ═════════════ */
step("G. 375 px");
for (const theme of ["day", "night"]) {
  await reset();
  const { ctx, page } = await open("github", { width: 375, height: 760, theme });
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  check(await noOverflow(page), `[${theme}] no horizontal overflow on the page`);
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("dialog", { name: "New project" }).waitFor();
  await page.waitForTimeout(300);
  const box = await page.locator(".np-pop").boundingBox();
  check(Math.abs(box.x - 8) <= 1 && Math.abs(box.width - 359) <= 1, `[${theme}] the panel is a full-width sheet`, box);
  check(await noOverflow(page), `[${theme}] no horizontal overflow with the sheet open`);
  const h = await page.locator(".np-opt").first().evaluate((el) => el.getBoundingClientRect().height);
  check(h >= 44, `[${theme}] rows are at least 44 px high`, h);
  await page.keyboard.type("gitring");
  await page.keyboard.press("Enter");
  await page.waitForSelector('input[value="npm ci"]');
  check(await noOverflow(page), `[${theme}] the guess step fits`);
  const fs = await page.locator(".np-in").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  check(fs >= 16, `[${theme}] fields use 16 px text (no zoom on focus)`, fs);
  await ctx.close();
}

/* ═════════════ H. settings ═════════════ */
step("H. Settings");
{
  await reset();
  const { ctx, page } = await open("github");
  await page.goto(`${BASE}/settings?project=gitring-web-ab12`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
  await page.waitForTimeout(400);
  let l = await log();
  check(count(l, "GET", /\/api\/projects\/gitring-web-ab12\/github$/) === 0, "the sync status comes from the live state (no extra request)");
  check(await page.getByText("GitHub has main. The pull request is open.").isVisible(), "the status shows");
  check((await page.locator("body").innerText()).toLowerCase().includes("sample") === false, "no sample text");
  const repo = page.getByRole("combobox", { name: "Repository" });
  check((await repo.inputValue()) === "mirza/gitring-web", "the repository field shows the linked repository");
  await repo.click();
  await repo.fill("pay");
  await page.waitForSelector('[role="option"]:has-text("acme/payments")');
  check((await repo.getAttribute("aria-expanded")) === "true", "the list opens under the field");
  await page.keyboard.press("Enter");
  check((await repo.inputValue()) === "acme/payments", "Enter picks the repository");
  check(await shows(page.getByText("you cannot push", { exact: true })), "the field says that the person cannot push");
  check(await shows(page.getByText(/You cannot push to acme\/payments/)), "a warning names the problem before the save");
  await page.getByRole("button", { name: "Save GitHub settings" }).click();
  await page.getByRole("alert").filter({ hasText: "A person who can push must link it." }).waitFor();
  check(true, "the refused save shows the server reason");
  await repo.fill("mirza/gitring-web");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");

  await page.getByRole("button", { name: "Send to GitHub now" }).click();
  await page.getByText("GitHub has main now. The pull request is up to date.").first().waitFor();
  check(true, "Send to GitHub now updates the status");
  await page.getByRole("button", { name: "Bring GitHub changes in now" }).click();
  await page.getByText("GitHub had 2 new commits. gitring merged them into main.").first().waitFor();
  check(true, "Bring GitHub changes in now updates the status");
  await fetch(`${BASE}/__mock/github-event`, { method: "POST" });
  await page.getByText("Live: GitHub has main now.").first().waitFor({ timeout: 4000 });
  check(true, "a live event updates the status (WebSocket)");

  const remove = page.getByRole("button", { name: "Remove Lin Example" });
  await remove.click();
  let a = await active(page);
  check(a?.name === "Keep", "the inline confirm focuses Keep", a);
  check(await page.getByText("Remove Lin Example? They lose access at once.").isVisible(), "the question says what happens");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  a = await active(page);
  check(a?.name === "Remove Lin Example", "Escape returns focus to the button", a);
  await remove.click();
  await page.getByRole("group", { name: /Remove Lin Example\?/ }).getByRole("button", { name: "Remove" }).click();
  await page.waitForTimeout(400);
  check((await page.getByText("lin@example.com").count()) === 0, "the member goes away");

  check((await page.locator("dialog[open]").count()) === 0, "no modal dialog in settings");
  await page.getByRole("button", { name: "Archive project" }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.waitForURL(/\/projects$/, { timeout: 8000 });
  l = await log();
  check(count(l, "DELETE", /\/api\/projects\/gitring-web-ab12$/) === 1, "Archive asks in place, then archives");
  await ctx.close();
}

/* ═════════════ I. connect ═════════════ */
step("I. Connect");
{
  await reset();
  const { ctx, page } = await open("github");
  await page.goto(`${BASE}/connect?project=gitring-web-ab12`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Add gitring as a connector" }).waitFor();
  check((await page.getByLabel("MCP URL").inputValue()) === `${BASE}/mcp`, "one MCP URL to copy");
  check(await shows(page.getByText("Add custom connector")), "Claude steps show first");
  const agents = page.getByRole("tablist", { name: "Your agent" });
  await agents.getByRole("tab", { name: "Claude Code" }).click();
  check(await shows(page.getByText(`claude mcp add --transport http --scope user gitring ${BASE}/mcp`)), "the Claude Code command uses OAuth (no key)");
  await agents.getByRole("tab", { name: "Cursor" }).click();
  const href = await page.getByRole("link", { name: "Add to Cursor" }).getAttribute("href");
  const cfg = JSON.parse(Buffer.from(decodeURIComponent(href.split("config=")[1]), "base64").toString("utf8"));
  check(href.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=gitring&config=") && cfg.url === `${BASE}/mcp`, "Add to Cursor carries the URL", cfg);
  await agents.getByRole("tab", { name: "Codex" }).click();
  check(await shows(page.getByText("codex mcp login gitring")), "the Codex commands include the sign-in");
  await agents.getByRole("tab", { name: "Codex" }).press("ArrowRight");
  check((await agents.getByRole("tab", { name: "Other" }).getAttribute("aria-selected")) === "true", "arrow keys move between the agent tabs");
  await agents.getByRole("tab", { name: "Other" }).press("ArrowLeft");
  check(await shows(page.getByText(/Claude Code\s*worked on this project/)), "agents that work here show from the live state");
  await page.waitForTimeout(600);
  let l = await log();
  const before = count(l, "GET", /^\/api\/oauth\/grants$/);
  check(before >= 1, "the page asks for connected apps", before);
  await fetch(`${BASE}/__mock/grant`, { method: "POST" });
  await page.getByText(/Claude Code\s*is connected/).waitFor({ timeout: 8000 });
  check(true, "the live line turns to “Claude Code is connected”");
  l = await log();
  const after = count(l, "GET", /^\/api\/oauth\/grants$/);
  await page.waitForTimeout(11_000);
  l = await log();
  check(count(l, "GET", /^\/api\/oauth\/grants$/) === after, "polling stops once an app is connected", { after, now: count(l, "GET", /^\/api\/oauth\/grants$/) });

  await page.getByRole("button", { name: "Create key" }).click();
  await page.getByText("export GITRING_KEY=gk_live_ab12cd34ef56gh78").waitFor();
  check(true, "an API key is created in place and shown once");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Add gitring as a connector" }).waitFor();
  check((await page.getByRole("tablist", { name: "Your agent" }).getByRole("tab", { name: "Codex" }).getAttribute("aria-selected")) === "true", "the chosen agent is remembered");
  check((await page.locator("body").innerText()).toLowerCase().includes("sample") === false, "no sample text");
  await ctx.close();

  const so = await open("signedout");
  await so.page.goto(`${BASE}/connect?project=react-ef56`, { waitUntil: "networkidle" });
  await so.page.getByText("Sign in first. Your agent then signs in as you.").waitFor();
  l = await log();
  check(count(l, "GET", /^\/api\/oauth\/grants$/) === count(await log(), "GET", /^\/api\/oauth\/grants$/), "signed out: no polling");
  await so.ctx.close();
}

/* ═════════════ J. contrast and motion in three themes ═════════════ */
step("J. Contrast (WCAG AA) and reduced motion");
for (const theme of ["day", "dusk", "night"]) {
  await reset();
  const { ctx, page } = await open("github", { theme, reduced: theme === "night" });
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New project" }).click();
  await page.waitForSelector('[role="option"]:has-text("mirza/gitring")');
  for (const [sel, min] of [
    [".np-opt.is-active .np-opt__text", 4.5],
    [".np-opt:not(.is-active) .np-opt__text", 4.5],
    [".np-group__head", 4.5],
    [".np-tag", 4.5],
    [".np-dock__hint", 4.5],
    [".np-search__input", 4.5],
    [".pj-card__meta", 4.5],
  ]) {
    const c = await contrastOf(page, sel);
    check(c !== null && c >= min, `[${theme}] ${sel} ≥ ${min}:1`, c);
  }
  if (theme === "night") {
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector(".np-pop")).animationName);
    check(anim === "b-fade-in", "[night, reduced motion] the panel only fades", anim);
  }
  await page.keyboard.type("gitring");
  await page.keyboard.press("Enter");
  await page.waitForSelector('input[value="npm ci"]');
  for (const sel of [".np-row__hint", ".np-row__label", ".np-back"]) {
    const c = await contrastOf(page, sel);
    check(c !== null && c >= 4.5, `[${theme}] ${sel} ≥ 4.5:1`, c);
  }
  await page.goto(`${BASE}/connect?project=gitring-web-ab12`, { waitUntil: "networkidle" });
  for (const sel of [".cx-live__text", ".cx__note", ".cx-hero__text p"]) {
    const c = await contrastOf(page, sel);
    check(c !== null && c >= 4.5, `[${theme}] ${sel} ≥ 4.5:1`, c);
  }
  await page.goto(`${BASE}/settings?project=gitring-web-ab12`, { waitUntil: "networkidle" });
  for (const sel of [".st-repo__info", ".st-toc a", ".np__help"]) {
    const c = await contrastOf(page, sel);
    check(c !== null && c >= 4.5, `[${theme}] ${sel} ≥ 4.5:1`, c);
  }
  await ctx.close();
}

console.log(errors.length ? `\nPage errors:\n${errors.join("\n")}` : "\nNo page errors.");
if (errors.length) failed++;
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
await browser.close();
process.exit(failed ? 1 : 0);
