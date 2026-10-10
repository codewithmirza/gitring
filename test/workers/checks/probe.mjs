#!/usr/bin/env node
// Assertions against a running probe Worker (see wrangler.jsonc in this folder).
//   node test/workers/checks/probe.mjs [http://localhost:8790]
// Exit code 1 if an assertion fails.
const base = (process.argv[2] ?? "http://localhost:8790").replace(/\/$/, "");
let failures = 0;

// tests/greet.test.js of the greeter registers this many tests (GREETER_TEST_COUNT in test/checks/greeter.ts).
const GREETER_TESTS = 4;

function check(label, condition, detail = "") {
  console.log(`${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : `\n      ${detail}`}`);
  if (!condition) failures += 1;
}

async function checks(scenario, timeoutMs) {
  const query = new URLSearchParams({ scenario, ...(timeoutMs ? { timeoutMs: String(timeoutMs) } : {}) });
  const res = await fetch(`${base}/run-checks?${query}`);
  return res.json();
}

const summary = (run) => `ok=${run.ok} passed=${run.passed} failed=${run.failed} ms=${run.ms}${run.error ? ` error=${JSON.stringify(run.error)}` : ""}`;
const failing = (run) => run.cases.filter((c) => !c.ok);

// ── check runner ──
const greeter = await checks("greeter");
check(`greeter has no harness/test.js: gitring injects its harness, the app tests pass (${summary(greeter)})`, greeter.ok && greeter.passed === GREETER_TESTS && !greeter.error);

const ownHarness = await checks("own-harness");
check(`greeter with its own harness/test.js: the repo's copy runs the tests (${summary(ownHarness)})`, ownHarness.ok && ownHarness.passed === GREETER_TESTS && !ownHarness.error);

const brokenTest = await checks("broken-test");
check(
  `syntax error in one test file: error + the other files still run (${summary(brokenTest)})`,
  !brokenTest.ok && /SyntaxError/.test(brokenTest.error ?? "") && brokenTest.passed === GREETER_TESTS && failing(brokenTest).length === 1 && failing(brokenTest)[0].file === "tests/broken.test.js",
  JSON.stringify(brokenTest.cases),
);

const brokenSrc = await checks("broken-src");
check(`syntax error in src/greet.js: runner error at src/greet.js (${summary(brokenSrc)})`, !brokenSrc.ok && /src\/greet\.js/.test(brokenSrc.error ?? "") && brokenSrc.passed === 0);

const hang = await checks("hang");
const never = hang.cases.find((c) => c.name === "never ends");
const still = hang.cases.find((c) => c.name === "still runs");
check(`a test that never ends times out in the harness, the next test runs (${summary(hang)})`, !hang.error && never && !never.ok && /TimeoutError/.test(never.error) && still?.ok === true);

const net = await checks("net");
const netCase = net.cases.find((c) => c.name === "no network");
check(`globalOutbound: null blocks fetch() in checks`, netCase && !netCase.ok && /not permitted to access the internet/.test(netCase.error), netCase?.error);

// ── previews ──
async function preview(path, init) {
  const res = await fetch(`${base}${path}`, { redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const home = await preview("/preview/greeter/");
check(`preview greeter: 200 HTML page with the greeting, x-gitring-preview set`, home.status === 200 && home.text.includes("Hello, world!") && /text\/html/.test(home.headers.get("content-type")) && !!home.headers.get("x-gitring-preview"));

const named = await preview("/preview/greeter/?name=Ada&greeting=Hey");
check(`preview greeter ?name=Ada&greeting=Hey: the query string reaches the app`, named.text.includes("Hey, Ada!") && !named.text.includes("Hello, world!"));

const item = await preview("/preview/greeter/api/greetings/1");
check(`preview greeter /api/greetings/1: JSON of one greeting`, item.status === 200 && JSON.parse(item.text).greeting === "Hi");

const missing = await preview("/preview/greeter/api/greetings/99");
check(`preview greeter /api/greetings/99: 404 JSON`, missing.status === 404 && typeof JSON.parse(missing.text).error === "string");

const bare = await preview("/preview/greeter?greeting=Hi");
check(`bare prefix redirects to the prefix with a slash`, bare.status === 302 && bare.headers.get("location") === "/preview/greeter/?greeting=Hi", `${bare.status} ${bare.headers.get("location")}`);

const thrown = await preview("/preview/app-throws/");
check(`app that throws: friendly 500 page, message escaped`, thrown.status === 500 && thrown.text.includes("The preview did not start.") && thrown.text.includes("The &lt;greeter&gt; is closed &amp; locked"), thrown.text.slice(0, 300));

const syntax = await preview("/preview/app-syntax/");
check(`app with a syntax error: friendly 500 page with the SyntaxError`, syntax.status === 500 && /SyntaxError/.test(syntax.text), syntax.text.slice(0, 300));

console.log(failures ? `\n${failures} assertion(s) failed` : "\nall assertions passed");
process.exitCode = failures ? 1 : 0;
