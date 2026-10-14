#!/usr/bin/env node
/**
 * Three scripted agents meet on one small shop project, on any gitring. The script prints each real answer.
 * Run: GITRING_URL=<url> GITRING_KEY=<key> npm run meet -- [--approval] [--wait SECONDS] [--keep]
 * It makes one private project and archives it at the end. The agents are scripted: this is not a test of a model.
 * Never print the key. Read next: meet-steps.mjs (the story), meet-story.mjs (the helpers), meet-files.mjs (the texts).
 */
import { pathToFileURL } from "node:url";
import { endpointOf } from "./load-lib.mjs";
import { startTheShop, twoAgentsChangeOneFunction, theSecondAgentWorksOnTheNewMain, aPersonMustSayYes } from "./meet-steps.mjs";
import { makeStory, makeTalk } from "./meet-story.mjs";

export const MEET_USAGE = [
  "Usage: GITRING_URL=https://your-gitring.example.com GITRING_KEY=<key> npm run meet -- [--approval] [--wait SECONDS] [--keep]",
  "  --approval      add a third agent whose change needs a person. The script prints the link and waits.",
  "  --wait SECONDS  how long to wait for the person (default 180, with --approval only)",
  "  --keep          keep the project, to look at it in the browser (default: archive it at the end)",
  "GITRING_URL must start with https://. For the run on your computer, http://localhost works too. GITRING_KEY is read from the environment only. The script never prints it.",
];

/** Read the command line and the environment. A result with `lines` and a `code` means: print and exit. */
export function prepareMeet(argv, env) {
  const options = { approval: false, waitSec: 180, keep: false };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--help" || a === "-h") return { code: 0, lines: MEET_USAGE };
      if (a === "--approval") options.approval = true;
      else if (a === "--keep") options.keep = true;
      else if (a === "--wait" || a.startsWith("--wait=")) {
        const raw = a.includes("=") ? a.slice(7) : argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 3600) throw new Error("--wait needs a whole number of seconds, from 0 to 3600.");
        options.waitSec = n;
      } else throw new Error(`Unknown option ${a}.`);
    }
    const key = String(env.GITRING_KEY ?? "");
    if (!key) throw new Error("GITRING_KEY is not set. Make a key in gitring (Account → API keys), or use the key that npm run dev:local prints.");
    const endpoint = endpointOf(env.GITRING_URL);
    return { options, endpoint, key };
  } catch (e) {
    return { code: 2, lines: [String(e?.message ?? e), ...MEET_USAGE] };
  }
}

// ───── The run ─────

const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Run the story. `say` gets each line of the report. `fetchImpl` and `pollMs` are for tests.
 * Returns what happened; it throws when the story cannot go on (the project is archived first).
 */
export async function runMeet({ endpoint, key, options = {}, say = console.log, fetchImpl = fetch, pollMs = 500 }) {
  const { approval = false, waitSec = 180, keep = false } = options;
  const { origin, out, api } = makeTalk({ endpoint, key, say, fetchImpl });

  const made = await api("POST", "/api/projects", { name: `meet-${Date.now().toString(36)}`, visibility: "private", source: { kind: "empty" }, settings: { checks: { runner: "worker" } } });
  if (made.status !== 201 || !made.json?.project?.id) {
    throw new Error(`gitring did not make the project (${made.status}): ${made.raw.slice(0, 200)}. The key needs the right to make projects.`);
  }
  const project = made.json.project.id;
  const story = makeStory({ endpoint, key, fetchImpl, pollMs, out, api, project });
  const { clients } = story;

  let result = { ok: false, project, merges: 0, changeRequests: 0, waiting: false };
  try {
    out("gitring meet: three scripted agents and one small shop project");
    out(`Project: ${project}  (private; ${keep ? "kept" : "archived at the end"})`);

    await startTheShop(story);
    const { b, idB } = await twoAgentsChangeOneFunction(story);
    await theSecondAgentWorksOnTheNewMain(story, b, idB);
    if (approval) await aPersonMustSayYes(story, result, waitSec);

    const st = await story.state();
    result = { ...result, ok: true, merges: (st.landings ?? []).length, changeRequests: (st.corrections ?? []).length };
    out(`\n── Result ${"─".repeat(56)}`);
    out(`main has ${result.merges} ${result.merges === 1 ? "merge" : "merges"}, one after the other. gitring sent ${result.changeRequests} ${result.changeRequests === 1 ? "change request" : "change requests"}.`);
    out("Both changes to formatPrice are in main: commas, and Free for zero. Nobody had to solve a conflict.");
    if (result.waiting) out("The change of Agent C is not in main. It waits for a person.");
    if (keep || result.waiting) out(`Look at it: ${origin.origin}/overview?project=${project}  (sign in first)`);
  } catch (e) {
    out(`\nThe story stopped: ${lower(String(e?.message ?? e))}`);
    throw e;
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    if (result.waiting) out(`The project ${project} stays, because a person still has to answer. Archive it in Settings when you are done.`);
    else if (!keep) {
      const gone = await api("DELETE", `/api/projects/${project}`).catch(() => undefined);
      out(gone?.status === 204 ? `The project ${project} is archived.` : `The project ${project} stays. Archive it in Settings.`);
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const prepared = prepareMeet(process.argv.slice(2), process.env);
  if (!prepared.options) {
    for (const l of prepared.lines) console.log(l);
    process.exit(prepared.code ?? 2);
  }
  try {
    const r = await runMeet({ endpoint: prepared.endpoint, key: prepared.key, options: prepared.options });
    process.exit(r.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
