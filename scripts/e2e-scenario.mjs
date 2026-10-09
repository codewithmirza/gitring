#!/usr/bin/env node
/**
 * End-to-end run of the demo scenario with scripted vessels, against a running Bearing (default: the
 * offline dev server). Five colliding intents; dark mode is a best-of-2 that a human picks.
 * Exit code 1 when a check fails.
 *
 *   npm run dev:offline &   then   node scripts/e2e-scenario.mjs
 */
const base = process.env.BEARING_URL ?? "http://127.0.0.1:5173";
const project = process.env.BEARING_PROJECT ?? `scn-${Date.now().toString(36)}`;
const api = (p, body) =>
  fetch(`${base}/api/projects/${project}${p}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined).then((r) => r.json());
let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed += 1;
};
await api("/demo/reset", {});
const run = await api("/demo/run", { scenario: "collisions", mode: "scripted" });
ok(run.launched?.length === 5, `scenario launches 5 intents (${run.launched?.reduce((n, l) => n + l.attempts.length, 0)} vessels)`);
let st;
const t0 = Date.now();
for (;;) {
  st = await api("/state");
  const dark = st.intents.find((i) => /dark/i.test(i.title));
  const others = st.intents.filter((i) => i !== dark);
  if (others.every((i) => i.status === "landed") && st.attempts.filter((a) => a.intentId === dark.id && a.status === "ready").length === 2) break;
  if (Date.now() - t0 > 150_000) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const dark = st.intents.find((i) => /dark/i.test(i.title));
ok(st.intents.filter((i) => i !== dark).every((i) => i.status === "landed"), "the four other intents land");
ok(st.attempts.filter((a) => a.intentId === dark.id && a.status === "ready").length === 2, "dark mode: two ready attempts wait for a human pick");
ok(st.stats.humanMergeFixes === 0, "human merge fixes: 0");
ok((st.stats.replots ?? 0) > 0, `Bearing re-plots work in progress (${st.stats.replots})`);
ok(st.stats.corrections > 0, `course checks send corrections (${st.stats.corrections})`);
const pick = st.attempts.find((a) => a.intentId === dark.id && a.status === "ready");
const landed = await api(`/attempts/${pick.id}/land`, { rationale: "The toggle sits at the end of the nav." });
ok(landed.status === "landed", `the human pick lands (${landed.landing?.method ?? landed.message})`);
st = await api("/state");
ok(st.intents.every((i) => i.status === "landed"), "all five intents are on main");
ok(st.attempts.filter((a) => a.intentId === dark.id && a.status === "alternate").length === 1, "the other dark mode attempt stays as an alternate");
const methods = st.landings.map((l) => l.method);
console.log(`landings: ${methods.join(", ")} · course checks ${st.stats.courseChecks} · corrections ${st.stats.corrections} · re-plots ${st.stats.replots}`);
console.log(failed ? `${failed} check(s) failed` : "All checks pass.");
process.exit(failed ? 1 : 0);
