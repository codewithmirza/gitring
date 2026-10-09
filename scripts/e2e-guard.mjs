#!/usr/bin/env node
/**
 * End-to-end check of re-plot and the write guard, through MCP only (api mode), against a running
 * Bearing (local `npm run dev` or a deployed Worker). Exit code 1 when a check fails.
 *
 *   BEARING_URL=https://<your-worker> BEARING_KEY=bk_… node scripts/e2e-guard.mjs
 *
 * 1. A reads src/render.js. B changes the footer and lands. Bearing re-plots A onto the new main.
 *    A writes from its old copy: Bearing merges, so B's line stays. A writes again from the same copy:
 *    B's line still stays. A write on the line next to B's line overlaps it: refused, read again.
 * 2. C and D change the same footer line. D lands. Bearing resets C's file to main (must read).
 *    C writes its old text: refused. C reads, writes again: accepted, and D's line stays.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { authHeaders, base, projectFor } from "./lib/bearing.mjs";

const headers = authHeaders();
const { id: project } = await projectFor("Guard check", headers);
const client = new Client({ name: "e2e-guard", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers } }));
let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed += 1;
};
async function call(name, args) {
  const r = await client.callTool({ name, arguments: { project, ...args } });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  const cut = text.lastIndexOf("\n\n");
  let json = null;
  try {
    json = JSON.parse(cut >= 0 ? text.slice(cut + 2) : text);
  } catch {}
  return { text, json };
}
const FOOT = "Ask at the counter for books that are not on the shelf.";
async function declare(title, goal) {
  const d = await call("bearing_declare", { newIntent: { title, goal }, plan: ["Edit the footer"], files: ["src/render.js"], approach: "One line in renderFooter.", mode: "api", agent: { client: "e2e" } });
  return d.json.attemptId;
}
const read = async (id) => (await call("bearing_read", { attemptId: id, path: "src/render.js" })).text;
const write = async (id, content) => (await call("bearing_write", { attemptId: id, files: [{ path: "src/render.js", content }] })).json;
async function landed(id) {
  for (let i = 0; i < 40; i++) {
    const st = await (await fetch(`${base}/api/projects/${project}/state`, { headers })).json();
    if (st.landings.some((l) => l.attemptId === id)) return st;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${id} did not land`);
}
const fileOnMain = async () => (await fetch(`${base}/api/projects/${project}/file?ref=main&path=src/render.js`, { headers })).text();
/** The attempt's file as Bearing holds it (not a read by the agent: the agent's copy does not change). */
const fileOf = async (id) => (await fetch(`${base}/api/projects/${project}/file?ref=${id}&path=src/render.js`, { headers })).text();

// ── 1. merge a write from a stale copy, twice ──
const A = await declare("Footer: opening hours on Monday", "Say in the footer that the shop opens on Monday too.");
const B = await declare("Footer: gift wrapping", "Say in the footer that gift wrapping is free.");
const aCopy = await read(A);
const bText = (await read(B)).replace(`<p>${FOOT}</p>`, `<p>${FOOT}</p>\n  <p>Gift wrapping is free.</p>`);
await write(B, bText);
await call("bearing_submit", { attemptId: B, summary: "Gift wrapping line." });
await landed(B);
ok((await fileOnMain()).includes("Gift wrapping is free."), "B landed its footer line on main");
const aV1 = aCopy.replace("Open Tuesday to Sunday", "Open every day");
const w1 = await write(A, aV1);
ok(w1.merged?.includes("src/render.js"), "A's write from the old copy is merged with main");
let now = await fileOf(A);
ok(now.includes("Gift wrapping is free.") && now.includes("Open every day"), "A's file keeps B's line and A's change");
// A writes again from its own copy (which never had B's line), with no read in between.
const aV2 = aV1.replace("since 1987", "since 1987, on the quay");
ok(aV2 !== aV1 && !aV2.includes("Gift wrapping is free."), "A's copy does not have B's line (test set-up)");
await write(A, aV2);
now = await fileOf(A);
ok(now.includes("since 1987, on the quay"), "A's second write applies");
ok(now.includes("Gift wrapping is free."), "A's second write from its old copy keeps B's landed line");
// A change on the line next to B's landed line overlaps it: Bearing refuses it and asks for a read.
const aV3 = aV2.replace("Ask at the counter", "Please ask at the counter");
const w3 = await write(A, aV3);
ok(w3.refused?.length === 1 && (await fileOf(A)).includes("Gift wrapping is free."), "A's write next to B's line is refused (read again), B's line stays");

// ── 2. overlapping lines: reset to main, must read ──
const C = await declare("Staff help line", "Tell readers that the staff find any book for them.");
const D = await declare("Special orders", "Say that the bookseller orders a missing book for the reader.");
const cCopy = await read(C);
const cText = cCopy.replace("for books that are not on the shelf", "for any book, the staff will find it");
await write(C, cText);
const dText = (await read(D)).replace("for books that are not on the shelf", "and the bookseller orders it for you");
await write(D, dText);
const subD = await call("bearing_submit", { attemptId: D, summary: "Bookseller line." });
if (subD.json?.next !== "landing-queue") console.log("D submit:", subD.json?.next, subD.json?.message);
await landed(D);
const st = await (await fetch(`${base}/api/projects/${project}/state`, { headers })).json();
const cAttempt = st.attempts.find((a) => a.id === C);
ok(cAttempt.baseSha === st.project.mainSha, "C moved onto the new main (re-plot)");
const corr = st.corrections.filter((x) => x.attemptId === C && x.constraints?.reapply?.length);
ok(corr.length === 1, "C got a correction with its earlier diff to make again");
const refusedWrite = await write(C, cText);
ok(refusedWrite.refused?.length === 1 && refusedWrite.written.length === 0, "C's write of its old text is refused until C reads the file");
const fresh = await read(C);
ok(fresh.includes("the bookseller orders it for you") && !fresh.includes("the staff will find it"), "C reads the main version (D's line)");
const cAgain = fresh.replace("Open Tuesday to Sunday", "Open Tuesday to Sunday (ask the staff)");
const okWrite = await write(C, cAgain);
ok(okWrite.written.includes("src/render.js") && !okWrite.refused, "C writes again after the read");
const finalC = await read(C);
ok(finalC.includes("the bookseller orders it for you"), "D's landed line stays in C's file");

await client.close();
console.log(failed ? `${failed} check(s) failed` : "All checks pass.");
process.exit(failed ? 1 : 0);
