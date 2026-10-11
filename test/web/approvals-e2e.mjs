// Browser checks of the approvals screens: merges that wait for a yes. They run against the mock API
// (test/web/shell-mock.mjs, scenario "approvals"), in a real browser.
//   npm run build && node test/web/shell-mock.mjs 8811 &
//   BASE=http://127.0.0.1:8811 node test/web/approvals-e2e.mjs
// Checks: the tray of chips on every project page (text, order, "+N more", the tab title), a yes and a send-back
// from a chip (the request, the toast, the live update), the people who may not answer, the decisions list, the
// approve page (facts, diff, other work copies, answers, results in place, live changes), a visitor who is not
// signed in, an address that does not exist, the keyboard, windows of other sizes (a tablet, a low window, a phone
// on its side), reduced motion, and no horizontal overflow at 1280 and 375 px.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:8811";
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log("✓", msg);
  else {
    failures++;
    console.log("✗", msg);
  }
};

const control = (path, body = {}) => fetch(`${BASE}/__mock/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reset = (scenario = "approvals") => fetch(`${BASE}/__mock/reset?scenario=${scenario}`, { method: "POST" });
/** The answers that the browser sent, with their bodies. */
const answers = async () => (await (await fetch(`${BASE}/__mock/log`)).json()).filter((r) => r.method === "POST" && /\/attempts\/[^/]+\/decide$/.test(r.path));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });

async function open(width, height, { signedIn = true, reducedMotion = "no-preference" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The mock answers 401 and 403 on purpose (a visitor, a refusal): the browser logs those loads as errors.
  page.on("console", (m) => m.type() === "error" && !/status of (401|403)/.test(m.text()) && errors.push(m.text()));
  if (signedIn) await page.goto(`${BASE}/auth/github/start?return=/projects`, { waitUntil: "networkidle" });
  return { ctx, page, errors };
}

const noOverflow = async (page, name) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  ok(o.sw <= o.cw && o.bw <= o.cw, `${name}: no horizontal overflow (${o.sw}/${o.cw})`);
};
const focused = (page) => page.evaluate(() => (document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent || "").trim().slice(0, 60));
const focusedAttempt = (page) => page.evaluate(() => document.activeElement?.closest(".apcard")?.getAttribute("data-attempt") ?? null);
const trayOf = (page) => page.getByRole("region", { name: "Merges that wait for you" });
const chipOf = (page, id) => trayOf(page).locator(`.apcard[data-attempt="${id}"]`);
const toastTitles = (page) => page.locator(".b-toast__title").allTextContents();

/* ───────────── the tray: what it shows ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  const tray = trayOf(page);
  await tray.waitFor();
  const chips = tray.locator(".apcard");
  ok((await chips.count()) === 3, "the tray shows 3 chips at most (4 merges wait for Robin)");
  const titles = await chips.locator(".apcard__title").allTextContents();
  ok(sameJson(titles, ["Add a search to the shop", "Round the price in the cart", "Show a sale badge on cheap items"]), `the newest chip is at the bottom (${titles.join(" | ")})`);
  ok(await tray.getByRole("button", { name: /\+1 more/ }).isVisible(), "the tray says +1 more");
  ok((await tray.locator("li").count()) === 4, "the chips are list items (3 chips and the +1 more control)");

  const cart = chipOf(page, "at_c1");
  const text = (await cart.innerText()).replace(/\s+/g, " ");
  ok(text.includes("Round the price in the cart") && text.includes("KESTREL-7"), "a chip names the task and the agent");
  ok(text.includes("1 file, +9 -3. 5 of 5 tests pass."), "a chip says the size of the change and the tests");
  ok(text.includes("This project asks a person before every merge."), "a chip says why a person must say yes");
  ok((await cart.getByRole("link", { name: "Review" }).getAttribute("href")) === "/approve/at_c1?project=shop", "Review links to the approve page of the work copy");
  ok((await cart.getByRole("button", { name: "Yes, merge" }).isVisible()) && (await cart.getByRole("button", { name: "Send back…" }).isVisible()), "a chip has Yes, merge and Send back…");
  ok((await cart.getAttribute("role")) === "group" && (await cart.getAttribute("aria-labelledby")) !== null, "a chip is a group that the title names");
  ok((await trayOf(page).locator(".apcard[data-attempt='at_k1']").count()) === 0, "the question that waits for Sam has no chip for Robin");

  ok((await page.title()) === "(4) gitring", `the tab title shows the count (${await page.title()})`);
  const label = await page.locator(".topbar__queue").getAttribute("aria-label");
  ok(label === "4 merges wait for you. 1 waits for other people. Show the decisions.", `the decisions button tells the count (${label})`);
  ok((await page.locator(".topbar__queue").textContent())?.includes("4 decisions"), "the decisions button shows 4 decisions");
  ok((await tray.evaluate((el) => getComputedStyle(el).position)) === "fixed", "the tray is fixed in the corner");
  ok((await page.locator("dialog").count()) === 0 && (await page.locator("[aria-modal='true']").count()) === 0, "the tray is no modal and has no focus trap");
  await noOverflow(page, "overview with the tray at 1280");

  // The tray follows the person to every project page, and only to those.
  await page.goto(`${BASE}/code?project=shop`, { waitUntil: "networkidle" });
  ok(await trayOf(page).isVisible(), "the tray shows on the code page too");
  await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  ok((await trayOf(page).count()) === 0 && !/^\(\d+\)/.test(await page.title()), "the account page has no tray and no count in the title");

  // A new question for this person: a polite message for screen readers, the count and a chip.
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  await tray.waitFor();
  await control("attempt", { id: "at_k1", patch: { approval: { approver: { id: "u_1", name: "Robin" } } } });
  const live = page.locator('[role="status"]', { hasText: "merges wait for you:" });
  await live.waitFor({ state: "attached", timeout: 4000 });
  ok((await live.textContent()) === "5 merges wait for you: Show the stock count on each item", `a new question is announced (${await live.textContent()})`);
  ok((await page.title()) === "(5) gitring", "the count in the title follows the live state");
  ok((await chipOf(page, "at_k1").count()) === 1 && (await tray.getByRole("button", { name: /\+2 more/ }).count()) === 1, "the new question has a chip, and the tray says +2 more");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── a yes, and a send-back, from a chip ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  const tray = trayOf(page);
  await tray.waitFor();

  // Yes: the request names the question that the person saw. The chip leaves, and the next one comes.
  await chipOf(page, "at_b1").getByRole("button", { name: "Yes, merge" }).click();
  await page.locator(".b-toast__title", { hasText: /^Merged into main beef567$/ }).waitFor({ timeout: 4000 });
  let sent = await answers();
  ok(sent.length === 1 && sent[0].path === "/api/projects/shop/attempts/at_b1/decide" && sameJson(sent[0].body, { approvalId: "ap_b1", answer: "approve" }), `Yes sends the approval id and the answer (${JSON.stringify(sent[0]?.body)})`);
  await chipOf(page, "at_b1").waitFor({ state: "detached", timeout: 4000 });
  ok(true, "the chip leaves after a yes");
  ok((await tray.getByRole("button", { name: /more/ }).count()) === 0 && (await tray.locator(".apcard").count()) === 3, "the chip that was behind +1 more comes into view");
  ok((await page.title()) === "(3) gitring", "the count in the title goes down");
  const mergedToast = page.locator(".b-toast", { hasText: "Merged into main beef567" });
  ok((await mergedToast.locator(".b-toast__text").textContent())?.includes("“Show a sale badge on cheap items”. Merged by fast-forward at beef567."), "the toast says which work merged");
  ok((await page.getByRole("button", { name: "Read the merge record" }).count()) === 1, "the toast has a link to the merge record");

  // Escape in the note closes the note. The chip and the toast stay.
  const cart = chipOf(page, "at_c1");
  await cart.getByRole("button", { name: "Send back…" }).click();
  const note = cart.getByRole("textbox", { name: /Tell the agent what to change/ });
  ok(await note.evaluate((el) => el === document.activeElement), "Send back… opens a note field with focus");
  ok((await cart.getByRole("button", { name: "Send back…" }).getAttribute("aria-expanded")) === "true", "Send back… says that it is open");
  await page.keyboard.press("Escape");
  await note.waitFor({ state: "detached" });
  await page.waitForTimeout(100);
  ok((await cart.count()) === 1 && (await toastTitles(page)).some((t) => /^Merged into main/.test(t)), "Escape closes the note only: the chip and the toast stay");
  ok((await focused(page)) === "Send back…", `focus returns to Send back… (${await focused(page)})`);

  // The competing pair: a yes for one closes the question of the other, live.
  await chipOf(page, "at_s1").getByRole("button", { name: "Yes, merge" }).click();
  await chipOf(page, "at_s1").waitFor({ state: "detached", timeout: 4000 });
  await chipOf(page, "at_s2").waitFor({ state: "detached", timeout: 4000 });
  ok(true, "a yes for one of two competing work copies removes both chips");
  sent = await answers();
  ok(sent.length === 2 && sameJson(sent[1].body, { approvalId: "ap_s1", answer: "approve" }), "only one request went out for the pair");
  ok((await page.title()) === "(1) gitring", "one question is left for Robin");

  // Send back with a note: the note goes with the answer. The state that the work copy is stale for a moment gives no toast.
  await cart.getByRole("button", { name: "Send back…" }).click();
  await note.fill("  Keep the old name.  ");
  await cart.getByRole("button", { name: "Send back", exact: true }).click();
  await chipOf(page, "at_c1").waitFor({ state: "detached", timeout: 4000 });
  sent = await answers();
  ok(sameJson(sent[2].body, { approvalId: "ap_c1", answer: "send-back", note: "Keep the old name." }), `Send back sends the note without the spaces (${JSON.stringify(sent[2]?.body)})`);
  // The live state is faster than the answer: the chip leaves first, and the toast comes with the answer.
  await page.locator(".b-toast__title", { hasText: "Sent back to the agent" }).waitFor({ timeout: 4000 });
  ok(true, "the toast says that the work went back");
  await tray.waitFor({ state: "detached", timeout: 4000 });
  ok(true, "the tray goes when no question waits for Robin");
  await page.waitForTimeout(2200);
  ok(!(await toastTitles(page)).includes("A decision needs you"), "no toast says that the work could not merge after a send-back");
  ok(!/^\(\d+\)/.test(await page.title()), `the count leaves the title (${await page.title()})`);
  ok((await page.locator(".topbar__queue").getAttribute("aria-label"))?.startsWith("No merge waits for you."), "the decisions button says that no merge waits");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── a note without text, and a failed answer ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  const chip = chipOf(page, "at_b1");
  await chip.waitFor();
  await chip.getByRole("button", { name: "Send back…" }).click();
  await chip.getByRole("button", { name: "Send back", exact: true }).click();
  await chip.waitFor({ state: "detached", timeout: 4000 });
  const sent = await answers();
  ok(sent.length === 1 && sameJson(sent[0].body, { approvalId: "ap_b1", answer: "send-back" }), `Send back without a note sends no note (${JSON.stringify(sent[0]?.body)})`);
  await page.locator(".b-toast__title", { hasText: "Sent back to the agent" }).waitFor({ timeout: 4000 });
  ok(true, "the toast says that the work went back");

  // The role changes while the page is open: the Worker refuses, and the sentence says why. The chip stays.
  await control("role", { role: "viewer" });
  await chipOf(page, "at_c1").getByRole("button", { name: "Yes, merge" }).click();
  await page.locator(".b-toast__title", { hasText: "The answer did not send" }).waitFor({ timeout: 4000 });
  ok((await page.locator(".b-toast", { hasText: "The answer did not send" }).locator(".b-toast__text").textContent())?.includes("You need the member role on this project. Ask an owner."), "an error of the Worker shows as a sentence");
  ok((await chipOf(page, "at_c1").count()) === 1, "the chip stays after an answer that failed");
  await control("role", { role: "member" });
  await control("settings", { approver: "owner" });
  await chipOf(page, "at_c1").getByRole("button", { name: "Yes, merge" }).click();
  await page.locator(".b-toast__title", { hasText: "You cannot answer this" }).waitFor({ timeout: 4000 });
  ok((await page.locator(".b-toast__text", { hasText: "Only an owner of the project can answer this." }).count()) === 1, "a refusal shows the sentence of the Worker");
  ok((await chipOf(page, "at_c1").count()) === 1, "the chip stays after a refusal");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── people who may not answer ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/tasks?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".topbar__queue").click();
  const pop = page.getByRole("dialog", { name: "Decisions" });
  await pop.waitFor();
  const rows = pop.locator(".queue__item--approval");
  ok((await rows.count()) === 5, "the decisions list has a card for each of the 5 questions");
  const sam = pop.locator(".apcard[data-attempt='at_k1']");
  const samText = (await sam.innerText()).replace(/\s+/g, " ");
  ok(samText.includes("Waits for Sam"), `a question that waits for Sam says so (${samText})`);
  ok((await sam.getByRole("link", { name: "Review" }).count()) === 1, "it still has Review");
  ok((await sam.getByRole("button").count()) === 0, "it has no Yes and no Send back");
  ok((await pop.locator(".apcard[data-attempt='at_c1']").getByRole("button", { name: "Yes, merge" }).count()) === 1, "a question for Robin has the buttons");
  const help = (await pop.locator(".pop-help").textContent()) ?? "";
  ok(help.includes("4 merges wait for you.") && help.includes("J and K move between the decisions."), `the help names the count and the keys (${help})`);

  // The rule says "owner": every question waits for an owner, and a member has nothing to answer.
  await ctx.close();
  await control("settings", { approver: "owner" });
  const again = await open(1280, 820);
  await again.page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  await again.page.locator(".topbar__queue").waitFor();
  const lab = await again.page.locator(".topbar__queue").getAttribute("aria-label");
  ok(lab === "No merge waits for you. 5 wait for other people. Show the decisions.", `with the rule "owner" a member has no question (${lab})`);
  ok((await trayOf(again.page).count()) === 0, "a member sees no chip when only an owner answers");
  ok(!/^\(\d+\)/.test(await again.page.title()), "and no count in the tab title");
  await again.page.locator(".topbar__queue").click();
  const owner = again.page.getByRole("dialog", { name: "Decisions" });
  await owner.waitFor();
  const waits = await owner.locator(".apcard__waits").allTextContents();
  ok(waits.length === 5 && waits.every((w) => w === "Waits for an owner"), `every card says Waits for an owner (${waits.join(" | ")})`);
  ok((await owner.getByRole("button", { name: /Yes|Send back/ }).count()) === 0, "no card has an answer button");
  await again.ctx.close();

  // A viewer sees the questions and cannot answer any of them.
  await control("settings", { approver: "sender" });
  await control("role", { role: "viewer" });
  const view = await open(1280, 820);
  await view.page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  await view.page.locator(".topbar__queue").waitFor();
  const vl = await view.page.locator(".topbar__queue").getAttribute("aria-label");
  ok(vl === "5 decisions wait for a member. Show the decisions.", `a viewer is told that the decisions wait for a member (${vl})`);
  ok((await trayOf(view.page).count()) === 0, "a viewer has no tray");
  await view.page.goto(`${BASE}/approve/at_c1?project=shop`, { waitUntil: "networkidle" });
  await view.page.getByRole("heading", { name: "Your answer" }).waitFor();
  ok((await view.page.getByRole("button", { name: "Yes, merge it" }).count()) === 0, "a viewer has no yes on the approve page");
  ok(await view.page.getByText("You can view this project. Only a member can say yes. Ask an owner for the member role.").isVisible(), "and the page says why");
  ok(errors.length === 0 && view.errors.length === 0 && again.errors.length === 0, "no page errors");
  await view.ctx.close();
}

/* ───────────── +N more, and the decisions list from the keyboard ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  const tray = trayOf(page);
  await tray.getByRole("button", { name: /\+1 more/ }).click();
  const pop = page.getByRole("dialog", { name: "Decisions" });
  await pop.waitFor();
  ok((await pop.locator(".queue__item--approval").count()) === 5, "+1 more opens the decisions list with all 5 questions");
  ok((await tray.count()) === 0, "the tray steps aside while the list shows the same questions");
  ok((await focusedAttempt(page)) === "at_s1" && (await focused(page)) === "Review", `focus starts on Review of the first question (${await focused(page)})`);
  await page.keyboard.press("j");
  ok((await focusedAttempt(page)) === "at_s2", "J moves to the next question");
  await page.keyboard.press("ArrowDown");
  ok((await focusedAttempt(page)) === "at_c1", "the arrow keys move too");
  await page.keyboard.press("k");
  ok((await focusedAttempt(page)) === "at_s2", "K moves back");
  // Letters belong to the note field of a card: J does not leave it.
  await pop.locator(".apcard[data-attempt='at_s2']").getByRole("button", { name: "Send back…" }).click();
  await page.keyboard.type("jk");
  ok((await pop.locator(".apcard[data-attempt='at_s2']").getByRole("textbox").inputValue()) === "jk" && (await focusedAttempt(page)) === "at_s2", "typing J and K in a note does not move the focus");
  await page.keyboard.press("Escape");
  ok((await pop.count()) === 1 && (await pop.locator(".apcard[data-attempt='at_s2']").getByRole("textbox").count()) === 0, "Escape in the note closes the note, not the list");
  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "detached" });
  await tray.waitFor();
  ok((await tray.locator(".apcard").count()) === 3, "Escape closes the list, and the chips come back");

  // A yes from the list.
  await page.locator(".topbar__queue").click();
  await pop.waitFor();
  await pop.locator(".apcard[data-attempt='at_c1']").getByRole("button", { name: "Yes, merge" }).click();
  await page.locator(".b-toast__title", { hasText: /^Merged into main/ }).waitFor({ timeout: 4000 });
  await pop.locator(".apcard[data-attempt='at_c1']").waitFor({ state: "detached", timeout: 4000 });
  const sent = await answers();
  ok(sent.length === 1 && sameJson(sent[0].body, { approvalId: "ap_c1", answer: "approve" }), "a yes in the list sends the same request as a chip");
  ok((await pop.locator(".queue__item--approval").count()) === 4, "the card leaves the list");
  // Review closes the list and opens the page.
  await pop.locator(".apcard[data-attempt='at_s1']").getByRole("link", { name: "Review" }).click();
  await page.waitForURL(/\/approve\/at_s1\?project=shop/);
  ok((await pop.count()) === 0, "Review opens the approve page and closes the list");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── the approve page ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/approve/at_s1?project=shop`, { waitUntil: "networkidle" });
  await page.locator("#main h1").waitFor();
  const h1 = await page.locator("#main h1").textContent();
  ok(h1 === "Add a search to the shop", `the title is the task (${h1})`);
  ok(await page.locator(".approve__crumbs").getByText("Waits for a yes").isVisible(), "the pill says Waits for a yes");
  const ask = (await page.locator(".approve__ask").innerText()).replace(/\s+/g, " ");
  ok(ask === "PETREL-2 asks to merge this into main", `the page says who asks (${ask})`);
  ok(/Sent by Robin · Asked .* ago/.test(await page.locator(".approve__meta").innerText()), "the page says who sent the agent, and when it asked");
  ok(await page.getByRole("heading", { name: "Why a person must say yes" }).isVisible() && (await page.locator(".approve__why li").allTextContents()).includes("2 work copies compete on this task. A person chooses one."), "the reasons show");
  ok(await page.getByText("2 files, +46 -2. 8 of 8 tests pass.").isVisible(), "the size and the tests show");
  ok((await page.locator(".approve .b-evidence").count()) === 2, "the evidence bars show: alone, and combined with main");
  await page.locator(".b-diff__file").first().waitFor();
  ok((await page.locator(".b-diff__file").count()) === 2 && (await page.locator(".b-diff__scroll").count()) === 2, "the diff shows 2 files, both open");
  ok(await page.getByRole("heading", { name: "The task" }).isVisible() && (await page.getByText("Plan of PETREL-2").isVisible()), "the task and the plan show");
  const others = page.locator("section", { has: page.getByRole("heading", { name: "Other work copies of this task" }) });
  ok(await others.isVisible(), "the other work copies of the task show");
  const rival = (await others.innerText()).replace(/\s+/g, " ");
  ok(rival.includes("KESTREL-7") && rival.includes("3 files, +80 -12. 1 of 8 tests fail.") && rival.includes("If you say yes to one, gitring closes the others."), `a rival shows its size and tests (${rival})`);
  ok((await others.getByRole("link", { name: "Review the work of KESTREL-7" }).getAttribute("href")) === "/approve/at_s2?project=shop", "and links to its own page");
  ok((await page.getByRole("link", { name: "Open in code" }).getAttribute("href"))?.startsWith("/code/at_s1"), "Open in code links to the diff");

  // The tray here is one line: the answer of the page is in the same corner.
  const tray = trayOf(page);
  const line = (await tray.innerText()).replace(/\s+/g, " ");
  ok(line === "3 other merges wait for you", `the tray is one line on the approve page (${line})`);
  ok((await chipOf(page, "at_s1").count()) === 0, "the chip of this work copy is not in the tray");
  const panel = await page.locator(".approve__panel").boundingBox();
  const trayBox = await tray.boundingBox();
  ok(panel && trayBox && (panel.y + panel.height <= trayBox.y || panel.x + panel.width <= trayBox.x), "the tray does not cover the answer");
  ok((await page.title()) === "(4) gitring", "the tab title keeps the count");
  await noOverflow(page, "approve page at 1280");

  // Yes: the result shows in place, with the merge record. The request names the question that the page showed.
  await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).click();
  await page.locator(".approve__outcome").waitFor({ timeout: 4000 });
  const sent = await answers();
  ok(sent.length === 1 && sent[0].path === "/api/projects/shop/attempts/at_s1/decide" && sameJson(sent[0].body, { approvalId: "ap_s1", answer: "approve" }), `the yes names the question (${JSON.stringify(sent[0]?.body)})`);
  const outcome = (await page.locator(".approve__outcome").innerText()).replace(/\s+/g, " ");
  ok(outcome.includes("Merged into main beef567") && outcome.includes("You said yes now.") && outcome.includes("Method: Fast-forward."), `the result shows in place (${outcome})`);
  ok(await page.locator(".approve__outcome").evaluate((el) => el === document.activeElement), "focus moves to the result");
  ok(await page.locator(".approve__crumbs").getByText("Merged", { exact: true }).isVisible(), "the pill says Merged");
  ok((await page.locator(".approve__panel").getByRole("button", { name: /Yes|Send back/ }).count()) === 0, "the answer buttons are gone");
  ok((await page.locator(".b-toast").count()) === 0, "the page shows the result itself: no toast");
  ok((await page.getByRole("link", { name: "Read the merge record" }).getAttribute("href"))?.startsWith("/history/"), "the result links to the merge record");
  ok((await page.locator("section", { has: page.getByRole("heading", { name: "Other work copies of this task" }) }).count()) === 0, "the other work copy is closed: its list is gone");
  ok(await page.getByText("Merged", { exact: true }).first().isVisible() && (await page.getByText("asked to merge this into main").count()) === 1, "the page speaks in the past tense");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── the approve page: send back, the work of other people, the old question ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/approve/at_c1?project=shop`, { waitUntil: "networkidle" });
  const panel = page.locator(".approve__panel");
  await panel.getByRole("button", { name: "Yes, merge it" }).waitFor();
  ok(await panel.getByRole("textbox", { name: /Tell the agent what to change/ }).isVisible(), "a wide page always shows the note field");
  // Send back with a note.
  await panel.getByRole("textbox", { name: /Tell the agent what to change/ }).fill("Keep the old name of the function.");
  await panel.getByRole("button", { name: "Send back", exact: true }).click();
  await page.locator(".approve__outcome").waitFor({ timeout: 4000 });
  const sent = await answers();
  ok(sent.length === 1 && sameJson(sent[0].body, { approvalId: "ap_c1", answer: "send-back", note: "Keep the old name of the function." }), `Send back names the question and carries the note (${JSON.stringify(sent[0]?.body)})`);
  const outcome = (await page.locator(".approve__outcome").innerText()).replace(/\s+/g, " ");
  ok(outcome.includes("Sent back") && outcome.includes("You sent this work back now.") && outcome.includes("A built-in agent does the task again and reads the note.") && outcome.includes("Keep the old name of the function."), `the result shows the note (${outcome})`);
  ok(await page.locator(".approve__crumbs").getByText("Sent back", { exact: true }).isVisible(), "the pill says Sent back");
  await page.waitForTimeout(2200);
  ok(!(await toastTitles(page)).includes("A decision needs you"), "no toast says that the work could not merge");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  // Another person answers while the page is open: the page shows it at once.
  await page.goto(`${BASE}/approve/at_b1?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).waitFor();
  await control("attempt", { id: "at_b1", patch: { status: "underway", approval: { status: "sent-back", answer: { by: { id: "u_2", name: "Sam" }, how: "app", note: "Add a test first.", at: Date.now() } } } });
  await page.locator(".approve__outcome").waitFor({ timeout: 4000 });
  const outcome = (await page.locator(".approve__outcome").innerText()).replace(/\s+/g, " ");
  ok(outcome.includes("Already answered by Sam.") && outcome.includes("Sam sent this work back") && outcome.includes("The agent changes the work and submits again.") && outcome.includes("Add a test first."), `an answer of another person shows in place (${outcome})`);
  ok((await page.locator('.approve .vh[role="status"]').textContent())?.startsWith("Sent back."), "and a screen reader hears it");

  // The question closes: the agent stopped.
  await control("attempt", { id: "at_c1", patch: { status: "abandoned", approval: { status: "withdrawn", closed: "The work copy stopped." } } });
  await page.goto(`${BASE}/approve/at_c1?project=shop`, { waitUntil: "networkidle" });
  const closed = (await page.locator(".approve__outcome").innerText()).replace(/\s+/g, " ");
  ok(closed.includes("This question is closed") && closed.includes("The work copy stopped."), `a closed question says why (${closed})`);
  ok((await page.locator(".approve__panel").getByRole("button", { name: /Yes|Send back/ }).count()) === 0, "a closed question has no answer button");

  // The agent changes the work after the page opened, and the Worker asked again. The page learns that from the answer.
  await page.goto(`${BASE}/approve/at_s2?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).waitFor();
  await control("attempt", { id: "at_s2", quiet: true, patch: { approval: { id: "ap_s2b", digest: "dg_ap_s2b", askedAt: Date.now() } } });
  await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).click();
  await page.locator(".approve__notice").waitFor({ timeout: 4000 });
  const sent = await answers();
  ok(sent.length === 1 && sameJson(sent[0].body, { approvalId: "ap_s2", answer: "approve" }), "the old question gets no yes: the request names the old question");
  ok((await page.locator(".approve__notice").textContent())?.includes("This question is old. The work changed, and gitring asked again."), "the page says that the question is old");
  ok(await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).isVisible(), "the answer buttons stay: nothing was answered");
  // The live connection brings the new question. The next yes names it.
  await control("attempt", { id: "at_s2", patch: { approval: { id: "ap_s2b" } } });
  await page.waitForFunction(() => document.querySelector(".approve__notice")?.textContent?.includes("The new question is below."), null, { timeout: 4000 });
  ok(true, "the live update changes the notice: the new question is below");
  await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).click();
  await page.locator(".approve__outcome").waitFor({ timeout: 4000 });
  const again = await answers();
  ok(again.length === 2 && sameJson(again[1].body, { approvalId: "ap_s2b", answer: "approve" }), "after the live update the yes names the new question");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}
{
  // The hourly test budget is used: the yes counts, and the merge waits.
  await reset();
  await control("land", { mode: "wait" });
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/approve/at_c1?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).click();
  await page.locator(".approve__outcome").waitFor({ timeout: 4000 });
  const outcome = (await page.locator(".approve__outcome").innerText()).replace(/\s+/g, " ");
  ok(outcome.includes("Approved. The merge waits.") && outcome.includes("The test budget for this hour is used."), `a merge that waits says so (${outcome})`);
  ok(await page.locator(".approve__crumbs").getByText("Approved", { exact: true }).isVisible(), "the pill says Approved");
  ok((await page.locator(".b-toast").count()) === 0, "no toast: the page shows it");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── the approve page for a person who may not answer, and a long change ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/approve/at_k1?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".b-diff__file").first().waitFor();
  const panel = page.locator(".approve__panel");
  ok((await panel.innerText()).includes("Only Sam (who sent the agent) or an owner of the project can answer this."), "the page says who may answer");
  ok((await panel.getByRole("button").count()) === 0 && (await panel.getByRole("textbox").count()) === 0, "a person who may not answer sees no button and no field");
  ok(/Sent by Sam/.test(await page.locator(".approve__meta").innerText()), "the page names the sender");
  ok((await page.locator(".b-diff__file").count()) === 7 && (await page.locator(".b-diff__scroll").count()) === 1, "a change of 7 files opens the first file only");
  ok(await page.getByText("Build or deploy files change: package.json.").isVisible(), "the reason shows");
  await page.getByRole("button", { name: "Expand src/index.js" }).click();
  ok((await page.locator(".b-diff__scroll").count()) === 2, "a person can open the other files");
  ok((await page.locator("section", { has: page.getByRole("heading", { name: "Other work copies of this task" }) }).count()) === 0, "a task with one work copy has no list of other work copies");
  await noOverflow(page, "approve page of Sam's work at 1280");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── a visitor who is not signed in ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820, { signedIn: false });
  await page.goto(`${BASE}/approve/at_c1?project=shop`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Your answer" }).waitFor();
  ok(await page.getByText("Round the price in the cart").first().isVisible(), "a visitor reads the question of a project that they can view");
  ok(await page.locator(".approve__panel").getByText("Sign in to answer.").isVisible(), "the answer panel asks them to sign in");
  ok((await page.locator(".approve__panel").getByRole("button", { name: /Yes|Send back/ }).count()) === 0, "a visitor has no answer button");
  ok((await trayOf(page).count()) === 0, "a visitor has no tray");
  await noOverflow(page, "approve page of a visitor at 1280");
  await page.locator(".approve__panel").getByRole("link", { name: "Continue with GitHub" }).click();
  await page.waitForURL(/\/approve\/at_c1\?project=shop/);
  await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).waitFor({ timeout: 4000 });
  ok(page.url().includes("/approve/at_c1?project=shop"), "after the sign-in the visitor is on the same page");
  ok(await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).isEnabled(), "and can answer");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}
{
  // A project that a visitor cannot open: the page asks them to sign in, and the sign-in brings them back to this page.
  await reset();
  await control("private", { on: true });
  const { ctx, page, errors } = await open(1280, 820, { signedIn: false });
  await page.goto(`${BASE}/approve/at_c1?project=shop`, { waitUntil: "networkidle" });
  const signIn = page.locator("#main").getByRole("button", { name: "Sign in" });
  await signIn.waitFor();
  ok(await page.getByText("Sign in to open this project.").first().isVisible(), "a private project says why the page is empty");
  await signIn.click();
  const dlg = page.getByRole("dialog", { name: "Sign in to gitring" });
  await dlg.waitFor();
  ok(await dlg.getByText("Sign in to answer.").isVisible(), "the sign-in panel says why");
  await dlg.getByRole("link", { name: "Continue with GitHub" }).click();
  await page.waitForURL(/\/approve\/at_c1\?project=shop/);
  await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).waitFor({ timeout: 4000 });
  ok(true, "after the sign-in the same page opens, with the answer");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── an address that does not exist ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/approve/at_nope?project=shop`, { waitUntil: "networkidle" });
  ok((await page.locator("#main h1").textContent()) === "Work copy not found", "an unknown id says that the work copy is not found");
  ok(await page.getByText("This work copy is not in this project.").isVisible(), "and says it in one sentence");
  await page.getByRole("link", { name: "Open the tasks" }).click();
  await page.waitForURL(/\/tasks/);
  ok(true, "and leads to the tasks");
  await page.goto(`${BASE}/approve?project=shop`, { waitUntil: "networkidle" });
  ok(await page.getByText("This page does not exist.").isVisible(), "an address without an id is not a page");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── the keyboard ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(1280, 820);
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  const chip = chipOf(page, "at_b1");
  await chip.waitFor();
  // From Review of a chip: Tab reaches Yes, then Send back…; Enter opens the note; Ctrl+Enter sends it.
  await chip.getByRole("link", { name: "Review" }).focus();
  await page.keyboard.press("Tab");
  ok((await focused(page)) === "Yes, merge", `Tab goes from Review to Yes, merge (${await focused(page)})`);
  await page.keyboard.press("Tab");
  ok((await focused(page)) === "Send back…", "and then to Send back…");
  await page.keyboard.press("Enter");
  const note = chip.getByRole("textbox");
  ok(await note.evaluate((el) => el === document.activeElement), "Enter opens the note with focus in it");
  await page.keyboard.type("Add a test.");
  await page.keyboard.press("Control+Enter");
  await chip.waitFor({ state: "detached", timeout: 4000 });
  let sent = await answers();
  ok(sent.length === 1 && sameJson(sent[0].body, { approvalId: "ap_b1", answer: "send-back", note: "Add a test." }), `Ctrl+Enter sends the note from the keyboard (${JSON.stringify(sent[0]?.body)})`);

  // The decisions list: open it with Enter, say yes with the keyboard.
  await page.locator(".topbar__queue").focus();
  await page.keyboard.press("Enter");
  const pop = page.getByRole("dialog", { name: "Decisions" });
  await pop.waitFor();
  ok((await focused(page)) === "Review" && (await focusedAttempt(page)) === "at_s1", "the list opens with focus on Review, which is safe to press");
  await page.keyboard.press("Tab");
  ok((await focused(page)) === "Yes, merge", "Tab reaches Yes, merge");
  await page.keyboard.press("Enter");
  await page.locator(".b-toast__title", { hasText: /^Merged into main/ }).waitFor({ timeout: 4000 });
  sent = await answers();
  ok(sent.length === 2 && sameJson(sent[1].body, { approvalId: "ap_s1", answer: "approve" }), "Enter on Yes, merge sends the yes");
  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "detached" });
  ok(true, "Escape closes the list: no focus trap");

  // The approve page: skip control, the answer, Ctrl+Enter in the note.
  await page.goto(`${BASE}/approve/at_c1?project=shop`, { waitUntil: "networkidle" });
  await page.locator("#main h1").waitFor();
  ok((await page.evaluate(() => document.activeElement?.tagName)) !== "TEXTAREA", "the note field does not take focus by itself on a wide page");
  await page.getByRole("button", { name: "Go to your answer" }).focus();
  await page.keyboard.press("Enter");
  ok(await page.evaluate(() => document.activeElement?.id === "approve-answer"), "Go to your answer moves focus to the answer");
  await page.keyboard.press("Tab");
  ok((await focused(page)) === "Yes, merge it", "Tab reaches Yes, merge it");
  await page.keyboard.press("Tab");
  ok(await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), "then the note field");
  await page.keyboard.type("Use two decimals.");
  await page.keyboard.press("Control+Enter");
  await page.locator(".approve__outcome").waitFor({ timeout: 4000 });
  sent = await answers();
  ok(sameJson(sent[2].body, { approvalId: "ap_c1", answer: "send-back", note: "Use two decimals." }), "Ctrl+Enter in the note sends the work back");
  ok(await page.locator(".approve__outcome").evaluate((el) => el === document.activeElement), "focus moves to the result");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── a phone ───────────── */
{
  await reset();
  const { ctx, page, errors } = await open(375, 760);
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  const tray = trayOf(page);
  await tray.waitFor();
  ok((await tray.locator(".apcard").count()) === 2 && (await tray.getByRole("button", { name: /\+2 more/ }).count()) === 1, "a phone shows 2 chips and +2 more");
  await noOverflow(page, "overview with the tray at 375");
  const trayBox = await tray.boundingBox();
  const nav = await page.locator(".bottomnav").boundingBox();
  ok(trayBox && nav && trayBox.y + trayBox.height <= nav.y + 1, "the tray sits above the bottom bar");
  ok(trayBox && trayBox.x >= 0 && trayBox.x + trayBox.width <= 375, "the tray is inside the screen");
  // The note opens inside the chip and the tray stays on the screen.
  await chipOf(page, "at_b1").getByRole("button", { name: "Send back…" }).click();
  const grown = await tray.boundingBox();
  ok(grown && grown.y >= 0 && grown.y + grown.height <= nav.y + 1, "with the note open the tray still fits above the bottom bar");
  await noOverflow(page, "overview with a note open at 375");
  await page.keyboard.press("Escape");

  // The toast goes above the tray.
  await chipOf(page, "at_c1").getByRole("button", { name: "Yes, merge" }).click();
  await page.locator(".b-toast").first().waitFor({ timeout: 4000 });
  await page.waitForTimeout(400);
  const toast = await page.locator(".b-toast").first().boundingBox();
  const tray2 = await tray.boundingBox();
  ok(toast && tray2 && toast.y + toast.height <= tray2.y + 1, "a toast sits above the tray");
  await noOverflow(page, "overview with a toast at 375");

  // The decisions list is a sheet.
  await page.locator(".topbar__queue").click();
  await page.getByRole("dialog", { name: "Decisions" }).waitFor();
  ok((await page.locator(".b-pop[data-sheet]").count()) === 1, "the decisions list is a sheet on a phone");
  await noOverflow(page, "decisions list at 375");
  await page.keyboard.press("Escape");

  // The approve page: one column, and the answer is a bar above the bottom bar.
  await page.goto(`${BASE}/approve/at_s1?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".b-diff__file").first().waitFor();
  await noOverflow(page, "approve page at 375");
  ok(!(await trayOf(page).isVisible().catch(() => false)), "the tray steps aside on the approve page of a phone");
  const panel = page.locator(".approve__panel");
  const pb = await panel.boundingBox();
  const nb = await page.locator(".bottomnav").boundingBox();
  ok(pb && nb && pb.y + pb.height <= nb.y + 1 && pb.y > 300, "the answer is a bar above the bottom bar");
  ok(await panel.getByRole("button", { name: "Yes, merge it" }).isVisible(), "the yes is in view without scrolling");
  ok((await panel.getByRole("textbox").count()) === 0, "the note field is closed until the person asks for it");
  await panel.getByRole("button", { name: "Send back…" }).click();
  ok(await panel.getByRole("textbox").evaluate((el) => el === document.activeElement), "Send back… opens the note with focus");
  await noOverflow(page, "approve page with a note at 375");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  ok((await panel.getByRole("textbox").count()) === 0 && (await focused(page)) === "Send back…", "Escape closes the note and focus returns to Send back…");
  await panel.getByRole("button", { name: "Yes, merge it" }).click();
  await page.locator(".approve__outcome").waitFor({ timeout: 4000 });
  const ob = await panel.boundingBox();
  ok(ob && ob.y + ob.height <= nb.y + 1 && ob.y > 250, "the result stays above the bottom bar");
  await noOverflow(page, "approve page with the result at 375");
  // The page of a person who may not answer.
  await page.goto(`${BASE}/approve/at_k1?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".b-diff__file").first().waitFor();
  await noOverflow(page, "approve page of Sam's work at 375");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── windows of other sizes ───────────── */
{
  // A tablet: the approve page has one column and a bar for the answer, so the tray steps aside there.
  await reset();
  let { ctx, page, errors } = await open(800, 700);
  await page.goto(`${BASE}/approve/at_s1?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".b-diff__file").first().waitFor();
  ok(!(await trayOf(page).isVisible().catch(() => false)), "800 px: the tray steps aside on the approve page");
  const bar = await page.locator(".approve__panel").boundingBox();
  ok(bar && bar.y + bar.height <= 701 && bar.y > 400, "800 px: the answer is a bar at the bottom of the screen");
  ok(await page.locator(".approve__panel").getByRole("button", { name: "Yes, merge it" }).isVisible(), "800 px: the yes is in view without scrolling");
  ok((await page.locator(".topbar__queue").textContent())?.includes("4"), "800 px: the decisions button keeps the count");
  await noOverflow(page, "approve page at 800");
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  await trayOf(page).waitFor();
  ok((await trayOf(page).locator(".apcard").count()) === 3, "800 px: the overview shows 3 chips");
  await ctx.close();

  // A small laptop: the one-line tray stays in the corner and does not cover the answer.
  ({ ctx, page } = await open(1000, 700));
  await page.goto(`${BASE}/approve/at_s1?project=shop`, { waitUntil: "networkidle" });
  await page.locator(".b-diff__file").first().waitFor();
  const line = trayOf(page);
  ok(await line.isVisible(), "1000 px: the one-line tray shows on the approve page");
  const side = await page.locator(".approve__panel").boundingBox();
  const lineBox = await line.boundingBox();
  ok(side && lineBox && (side.y + side.height <= lineBox.y || side.x + side.width <= lineBox.x), "1000 px: the tray does not cover the answer");
  await noOverflow(page, "approve page at 1000");
  await ctx.close();

  // A wide window that is low: fewer chips, so that none of them leaves the screen.
  ({ ctx, page } = await open(1280, 500));
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  await trayOf(page).waitFor();
  ok((await trayOf(page).locator(".apcard").count()) === 2 && (await trayOf(page).getByRole("button", { name: /\+2 more/ }).count()) === 1, "1280x500: 2 chips and +2 more");
  const low = await trayOf(page).boundingBox();
  ok(low && low.y >= 0 && low.y + low.height <= 500, "1280x500: the tray is inside the screen");
  await ctx.close();

  // A phone on its side: one chip. A note that opens in the chip stays inside the screen.
  ({ ctx, page, errors } = await open(667, 375));
  await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
  await trayOf(page).waitFor();
  ok((await trayOf(page).locator(".apcard").count()) === 1 && (await trayOf(page).getByRole("button", { name: /\+3 more/ }).count()) === 1, "667x375: 1 chip and +3 more");
  const flat = await trayOf(page).boundingBox();
  ok(flat && flat.y >= 0 && flat.y + flat.height <= 375 && flat.x >= 0 && flat.x + flat.width <= 667, "667x375: the tray is inside the screen");
  await trayOf(page).locator(".apcard").getByRole("button", { name: "Send back…" }).click();
  const open375 = await trayOf(page).boundingBox();
  ok(open375 && open375.y >= 0 && open375.y + open375.height <= 375, "667x375: with the note open the tray is still inside the screen");
  await noOverflow(page, "overview at 667x375");
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await ctx.close();
}

/* ───────────── reduced motion ───────────── */
{
  for (const [motion, expected] of [
    ["no-preference", "aptray-in"],
    ["reduce", "none"],
  ]) {
    await reset();
    const { ctx, page } = await open(1280, 820, { reducedMotion: motion });
    await page.goto(`${BASE}/overview?project=shop`, { waitUntil: "networkidle" });
    const chip = trayOf(page).locator(".aptray__item").first();
    await chip.waitFor();
    const name = await chip.evaluate((el) => getComputedStyle(el).animationName);
    ok(name === expected, `${motion}: the chips animate as "${expected}" (${name})`);
    await ctx.close();
  }
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
