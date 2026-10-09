#!/usr/bin/env node
/**
 * End-to-end run of the sample project with real Workers AI agents, against a running Bearing
 * (local `npm run dev` or a deployed Worker). It makes a private copy of the sample (or resets
 * BEARING_PROJECT), launches agents on every open intent, waits until no agent is at work, lands the
 * first ready dark mode attempt as a human pick, and prints what happened. AI agents take 5 to 15 minutes.
 *
 *   BEARING_URL=https://<your-worker> BEARING_KEY=bk_… node scripts/e2e-scenario.mjs
 *
 * Exit code 1 when an invariant fails (human merge fixes must stay 0; work must land).
 */
import { authHeaders, base, projectFor } from "./lib/bearing.mjs";

const headers = { "content-type": "application/json", ...authHeaders() };
const { id: project, fresh } = await projectFor("Scenario", headers);
console.log(`project ${project} · ${base}/?project=${project}`);
const api = (p, body) =>
  fetch(`${base}/api/projects/${project}${p}`, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers }).then((r) => r.json());
const ACTIVE = new Set(["declared", "underway", "submitted", "checking", "landing", "rederiving"]);
let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed += 1;
};
if (!fresh) await api("/reset", {});
const run = await api("/launch-all", {});
ok(run.intents === 5, `launch-all starts agents on 5 sample intents (${run.launched} now, ${run.queued} wait for the AI budget)`);
let st;
const t0 = Date.now();
const limitMs = Number(process.env.E2E_MINUTES ?? 20) * 60_000;
for (;;) {
  st = await api("/state");
  const busy = st.attempts.filter((a) => ACTIVE.has(a.status)).length;
  process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)} s · ${busy} agents at work · ${st.landings.length} landings   `);
  if (!busy && st.attempts.length) break;
  if (Date.now() - t0 > limitMs) break;
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("");
const dark = st.intents.find((i) => /dark/i.test(i.title));
const pick = st.attempts.find((a) => a.intentId === dark?.id && a.status === "ready");
if (pick) {
  const landed = await api(`/attempts/${pick.id}/land`, { rationale: "A human picks this dark mode." });
  ok(landed.status === "landed", `the human pick lands (${landed.landing?.method ?? landed.message})`);
  st = await api("/state");
}
const landedIntents = st.intents.filter((i) => i.status === "landed");
ok(landedIntents.length >= 3, `intents on main: ${landedIntents.length} of ${st.intents.length}`);
ok(st.stats.humanMergeFixes === 0, "human merge fixes: 0");
ok(st.stats.courseChecks > 0, `course checks run (${st.stats.courseChecks})`);
const methods = st.landings.map((l) => l.method);
console.log(`landings: ${methods.join(", ") || "none"} · corrections ${st.stats.corrections} · re-plots ${st.stats.replots ?? 0}`);
for (const i of st.intents) console.log(`  ${i.status.padEnd(9)} ${i.title}`);
console.log(failed ? `${failed} check(s) failed` : "All checks pass.");
process.exit(failed ? 1 : 0);
