// Browser checks of the landing story, run by hand like shell-e2e.mjs.
// They are ported from the checks of the founder's portfolio.
//   node test/web/story-e2e.mjs                       builds the app when it is old, starts a local gitring with the waitlist gate on
//   BASE=http://localhost:8787 node test/web/story-e2e.mjs    uses a gitring that runs already, with the gate on
// Checks: the stage pins and the tip stays at 55% of the width; "Skip the story" is the first stop of the section and leads to the
// closing; the rail fills in order and its last button shows the end; find-in-page moves the story; a link to a chapter opens it;
// nothing touches anything at six window sizes; the phone and the reduced-motion layouts show every chapter with no sideways scroll.
// It never calls the live site and never prints a key. Read next: docs/design/landing-story.md (section 9).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../scripts/shots/browser.mjs";
import { buildApp, isBuildStale, startLocal } from "../../scripts/shots/server.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let failures = 0;
const ok = (condition, message) => {
  if (condition) console.log("✓", message);
  else {
    failures += 1;
    console.log("✗", message);
  }
};

// ───── Start ─────

let server = null;
let base = process.env.BASE;
if (!base) {
  if (isBuildStale(ROOT)) buildApp(ROOT, console.log);
  server = await startLocal(ROOT, console.log, { waitlist: true });
  base = server.url;
}
const browser = await launchBrowser();

async function open(width, height, { reducedMotion = "no-preference", hash = "" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, isMobile: width < 700, hasTouch: width < 700 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A visitor is not signed in, so the page asks who the person is and gets a 401. That is the one expected error.
  page.on("console", (message) => message.type() === "error" && !/status of 401/.test(message.text()) && errors.push(message.text()));
  await page.goto(`${base}/${hash}`, { waitUntil: "load" });
  await page.waitForSelector("#story");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector("#story[data-mode]");
  await page.waitForTimeout(400);
  return { context, page, errors };
}

/** Scrolls the box of the page so that the story is at a progress from 0 to 1, and waits until the engine has caught up. */
async function scrollStory(page, progress) {
  await page.evaluate((share) => {
    const root = document.querySelector(".wl");
    const section = document.querySelector("#story");
    const stage = section.querySelector(".story-stage");
    root.scrollTop = section.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop + share * (section.offsetHeight - stage.offsetHeight);
  }, progress);
  await page.waitForTimeout(800);
}

const facts = (page) =>
  page.evaluate(() => {
    const root = document.querySelector(".wl");
    const section = document.querySelector("#story");
    const tip = section.querySelector(".story-tip")?.getBoundingClientRect();
    return {
      mode: section.dataset.mode,
      sideways: root.scrollWidth - root.clientWidth,
      stageTop: Math.round(section.querySelector(".story-stage").getBoundingClientRect().top - root.getBoundingClientRect().top),
      tipShare: tip ? (tip.left + tip.width / 2) / root.clientWidth : null,
      scrollTop: root.scrollTop,
      current: [...section.querySelectorAll(".story-rail [aria-current]")].map((el) => el.dataset.chapter),
    };
  });

// ───── The wide story ─────

{
  const { context, page, errors } = await open(1440, 900);
  ok((await facts(page)).mode === "horizontal", "1440 by 900: the pinned layout runs");
  const rail = await page.locator("#story .story-rail [data-go]").evaluateAll((buttons) => buttons.map((b) => [Number(b.dataset.from), Number(b.dataset.to)]));
  ok(rail.length === 7, "the rail has seven chapter buttons");
  ok(rail[0][0] === 0 && rail.at(-1)[1] === 1 && rail.every(([from, to], i) => to > from && (i === 0 || from === rail[i - 1][1])), "the rail parts are in order, with no gap, from 0 to 1");

  await scrollStory(page, 0.5);
  const middle = await facts(page);
  ok(middle.stageTop === 0, "the stage stays pinned at the top of the page box");
  ok(Math.abs(middle.tipShare - 0.55) < 0.03, `the tip stays at 55% of the width (${middle.tipShare?.toFixed(3)})`);
  ok(middle.current.length === 1, "one rail button is the current step (aria-current)");

  await page.locator("#story .story-rail [data-go]").last().click();
  await page.waitForTimeout(1600);
  const end = await facts(page);
  ok(end.current[0] === "why", "the last rail button shows chapter 07");
  const whyText = await page.locator("#story-why .story-text").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
  });
  ok(whyText, "the text of chapter 07 is on the screen");
  ok(await page.locator("#story-why .story-record").evaluate((el) => el.hasAttribute("data-shown")), "the merge record shows at the end");

  await scrollStory(page, 0.1);
  const before = (await facts(page)).scrollTop;
  // Find in page scrolls the clipped window sideways. The engine turns that into progress.
  await page.locator("#story .story-window").evaluate((el) => (el.scrollLeft += innerWidth / 2));
  await page.waitForTimeout(900);
  ok((await facts(page)).scrollTop > before + 100, "find-in-page moves the story forward");

  await page.keyboard.press("Tab");
  ok(errors.length === 0, `no script error (${errors.join("; ").slice(0, 120)})`);
  await context.close();
}

// ───── The keyboard ─────

{
  const { context, page } = await open(1440, 900);
  const order = await page.locator("#story").evaluate((section) => [...section.querySelectorAll("a[href], button")].map((el) => el.textContent.trim().replace(/^\d+/, "")));
  ok(order[0] === "Skip the story", `"Skip the story" is the first control of the section (${order[0]})`);
  ok(order.length === 9 && order.at(-1) === "Skip the story", "the section has the skip link, seven rail buttons and the skip item of the rail");
  await page.locator("#story .story-skip").focus();
  ok(await page.locator("#story .story-skip").evaluate((el) => el.getBoundingClientRect().width > 20), "the skip link shows when it has the focus");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  ok(await page.locator("#wl-closing").evaluate((el) => document.activeElement === el || el.getBoundingClientRect().top < innerHeight), "the skip link leads to the closing");
  await context.close();
}

// ───── A link to a chapter ─────

{
  const { context, page } = await open(1440, 900, { hash: "#story-merge" });
  await page.waitForTimeout(1500);
  const facts1 = await facts(page);
  ok(facts1.current[0] === "merge", `the address #story-merge opens chapter 05 (${facts1.current[0]})`);
  await context.close();
}

// ───── Windows of many sizes: nothing touches anything ─────

async function touching(page) {
  return page.evaluate(() => {
    const section = document.querySelector("#story");
    const stage = section.querySelector(".story-stage").getBoundingClientRect();
    const rail = section.querySelector(".story-rail").getBoundingClientRect();
    const items = [...section.querySelectorAll("[data-shown]")]
      .filter((el) => !el.matches(".story-stem, .story-distance, .story-leader, .story-start, .story-join, .story-flag, .story-parcel"))
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.right > stage.left && box.left < stage.right);
    const found = [];
    for (let i = 0; i < items.length; i += 1) {
      const a = items[i].box;
      if (a.bottom > rail.top - 2) found.push(`${items[i].el.className} on the rail`);
      for (let j = i + 1; j < items.length; j += 1) {
        const b = items[j].box;
        const w = Math.min(a.right, b.right, stage.right) - Math.max(a.left, b.left, stage.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) found.push(`${items[i].el.className} x ${items[j].el.className}`);
      }
    }
    return found;
  });
}

for (const [width, height] of [[1280, 720], [1440, 900], [1920, 1080], [901, 720], [1024, 640], [901, 640]]) {
  const { context, page } = await open(width, height);
  let problems = [];
  for (let progress = 0; progress <= 1.001; progress += 0.1) {
    await scrollStory(page, Math.min(1, progress));
    problems = problems.concat((await touching(page)).map((p) => `${progress.toFixed(1)} ${p}`));
  }
  ok((await facts(page)).mode === "horizontal", `${width} by ${height}: the pinned layout runs`);
  ok(problems.length === 0, `${width} by ${height}: nothing touches the rail or another part (${problems.slice(0, 2).join("; ")})`);
  await context.close();
}

// ───── Phone and reduced motion: every chapter, in order, no sideways scroll ─────

for (const [name, width, height, reducedMotion, mode] of [
  ["phone", 390, 844, "no-preference", "vertical"],
  ["narrow phone", 320, 640, "no-preference", "vertical"],
  ["reduced motion", 1440, 900, "reduce", "static"],
]) {
  const { context, page, errors } = await open(width, height, { reducedMotion });
  const seen = await facts(page);
  ok(seen.mode === mode, `${name}: the ${mode} layout runs (${seen.mode})`);
  ok(seen.sideways === 0, `${name}: no sideways scroll`);
  const headings = await page.locator("#story h2, #story h3").allTextContents();
  ok(headings.length === 8 && headings[0].startsWith("Three agents") && /Start a project/.test(headings[1]) && /records why/.test(headings[7]), `${name}: the opening and seven chapters are in the DOM, in order`);
  const hidden = await page.evaluate(() => [...document.querySelectorAll("#story .story-text")].filter((el) => getComputedStyle(el).display === "none").length);
  ok(hidden === 0, `${name}: no chapter text is hidden`);
  if (reducedMotion === "reduce") {
    const moving = await page.evaluate(() => ({ transform: document.querySelector("#story .story-canvas").style.transform, ready: document.querySelector("#story").hasAttribute("data-ready"), pinned: getComputedStyle(document.querySelector("#story .story-stage")).position }));
    ok(moving.transform === "" && !moving.ready && moving.pinned !== "sticky", "reduced motion: no pin, no travel, nothing waits for a position");
  }
  ok(errors.length === 0, `${name}: no script error`);
  await context.close();
}

await browser.close();
server?.stop();
console.log(failures ? `\n${failures} checks failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
