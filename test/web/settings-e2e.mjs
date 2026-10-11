// Browser checks for the approvals part of Settings and Connect, against test/web/mock-api.mjs:
//   the radio groups "When does a person say yes?" and "Who says yes?" (what they show, what a save sends,
//   read only for a member, the keyboard), the `approval` webhook event, the two extra MCP addresses and the
//   merge question under the connector, the flow words, and the layout at 1280 and 375 px in Day, Dusk and Night.
//
//   npx vite build --config vite.ui.config.ts
//   node test/web/mock-api.mjs 5199 tmp/ui-build &
//   node test/web/settings-e2e.mjs               # BASE=http://127.0.0.1:5199
//
// Each check prints ✓ or ✗; any ✗ sets the exit code to 1.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:5199";
const OWNED = "gitring-web-ab12"; // the signed-in person is an owner
const MEMBER = "notes-cd34"; // the signed-in person is a member
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Wait up to `ms` for a locator to show; true when it does. */
const shows = (loc, ms = 4000) =>
  loc
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
const reset = () => fetch(`${BASE}/__mock/reset`, { method: "POST" });
const settingsOf = async (project = OWNED) => (await fetch(`${BASE}/api/projects/${project}/settings`)).json();
/** Replace the stored settings as they are (for example a server from before `landing`). */
const putRaw = (project, settings) => fetch(`${BASE}/__mock/settings`, { method: "POST", body: JSON.stringify({ project, settings }) });

async function open(scenario, { width = 1280, height = 860, theme = "day", clipboard = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: "no-preference" });
  await ctx.addCookies([{ name: "mock", value: scenario, url: BASE }]);
  if (clipboard) await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
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

const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a ? { tag: a.tagName.toLowerCase(), id: a.id || null, type: a.type ?? null, value: a.value ?? null, text: a.textContent?.trim().slice(0, 60) ?? "" } : null;
  });
const noOverflow = (page) =>
  page.evaluate(() => {
    const main = document.getElementById("main");
    return document.documentElement.scrollWidth <= document.documentElement.clientWidth && (!main || main.scrollWidth <= main.clientWidth + 1);
  });
/** Elements of these parts of the page that reach past the right edge of the window. */
const spill = (page, roots) =>
  page.evaluate((sels) => {
    const out = [];
    for (const sel of sels) {
      for (const root of document.querySelectorAll(sel)) {
        for (const el of [root, ...root.querySelectorAll("*")]) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > window.innerWidth + 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}`);
        }
      }
    }
    return out.slice(0, 5);
  }, roots);

/* The radios of a group: which is checked, what each is called, and the help that each one points at. */
const states = (group) => group.getByRole("radio").evaluateAll((els) => els.map((e) => e.checked));
const names = (group) => group.getByRole("radio").evaluateAll((els) => els.map((e) => document.getElementById(e.getAttribute("aria-labelledby")).firstChild.textContent.trim()));
const helps = (group) => group.getByRole("radio").evaluateAll((els) => els.map((e) => document.getElementById(e.getAttribute("aria-describedby"))?.textContent ?? ""));
/** A radio in a disabled fieldset is :disabled, but its `disabled` property stays false. */
const allDisabled = (group) => group.getByRole("radio").evaluateAll((els) => els.length > 0 && els.every((e) => e.matches(":disabled")));
const isPut = (r) => r.method() === "PUT" && /\/settings$/.test(new URL(r.url()).pathname);

const LANDING = ["Only when the tests pass", "When a change looks risky", "Before every merge"];
const APPROVER = ["The person who sent the agent (owners can always answer)", "Only owners"];

/** The Settings page of a project; resolves when the two groups show. */
async function settingsPage(page, project = OWNED) {
  await page.goto(`${BASE}/settings?project=${project}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Merging", exact: true }).waitFor();
  const when = page.getByRole("radiogroup", { name: "When does a person say yes?" });
  const who = page.getByRole("radiogroup", { name: "Who says yes?" });
  await when.waitFor();
  await page.waitForTimeout(400); // the full settings come from the server
  return { when, who, save: page.getByRole("button", { name: "Save merge settings" }) };
}

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

/* ═════════════ A. the radio groups show the saved choice ═════════════ */
step("A. Settings: the radio groups show the saved choice (owner, 1280 px)");
{
  await reset();
  const { ctx, page } = await open("github");
  const { when, who, save } = await settingsPage(page);

  check(same(await names(when), LANDING), "“When does a person say yes?” has three choices, in this order", await names(when));
  check(same(await states(when), [false, true, false]), "a new project shows “When a change looks risky”", await states(when));
  check((await when.getByText("Recommended", { exact: true }).count()) === 1 && (await when.locator("label", { hasText: "When a change looks risky" }).getByText("Recommended").isVisible()), "“Recommended” marks the risky choice only");
  const help = await helps(when);
  check(help.every((h) => h.length > 0), "each radio points at its own help text (aria-describedby)", help.map((h) => h.length));
  check(/parameters of a function change/.test(help[1]) && /build or deploy files change/.test(help[1]) && /files are deleted/.test(help[1]), "the risky help names the signs that make a change risky", help[1]);
  check(/15 files/.test(help[1]) && /600 changed lines/.test(help[1]), "…and the size of a large change", help[1]);
  check(/New projects start with this choice\./.test(help[1]), "…and says that it is the default of a new project");
  check(/no test ran/.test(help[0]) && /work copies compete/.test(help[0]), "the first help says that a person still decides when no test ran or work copies compete", help[0]);
  check(help[2] === "A person says yes to every merge.", "the third help is one plain sentence", help[2]);
  check((await page.getByText("Merge by itself when the tests pass").count()) === 0, "the old checkbox “Merge by itself when the tests pass” is gone");
  check((await page.getByLabel("Merge by itself").count()) === 0, "no control is left with the old label");

  check(same(await names(who), APPROVER), "“Who says yes?” has two choices", await names(who));
  check(same(await states(who), [true, false]), "…and shows “The person who sent the agent” by default", await states(who));
  const helpWho = await helps(who);
  check(helpWho.every((h) => h.length > 0), "…each with a help text", helpWho);
  check(!(await allDisabled(when)) && !(await allDisabled(who)), "an owner can change both groups");
  check(await save.isDisabled(), "Save merge settings waits for a change");
  check((await page.getByRole("button", { name: "Save merge settings" }).count()) === 1, "there is one Save button for the section");
  const tag = await when.evaluate((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), labelled: Boolean(el.getAttribute("aria-labelledby")) }));
  check(tag.tag === "fieldset" && tag.role === "radiogroup" && tag.labelled, "the group is a fieldset with a legend", tag);
  await ctx.close();
}

/* ═════════════ B. a change and a save ═════════════ */
step("B. Settings: a save sends `landing` and never `autoLand`");
{
  await reset();
  const { ctx, page } = await open("github");
  const { when, who, save } = await settingsPage(page);

  await when.getByRole("radio", { name: "Before every merge" }).check();
  check(same(await states(when), [false, false, true]), "picking “Before every merge” selects it only", await states(when));
  check(await save.isEnabled(), "a change turns Save merge settings on");
  let sent = page.waitForRequest(isPut);
  await save.click();
  let body = (await sent).postDataJSON();
  check(body.landing === "ask", "the request sends landing: ask", body);
  check(!("autoLand" in body), "…and has no autoLand", Object.keys(body));
  check(body.approver === "sender", "…and the approver", body.approver);
  check(await shows(page.getByText("Merge settings saved")), "the toast says “Merge settings saved”");
  let s = await settingsOf();
  check(s.landing === "ask" && s.approver === "sender" && s.autoLand === false, "the server has landing ask, and autoLand false", { landing: s.landing, autoLand: s.autoLand });
  check(await save.isDisabled(), "Save is off again after the save");

  await when.getByRole("radio", { name: "Only when the tests pass" }).check();
  sent = page.waitForRequest(isPut);
  await save.click();
  body = (await sent).postDataJSON();
  check(body.landing === "automatic" && !("autoLand" in body), "“Only when the tests pass” sends landing: automatic", body);
  await page.getByText("Merge settings saved").first().waitFor();
  s = await settingsOf();
  check(s.landing === "automatic" && s.autoLand === true, "…and the server keeps autoLand equal to it (true)", { landing: s.landing, autoLand: s.autoLand });

  await when.getByRole("radio", { name: /When a change looks risky/ }).check();
  sent = page.waitForRequest(isPut);
  await save.click();
  body = (await sent).postDataJSON();
  check(body.landing === "risky" && !("autoLand" in body), "“When a change looks risky” sends landing: risky", body);
  await page.waitForTimeout(300);
  s = await settingsOf();
  check(s.landing === "risky" && s.autoLand === false, "…and autoLand is false again", { landing: s.landing, autoLand: s.autoLand });

  // The whole card is a click target: the help text and the name too.
  await when.locator(".st-choice__help").nth(2).click();
  check(same(await states(when), [false, false, true]), "a click on the help text of a choice selects it", await states(when));
  await when.getByText(/^When a change looks risky/).click();
  check(same(await states(when), [false, true, false]), "a click on the name of a choice selects it", await states(when));
  await when.locator(".st-choice__opt").nth(0).click({ position: { x: 600, y: 8 } });
  check(same(await states(when), [true, false, false]), "a click on the empty part of the card selects it", await states(when));
  await when.getByRole("radio", { name: /When a change looks risky/ }).check();
  check(await save.isDisabled(), "…and back to the saved value, Save is off (no false change)");

  // A reload shows what the server keeps.
  await when.getByRole("radio", { name: "Before every merge" }).check();
  await save.click();
  await page.getByText("Merge settings saved").first().waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await when.waitFor();
  await page.waitForTimeout(400);
  check(same(await states(when), [false, false, true]), "a reload shows the saved choice", await states(when));
  check(same(await states(who), [true, false]), "…and the saved approver", await states(who));
  await ctx.close();
}

/* ═════════════ C. settings from a server that has only autoLand ═════════════ */
step("C. Settings: a server from before `landing` (only autoLand)");
{
  await reset();
  const { ctx, page } = await open("github");
  const cur = await settingsOf();
  const { landing, approver, ...old } = cur;
  check(landing === "risky" && approver === "sender", "a new project has landing risky and approver sender (the defaults)", { landing, approver });

  await putRaw(OWNED, { ...old, autoLand: true });
  let { when, who, save } = await settingsPage(page);
  check(same(await states(when), [true, false, false]), "autoLand true shows “Only when the tests pass”", await states(when));
  check(same(await states(who), [true, false]), "no approver shows “The person who sent the agent”", await states(who));
  check(await save.isDisabled(), "…and the page is clean (no change to save)");

  await putRaw(OWNED, { ...old, autoLand: false });
  ({ when, who, save } = await settingsPage(page));
  check(same(await states(when), [false, false, true]), "autoLand false shows “Before every merge”", await states(when));

  await putRaw(OWNED, { ...old, autoLand: false, approver: "owner" });
  ({ when, who, save } = await settingsPage(page));
  check(same(await states(who), [false, true]), "approver owner shows “Only owners”", await states(who));

  await putRaw(OWNED, { ...old, landing: "ask", autoLand: true });
  ({ when, who, save } = await settingsPage(page));
  check(same(await states(when), [false, false, true]), "`landing` wins over `autoLand`", await states(when));

  const { autoLand, ...neither } = old;
  await putRaw(OWNED, neither);
  ({ when, who, save } = await settingsPage(page));
  check(same(await states(when), [false, true, false]), "with neither field, the default of a new project shows (risky)", await states(when));

  await putRaw(OWNED, { ...old, autoLand: true });
  ({ when, who, save } = await settingsPage(page));
  await when.getByRole("radio", { name: /When a change looks risky/ }).check();
  const sent = page.waitForRequest(isPut);
  await save.click();
  const body = (await sent).postDataJSON();
  check(body.landing === "risky" && body.approver === "sender" && !("autoLand" in body), "a save from an old server writes landing and approver, not autoLand", body);
  await page.getByText("Merge settings saved").first().waitFor();
  const s = await settingsOf();
  check(s.landing === "risky" && s.autoLand === false && s.approver === "sender", "…and the server answers with the new fields", { landing: s.landing, autoLand: s.autoLand, approver: s.approver });
  await ctx.close();
}

/* ═════════════ D. a member sees the values and cannot change them ═════════════ */
step("D. Settings: a member sees the choices and cannot change them");
{
  await reset();
  await putRaw(MEMBER, { ...(await settingsOf(MEMBER)), landing: "ask", approver: "owner" });
  const { ctx, page } = await open("github", { theme: "dusk" });
  const { when, who, save } = await settingsPage(page, MEMBER);
  check(await allDisabled(when), "every radio of “When does a person say yes?” is disabled");
  check(await allDisabled(who), "every radio of “Who says yes?” is disabled");
  check(same(await states(when), [false, false, true]) && same(await states(who), [false, true]), "…and they show the saved values (Before every merge, Only owners)", { when: await states(when), who: await states(who) });
  check((await save.count()) === 0, "there is no Save button for a member");
  check(await shows(page.getByText("Owners change these settings. You see the values.")), "the page says that owners change the settings");
  check(await when.evaluate((el) => el.disabled), "the fieldset is disabled");
  await when.getByRole("radio", { name: /When a change looks risky/ }).click({ force: true, timeout: 2000 }).catch(() => {});
  check(same(await states(when), [false, false, true]), "a click on a disabled radio changes nothing", await states(when));
  const l = await fetch(`${BASE}/__mock/log`).then((r) => r.json());
  check(l.filter((e) => e.method === "PUT" && /settings$/.test(e.path)).length === 0, "…and no request leaves the page");
  await ctx.close();
}

/* ═════════════ E. who says yes ═════════════ */
step("E. Settings: “Who says yes?”");
{
  await reset();
  const { ctx, page } = await open("github");
  const { when, who, save } = await settingsPage(page);
  await who.getByRole("radio", { name: "Only owners" }).check();
  check(same(await states(who), [false, true]), "picking “Only owners” selects it", await states(who));
  check(await save.isEnabled(), "…and turns Save on");
  let sent = page.waitForRequest(isPut);
  await save.click();
  let body = (await sent).postDataJSON();
  check(body.approver === "owner" && body.landing === "risky" && !("autoLand" in body), "the save sends approver owner with the unchanged landing", body);
  await page.getByText("Merge settings saved").first().waitFor();
  let s = await settingsOf();
  check(s.approver === "owner", "the server keeps approver owner", s.approver);
  await who.getByRole("radio", { name: /The person who sent the agent/ }).check();
  sent = page.waitForRequest(isPut);
  await save.click();
  body = (await sent).postDataJSON();
  check(body.approver === "sender", "back to “The person who sent the agent” sends approver sender", body.approver);
  await page.waitForTimeout(300);
  s = await settingsOf();
  check(s.approver === "sender", "the server keeps approver sender", s.approver);

  // Both groups in one save.
  await when.getByRole("radio", { name: "Before every merge" }).check();
  await who.getByRole("radio", { name: "Only owners" }).check();
  sent = page.waitForRequest(isPut);
  await save.click();
  body = (await sent).postDataJSON();
  check(body.landing === "ask" && body.approver === "owner", "one Save sends both choices", body);
  await ctx.close();
}

/* ═════════════ F. the webhook event `approval` ═════════════ */
step("F. Settings: the `approval` webhook event");
{
  await reset();
  const { ctx, page } = await open("github");
  await settingsPage(page);
  await page.getByRole("button", { name: "Add a webhook" }).click();
  const url = page.getByRole("textbox", { name: "Webhook 1: URL" });
  await url.fill("https://hooks.slack.com/services/T000/B000/xyz");
  const events = page.getByRole("group", { name: "Events" });
  const labels = await events.locator("label").allTextContents();
  check(same(labels.map((t) => t.trim()), ["A merge", "A change request", "A person decided", "A new task", "A person must say yes, or answered"]), "the events are a merge, a change request, a decision, a new task and the approval", labels);
  const approval = events.getByRole("checkbox", { name: "A person must say yes, or answered" });
  check(!(await approval.isChecked()), "a new webhook does not send approval events until the person picks it");
  const note = await approval.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby"))?.textContent ?? "");
  check(note === "A person must say yes, or answered. The message has the task, the change in one line, and the link where a person answers.", "the checkbox points at its help", note);
  check(await shows(page.getByText("The message has the task, the change in one line, and the link where a person answers.")), "the help shows under the Webhooks heading");
  await approval.check();
  check(await approval.isChecked(), "the approval event can be picked");
  const sent = page.waitForRequest(isPut);
  await page.getByRole("button", { name: "Save webhooks" }).click();
  const body = (await sent).postDataJSON();
  check(same(body.webhooks?.[0]?.events, ["landing", "approval"]), "the save sends the event name `approval`", body.webhooks?.[0]?.events);
  check(!("autoLand" in body) && !("landing" in body), "…and nothing about the merge choice", Object.keys(body));
  check(await shows(page.getByText("Webhooks saved")), "the toast says “Webhooks saved”");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Webhook 1: URL" }).waitFor();
  await page.waitForTimeout(400);
  check(await page.getByRole("group", { name: "Events" }).getByRole("checkbox", { name: "A person must say yes, or answered" }).isChecked(), "a reload shows the approval event picked");
  await ctx.close();
}

/* ═════════════ G. "Merge when no test runs" ═════════════ */
step("G. Settings: the help of “Merge when no test runs”");
{
  await reset();
  const { ctx, page } = await open("github");
  await settingsPage(page);
  await page.getByRole("radio", { name: "gitring test runner" }).click();
  await page.getByText("Test settings saved").first().waitFor();
  const box = page.getByRole("checkbox", { name: "Merge when no test runs" });
  check(await shows(box), "the switch shows for the gitring test runner");
  check(await shows(page.getByText("When no test ran, a person must say yes. Turn this on to skip that question.")), "off: the help says that a person must say yes");
  const sent = page.waitForRequest(isPut);
  await box.click();
  const body = (await sent).postDataJSON();
  check(same(Object.keys(body), ["allowUntested"]) && body.allowUntested === true, "the switch sends allowUntested only", body);
  check(await shows(page.getByText("When no test ran, gitring does not ask for that reason.")), "on: the help says that gitring does not ask for that reason");
  check(await shows(page.getByText(/The choice for “When does a person say yes\?” still applies\./)), "…and that the choice above still applies");
  await ctx.close();
}

/* ═════════════ H. Connect: the main URL and the two extra addresses ═════════════ */
step("H. Connect: one main URL, and two closed blocks (GitHub connector, read-only)");
{
  await reset();
  const { ctx, page } = await open("github", { clipboard: true });
  await page.goto(`${BASE}/connect?project=${OWNED}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Add gitring as a connector" }).waitFor();
  check((await page.getByLabel("MCP URL").count()) === 1, "one field is called “MCP URL”");
  check((await page.getByLabel("MCP URL").inputValue()) === `${BASE}/mcp`, "…and it holds the main URL", await page.getByLabel("MCP URL").inputValue());
  check((await page.getByRole("tablist", { name: "Your agent" }).getByRole("tab").count()) === 5, "the five agent tabs are still there");

  const swap = page.locator("#cx-github-swap");
  const ro = page.locator("#cx-readonly");
  const summaries = await page.locator("details.cx-more > summary").allTextContents();
  check(summaries.includes("Already use the GitHub connector? Replace it.") && summaries.includes("Read-only access"), "the two summaries read “Already use the GitHub connector? Replace it.” and “Read-only access”", summaries);
  check(!(await swap.evaluate((d) => d.open)) && !(await ro.evaluate((d) => d.open)), "both blocks are closed at first");
  check(!(await swap.locator("input").isVisible()) && !(await ro.locator("input").isVisible()), "…so their URLs do not show");
  check((await page.locator("input.cx-url__input:visible").count()) === 1, "only the main URL field shows while they are closed", await page.locator("input.cx-url__input:visible").count());

  await swap.locator("summary").click();
  check(await swap.evaluate((d) => d.open), "a click on the summary opens the GitHub block");
  const swapUrl = swap.getByLabel("URL to use instead of the GitHub connector");
  check((await swapUrl.inputValue()) === `${BASE}/mcp/github`, "…with the GitHub address (<origin>/mcp/github)", await swapUrl.inputValue());
  const lines = await swap.locator("ul.cx-lines > li").allTextContents();
  check(lines.length === 4, "…and four short lines", lines.length);
  check(same(await swap.locator(".code-inline").allTextContents(), ["get_file_contents", "create_pull_request"]), "…that name two GitHub tools as code", await swap.locator(".code-inline").allTextContents());
  check(lines.some((t) => /No tool writes to main directly\./.test(t)) && lines.some((t) => /a person says yes when the project asks/.test(t)), "…that say that no tool writes to main and that a person says yes when the project asks", lines);
  await swap.getByRole("button", { name: "Copy URL" }).click();
  check(await shows(swap.getByRole("button", { name: "Copied" })), "the copy button says “Copied”");
  check((await page.evaluate(() => navigator.clipboard.readText())) === `${BASE}/mcp/github`, "…and the clipboard holds the GitHub address", await page.evaluate(() => navigator.clipboard.readText()));

  await ro.locator("summary").click();
  check(await ro.evaluate((d) => d.open), "a click on the summary opens the read-only block");
  const roUrl = ro.getByLabel("URL for read-only access");
  check((await roUrl.inputValue()) === `${BASE}/mcp/readonly`, "…with the read-only address (<origin>/mcp/readonly)", await roUrl.inputValue());
  const roText = (await ro.innerText()).replace(/\s+/g, " ");
  check(/It has the read tools only\./.test(roText) && /mcp:read/.test(roText), "…and one sentence about the read tools and the scope", roText);
  check(await ro.locator("p").count() === 1, "…it is one paragraph");
  await ro.getByRole("button", { name: "Copy URL" }).click();
  check(await shows(ro.getByRole("button", { name: "Copied" })), "the copy button says “Copied”");
  check((await page.evaluate(() => navigator.clipboard.readText())) === `${BASE}/mcp/readonly`, "…and the clipboard holds the read-only address", await page.evaluate(() => navigator.clipboard.readText()));

  await page.locator(".cx-hero > .cx-url").getByRole("button", { name: "Copy URL" }).click();
  await page.waitForTimeout(150);
  check((await page.evaluate(() => navigator.clipboard.readText())) === `${BASE}/mcp`, "the main copy button still copies the main URL");
  check((await page.getByLabel("MCP URL").count()) === 1, "no other field is called “MCP URL” while both blocks are open");

  await swap.locator("summary").click();
  await ro.locator("summary").click();
  check(!(await swap.evaluate((d) => d.open)) && !(await ro.evaluate((d) => d.open)), "a second click closes each block");
  await ctx.close();
}

/* ═════════════ I. Connect: the merge question, the tools, the flow, the events ═════════════ */
step("I. Connect: “When an agent asks for a merge”, the tool list, the flow and the events");
{
  await reset();
  const { ctx, page } = await open("github");
  await page.goto(`${BASE}/connect?project=${OWNED}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Add gitring as a connector" }).waitFor();
  check(await shows(page.getByRole("heading", { name: "When an agent asks for a merge" })), "the block “When an agent asks for a merge” shows");
  const ask = page.getByRole("list", { name: "When an agent asks for a merge" });
  const items = await ask.getByRole("listitem").allTextContents();
  check(items.length === 3, "…with three short lines", items.length);
  check(/say yes before it merges the work of an agent/.test(items[0]) && /in the chat of the agent/.test(items[1]) && /at the bottom of every page, and on its own page/.test(items[2]), "…about the merge, the chat of the agent and the page", items);
  const settingsLink = ask.getByRole("link", { name: "Settings" });
  check(/\/settings\?(?=.*project=gitring-web-ab12)(?=.*section=merging)/.test((await settingsLink.getAttribute("href")) ?? ""), "the Settings link goes to the Merging section of this project", await settingsLink.getAttribute("href"));
  const out = ask.getByRole("link", { name: "Send events out" });
  await out.click();
  await page.waitForTimeout(1500); // the scroll is smooth
  const jumped = await page.evaluate(() => ({ id: document.activeElement?.id, top: Math.round(document.getElementById("cx-out").getBoundingClientRect().top) }));
  check(jumped.id === "cx-out" && jumped.top > -50 && jumped.top < 250, "the “Send events out” link jumps to that panel", jumped);
  check(!page.url().includes("#"), "…and keeps the address clean", page.url());

  // The tool list is on the "Other" tab.
  await page.getByRole("tablist", { name: "Your agent" }).getByRole("tab", { name: "Other" }).click();
  const tools = page.getByRole("list", { name: "The gitring tools" });
  await tools.waitFor();
  const toolNames = (await tools.locator("li > span:first-child").allTextContents()).flatMap((t) => t.split(" · "));
  check(toolNames.length === 12 && new Set(toolNames).size === 12, "the tool list on the Other tab has twelve tools", toolNames);
  check(toolNames.includes("gitring_status"), "…and `gitring_status` is one of them");
  check((await tools.locator("li", { hasText: "gitring_status" }).innerText()).replace(/\s+/g, " ").includes("It does not change the work copy."), "…with a line that says that it changes nothing");
  check((await tools.locator("li", { hasText: "gitring_submit" }).innerText()).replace(/\s+/g, " ").includes("A person says yes first when the project asks."), "the line of gitring_submit says that a person says yes first when the project asks");

  // The flow.
  const stageLabels = await page.locator("svg.flow g.flow__stage text.flow__label").allTextContents();
  check(same(stageLabels, ["Conflict check", "Change requests", "Rebase", "Tests", "Approval", "Merge", "History"]), "the flow diagram shows Tests, Approval and Merge in order", stageLabels);
  const flow = await page.locator("#flow-desc").textContent();
  check(flow.includes("It merges the work when the tests pass, and a person says yes when the project asks."), "the words for a screen reader say that the work merges when the tests pass and a person says yes when the project asks", flow);
  check(!/by itself/.test(flow), "…and do not say “by itself”");
  const lede = await page.locator(".page__lede").first().innerText();
  check(/merges the work into main when the tests pass\. A person says yes first when the project asks\./.test(lede.replace(/\s+/g, " ")), "the lede of the page says the same", lede);

  // The events panel.
  const section = page.locator("section", { has: page.locator("#cx-out") });
  const events = await section.locator("ul.cx__events > li").allInnerTexts();
  check(events.length === 5 && /^approval\s+a person must say yes, or answered$/.test(events[4].replace(/\s+/g, " ").trim()), "“Send events out” lists five events, the last is `approval`", events);
  const text = (await section.innerText()).replace(/\s+/g, " ");
  check(text.includes("For approval, the message has the task, the change in one line, and the link where a person answers."), "…and says what the approval message has");
  const example = section.locator("pre").filter({ hasText: '"event": "approval"' });
  check((await example.count()) === 1, "a second example shows the message of an approval");
  const exampleText = await example.innerText();
  check(exampleText.includes(`"project": "${OWNED}"`) && exampleText.includes(`"link": "${BASE}/approve/at_k3n9x2?project=${OWNED}"`), "…with the link to the page where a person answers", exampleText.slice(0, 300));
  check(["attemptId", "approval", "task", "agent", "line", "link"].every((k) => exampleText.includes(`"${k}"`)), "…and the keys of the message of the Worker");
  await ctx.close();
}

/* ═════════════ J. the keyboard ═════════════ */
step("J. Keyboard: Tab, the arrow keys and Enter");
{
  await reset();
  const { ctx, page } = await open("github");
  const { when, who, save } = await settingsPage(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Merging" }).click();
  await page.waitForTimeout(300);
  let a = await active(page);
  check(a?.id === "st-merging", "the Merging link puts the focus on the heading", a);
  await page.keyboard.press("Tab");
  a = await active(page);
  check(a?.type === "radio" && a.value === "risky", "Tab from the heading reaches the checked radio of the first group", a);
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check(ring !== "none", "…and a focus ring shows", ring);
  await page.keyboard.press("ArrowDown");
  a = await active(page);
  check(a?.value === "ask" && same(await states(when), [false, false, true]), "ArrowDown moves to “Before every merge” and selects it", { a, s: await states(when) });
  await page.keyboard.press("ArrowDown");
  check(same(await states(when), [true, false, false]), "ArrowDown at the end goes back to the first choice", await states(when));
  await page.keyboard.press("ArrowUp");
  check(same(await states(when), [false, false, true]), "ArrowUp at the start goes to the last choice", await states(when));
  await page.keyboard.press("ArrowUp");
  check(same(await states(when), [false, true, false]), "ArrowUp moves up one choice", await states(when));
  await page.keyboard.press("ArrowDown");
  check(same(await states(when), [false, false, true]), "…and the keys are the only input needed to pick a choice");
  check(await save.isEnabled(), "a change with the keys turns Save on");

  await page.keyboard.press("Tab");
  a = await active(page);
  check(a?.type === "radio" && a.value === "sender", "Tab moves on to the checked radio of “Who says yes?”", a);
  await page.keyboard.press("ArrowDown");
  check(same(await states(who), [false, true]), "ArrowDown selects “Only owners”", await states(who));
  await page.keyboard.press("Space");
  check(same(await states(who), [false, true]), "Space on a checked radio keeps it");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");

  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Save merge settings";
  }
  check(reached, "Tab reaches Save merge settings within a few key presses");
  const sent = page.waitForRequest(isPut);
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON();
  check(body.landing === "ask" && body.approver === "owner" && !("autoLand" in body), "Enter saves what the keys chose", body);
  check(await shows(page.getByText("Merge settings saved")), "…and the toast shows");
  await ctx.close();

  // The two blocks under the connector open and close with the keyboard.
  const c = await open("github");
  await c.page.goto(`${BASE}/connect?project=${OWNED}`, { waitUntil: "networkidle" });
  await c.page.getByRole("heading", { name: "When an agent asks for a merge" }).waitFor();
  const summary = c.page.locator("#cx-github-swap > summary");
  await summary.focus();
  await c.page.keyboard.press("Enter");
  check(await c.page.locator("#cx-github-swap").evaluate((d) => d.open), "Enter on the summary opens the GitHub block");
  await c.page.keyboard.press("Space");
  check(!(await c.page.locator("#cx-github-swap").evaluate((d) => d.open)), "Space on the summary closes it");
  await c.page.keyboard.press("Enter");
  await c.page.keyboard.press("Tab");
  a = await active(c.page);
  check(a?.tag === "input" && a.value === `${BASE}/mcp/github`, "Tab from the open summary reaches the address", a);
  await c.page.keyboard.press("Tab");
  a = await active(c.page);
  check(a?.tag === "button" && /Copy URL/.test(a.text), "…then the copy button", a);
  await c.ctx.close();
}

/* ═════════════ K. layout and colors ═════════════ */
for (const theme of ["day", "dusk", "night"]) {
  for (const width of [1280, 375]) {
    step(`K. ${theme}, ${width} px: Settings and Connect fit the window, and the words are readable`);
    await reset();
    const { ctx, page } = await open("github", { theme, width, height: width === 375 ? 740 : 860 });
    await settingsPage(page);
    check(await noOverflow(page), "Settings has no horizontal scroll");
    check((await spill(page, [".st-choice"])).length === 0, "…and the radio groups stay inside the window", await spill(page, [".st-choice"]));
    const opts = await page.locator(".st-choice__opt").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check(opts.length === 5 && opts.every((h) => h >= 44), "…each choice is at least 44 px high (a touch target)", opts);
    const clipped = await page.locator(".st-choice__opt label").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    check(clipped === 0, "…and no label is cut off");
    for (const [sel, name, min] of [
      ["fieldset.st-choice .st-choice__opt:not(:has(input:checked)) .st-choice__help", "help text of a choice", 4.5],
      [".st-choice__opt:has(input:checked) .st-choice__help", "help text of the picked choice", 4.5],
      [".st-choice__opt:has(input:checked) .st-choice__name", "name of the picked choice", 4.5],
      [".st-choice__opt .b-badge", "“Recommended” badge", 4.5],
    ]) {
      const c = await contrastOf(page, sel);
      check(c !== null && c >= min, `${name}: contrast ${c} (at least ${min})`, c);
    }
    // The webhook help and the toast hold up in each theme too.
    const hook = await contrastOf(page, "#st-webhooks ~ .np__help");
    check(hook !== null && hook >= 4.5, `Webhooks help text: contrast ${hook}`, hook);

    await page.goto(`${BASE}/connect?project=${OWNED}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "When an agent asks for a merge" }).waitFor();
    await page.locator("#cx-github-swap > summary").click();
    await page.locator("#cx-readonly > summary").click();
    await page.waitForTimeout(150);
    check(await noOverflow(page), "Connect has no horizontal scroll, with both blocks open");
    check((await spill(page, [".cx-after", ".cx-hero"])).length === 0, "…and the hero and the blocks stay inside the window", await spill(page, [".cx-after", ".cx-hero"]));
    for (const [sel, name] of [
      [".cx-lines li", "lines under the connector"],
      [".cx-more > summary", "summary of a block"],
      ["#cx-readonly .cx__step", "read-only sentence"],
    ]) {
      const c = await contrastOf(page, sel);
      check(c !== null && c >= 4.5, `${name}: contrast ${c}`, c);
    }
    const urlFits = await page.locator("#cx-github-swap .cx-url").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth + 1;
    });
    check(urlFits, "the GitHub address row fits");
    await page.getByRole("tablist", { name: "Your agent" }).getByRole("tab", { name: "Other" }).click();
    check(await noOverflow(page), "the Other tab (with twelve tools) fits");
    await page.locator("#cx-flow").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    check(await noOverflow(page), "…and the flow diagram with seven stages fits");
    const flowBox = await page.locator("svg.flow").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), width: window.innerWidth };
    });
    check(flowBox.left >= 0 && flowBox.right <= flowBox.width + 1, "…inside the window", flowBox);
    await ctx.close();
  }
}

/* ═════════════ the console ═════════════ */
step("No errors in the console");
check(errors.length === 0, "no page errors and no console errors", errors.slice(0, 3));

await browser.close();
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
