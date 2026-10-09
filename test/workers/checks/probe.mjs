#!/usr/bin/env node
// Assertions against a running probe Worker (see wrangler.jsonc in this folder).
//   node test/workers/checks/probe.mjs [http://localhost:8790]
// Exit code 1 if an assertion fails.
const base = (process.argv[2] ?? "http://localhost:8790").replace(/\/$/, "");
let failures = 0;

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
const seed = await checks("seed");
check(`seed: app tests pass (${summary(seed)})`, seed.ok && seed.passed === 6 && !seed.error);

const all = await checks("seed+checks");
const appOk = all.cases.filter((c) => c.file === "tests/app.test.js").every((c) => c.ok);
const intentFiles = new Set(failing(all).map((c) => c.file));
check(`seed + 5 intent checks: app passes, every intent check fails (${summary(all)})`, !all.ok && !all.error && appOk && intentFiles.size === 5, [...intentFiles].join(", "));

for (const slug of ["currency", "dark-mode", "search", "staff-picks", "api-item"]) {
  const run = await checks(`solution:${slug}`);
  check(`solution ${slug} alone: app + own check pass (${summary(run)})`, run.ok && run.failed === 0, JSON.stringify(failing(run)));
}
for (const slug of ["search", "staff-picks"]) {
  const run = await checks(`adapted:${slug}`);
  check(`adapted ${slug} on seed + currency: all pass (${summary(run)})`, run.ok && run.failed === 0, JSON.stringify(failing(run)));
}

const landed = await checks("landed");
check(`landed tree (validated order): all 6 files, 39 tests pass (${summary(landed)})`, landed.ok && landed.passed === 39 && landed.testPaths.length === 6, JSON.stringify(failing(landed)));

const noHarness = await checks("no-harness");
check(`no harness/test.js: Bearing injects its harness (${summary(noHarness)})`, noHarness.ok && noHarness.passed === 6);

const brokenTest = await checks("broken-test");
check(
  `syntax error in one test file: error + the other files still run (${summary(brokenTest)})`,
  !brokenTest.ok && /SyntaxError/.test(brokenTest.error ?? "") && brokenTest.passed === 6 && failing(brokenTest).length === 1 && failing(brokenTest)[0].file === "tests/broken.test.js",
  JSON.stringify(brokenTest.cases),
);

const brokenSrc = await checks("broken-src");
check(`syntax error in src/render.js: runner error at src/render.js (${summary(brokenSrc)})`, !brokenSrc.ok && /src\/render\.js/.test(brokenSrc.error ?? "") && brokenSrc.passed === 0);

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

const home = await preview("/preview/seed/");
check(`preview seed: 200 HTML page with the shop name, x-bearing-preview set`, home.status === 200 && home.text.includes("Saltmarsh Books") && /text\/html/.test(home.headers.get("content-type")) && !!home.headers.get("x-bearing-preview"));

const searched = await preview("/preview/landed/?q=tide&currency=EUR");
check(`preview landed ?q=tide&currency=EUR: filtered list in euros`, searched.text.includes("€18.39") && searched.text.includes("A Small Book of Tides") && !searched.text.includes("Knots for Small Boats"));

const dark = await preview("/preview/landed/");
check(`preview landed: dark mode toggle, search form, currency links, staff pick badges`, dark.text.includes('class="theme-toggle"') && dark.text.includes('role="search"') && dark.text.includes("currency=INR") && (dark.text.match(/Staff pick/g) ?? []).length === 3);

const item = await preview("/preview/landed/api/products/3");
check(`preview landed /api/products/3: JSON of book 3`, item.status === 200 && JSON.parse(item.text).id === 3);

const missing = await preview("/preview/landed/api/products/99");
check(`preview landed /api/products/99: 404 JSON`, missing.status === 404 && typeof JSON.parse(missing.text).error === "string");

const bare = await preview("/preview/landed?currency=INR");
check(`bare prefix redirects to the prefix with a slash`, bare.status === 302 && bare.headers.get("location") === "/preview/landed/?currency=INR", `${bare.status} ${bare.headers.get("location")}`);

const thrown = await preview("/preview/app-throws/");
check(`app that throws: friendly 500 page, message escaped`, thrown.status === 500 && thrown.text.includes("The preview did not start.") && thrown.text.includes("The &lt;shop&gt; is closed &amp; locked"), thrown.text.slice(0, 300));

const syntax = await preview("/preview/app-syntax/");
check(`app with a syntax error: friendly 500 page with the SyntaxError`, syntax.status === 500 && /SyntaxError/.test(syntax.text), syntax.text.slice(0, 300));

console.log(failures ? `\n${failures} assertion(s) failed` : "\nall assertions passed");
process.exitCode = failures ? 1 : 0;
