/**
 * The steps of the shop story: one agent starts the shop, two agents change one function, and a person decides.
 * Called by runMeet in scripts/meet.mjs. Each step prints what the agents say and read, with the tools of the real server.
 * Never skip the waits: each step needs the merge of the step before. Read next: meet-story.mjs, meet-files.mjs.
 */
import { BOTH, CART_EUROS, COMMAS, EUROS, FREE, PRICE_TEST, read, T_COMMAS, T_EUROS, T_FREE } from "./meet-files.mjs";
import { sleep, Stop } from "./meet-story.mjs";

// ───── 1. One agent starts the shop ─────

/** Agent S writes the first files and waits for the first merge. */
export async function startTheShop({ title, agent, attemptOf, waitFor, merged }) {
  title("One agent starts the shop");
  const starter = await agent("Agent S");
  const seed = await starter.call(
    "gitring_declare",
    {
      newIntent: { title: "Start the shop", goal: "The shop has a price function and a cart, with tests." },
      plan: ["Add price.js and cart.js with their tests"],
      files: ["src/price.js", "src/cart.js", "tests/price.test.js", "tests/cart.test.js"],
      symbols: [],
      approach: "New files.",
      agent: { id: "meet-starter", client: "script", model: "script" },
    },
    "the plan",
  );
  const seedId = attemptOf(seed);
  await starter.call("gitring_write", { attemptId: seedId, files: ["src/price.js", "src/cart.js", "tests/price.test.js", "tests/cart.test.js"].map((path) => ({ path, content: read(path) })) }, "four files");
  await starter.call("gitring_submit", { attemptId: seedId, summary: "Start the shop" }, "the work is ready");
  await waitFor(merged(seedId), "the first merge");
}

// ───── 2. Two agents, one function ─────

/** Agent A and Agent B change the same function. Agent B gets a change request, and Agent A merges first. */
export async function twoAgentsChangeOneFunction({ title, agent, attemptOf, waitFor, merged, openOf }) {
  title("Two agents change the same function");
  const a = await agent("Agent A (Claude Code)");
  const b = await agent("Agent B (Cursor)");
  const planA = await a.call(
    "gitring_declare",
    {
      newIntent: { title: "Show thousands separators in prices", goal: "A price of 123456 cents shows as $1,234.56." },
      plan: ["Change formatPrice to add commas to the dollars", "Add a test"],
      files: ["src/price.js", "tests/price.test.js"],
      symbols: ["src/price.js#formatPrice"],
      approach: "Edit the return line of formatPrice.",
      agent: { id: "meet-claude-code", client: "claude-code", model: "claude" },
    },
    "the plan names formatPrice",
  );
  const idA = attemptOf(planA);
  const planB = await b.call(
    "gitring_declare",
    {
      newIntent: { title: "Show Free for a price of zero", goal: "formatPrice(0) shows Free." },
      plan: ["Change formatPrice: when the price is 0, return Free", "Add a test"],
      files: ["src/price.js", "tests/price.test.js"],
      symbols: ["src/price.js#formatPrice"],
      approach: "Add a check at the top of formatPrice.",
      agent: { id: "meet-cursor", client: "cursor", model: "gpt" },
    },
    "the plan names the same function",
  );
  const idB = attemptOf(planB);
  await a.call("gitring_write", { attemptId: idA, files: [{ path: "src/price.js", content: COMMAS }, { path: "tests/price.test.js", content: PRICE_TEST() + T_COMMAS }] }, "the commas");
  const wroteB = await b.call("gitring_write", { attemptId: idB, files: [{ path: "src/price.js", content: FREE }, { path: "tests/price.test.js", content: PRICE_TEST() + T_FREE }] }, "the Free check, on the same lines");
  // The answer of the write can replace the change request of the plan: Agent B confirms the ones that are open.
  const got = new Set([...(planB.text.matchAll(/\[(cr_\w+)\]/g) ?? []), ...(wroteB.text.matchAll(/\[(cr_\w+)\]/g) ?? [])].map((m) => m[1]));
  for (const id of (await openOf(idB)).filter((x) => got.has(x))) {
    await b.call("gitring_ack", { attemptId: idB, correctionId: id, note: "Applied. I wait for Agent A, then I change formatPrice again on the new main." }, `confirm ${id}`);
  }
  await b.call("gitring_traffic", { attemptId: idB }, "who works near me?");
  await a.call("gitring_check", { attemptId: idA }, "the tests");
  await a.call("gitring_submit", { attemptId: idA, summary: "Prices show commas: $1,234.56" }, "the work is ready");
  await waitFor(merged(idA), "the merge of Agent A");
  return { b, idB };
}

/** Agent B takes the new main, applies both changes and merges after Agent A. */
export async function theSecondAgentWorksOnTheNewMain({ title, waitFor, merged, openOf }, b, idB) {
  title("The second agent works on the new main");
  await b.call("gitring_status", { attemptId: idB }, "where is my work copy?");
  await b.call("gitring_update", { attemptId: idB }, "take the new main");
  await b.call("gitring_read", { attemptId: idB, path: "src/price.js" }, "read the new text");
  await b.call("gitring_read", { attemptId: idB, path: "tests/price.test.js" }, "read the new test");
  await b.call("gitring_write", { attemptId: idB, files: [{ path: "src/price.js", content: BOTH }, { path: "tests/price.test.js", content: PRICE_TEST() + T_COMMAS + T_FREE }] }, "both changes, on the new text");
  // gitring checks the code at each confirmation. Agent B applied the change requests now: it confirms the open ones.
  for (const id of await openOf(idB)) await b.call("gitring_ack", { attemptId: idB, correctionId: id, note: "Both changes are on the new main." }, `confirm ${id}`);
  await b.call("gitring_check", { attemptId: idB }, "the tests");
  await b.call("gitring_submit", { attemptId: idB, summary: "formatPrice(0) shows Free" }, "the work is ready");
  await waitFor(merged(idB), "the merge of Agent B");
}

// ───── 3. A change that needs a person ─────

/** Agent C changes two signatures. A person must say yes. The script waits for the answer, at most `waitSec` seconds. */
export async function aPersonMustSayYes({ out, title, agent, attemptOf, state, status, pollMs }, result, waitSec) {
  title("A change that needs a person");
  const c = await agent("Agent C (Codex)");
  const planC = await c.call(
    "gitring_declare",
    {
      newIntent: { title: "Show euros in the EU", goal: "formatPrice takes a currency." },
      plan: ["Change formatPrice to take a currency", "Change cartTotal to pass the currency", "Add a test"],
      files: ["src/price.js", "src/cart.js", "tests/price.test.js"],
      symbols: ["src/price.js#formatPrice(cents, currency)", "src/cart.js#cartTotal(items, currency)"],
      approach: "Add a second parameter with a default.",
      agent: { id: "meet-codex", client: "codex", model: "gpt" },
    },
    "the plan changes two signatures",
  );
  const idC = attemptOf(planC);
  await c.call(
    "gitring_write",
    { attemptId: idC, files: [{ path: "src/price.js", content: EUROS }, { path: "src/cart.js", content: CART_EUROS }, { path: "tests/price.test.js", content: PRICE_TEST() + T_COMMAS + T_FREE + T_EUROS }] },
    "the currency",
  );
  const sent = await c.call("gitring_submit", { attemptId: idC, summary: "formatPrice takes a currency" }, "the work is ready");
  if (!/A PERSON MUST SAY YES/.test(sent.text)) throw new Stop("gitring did not ask for a person. The project may allow work without a question (Settings → Merging).");
  out("A person must say yes. Open the link above in your browser, sign in, and choose Yes, merge.");
  out("A key cannot say yes. Only a person who is signed in can.");
  result.waiting = true;
  const until = Date.now() + waitSec * 1000;
  let answered = waitSec === 0 ? false : null;
  while (answered === null) {
    const st = await state();
    const s = status(st, idC);
    if (s === "landed") answered = "yes";
    else if (s && !["judging", "ready", "landing"].includes(s)) answered = s;
    else if (Date.now() > until) answered = false;
    else await sleep(Math.max(pollMs, 1500));
  }
  if (answered === "yes") {
    result.waiting = false;
    const done = await c.call("gitring_status", { attemptId: idC }, "what did the person say?");
    out(done.text.includes("merged") ? "The person said yes. The work merged." : "The person answered.");
  } else if (answered === false) {
    out(waitSec === 0 ? "The script does not wait (--wait 0). The work still waits for a person." : `Nobody answered in ${waitSec} seconds. The work still waits for a person.`);
  } else {
    result.waiting = false;
    out(`The work is now ${answered}.`);
  }
}
