/**
 * Shared setup for the scripts: the gitring URL, the API key, and a project to work in.
 *
 *   GITRING_URL      the Worker (default http://127.0.0.1:5173, the dev server)
 *   GITRING_KEY      a personal API key (gitring → Account → API keys), or the operator key. Required.
 *   GITRING_PROJECT  a project id. Without it, the script uploads the test bookshop (sample/repo) as a new
 *                    private project, with its five tasks and their tests.
 *
 * Behind a proxy, run Node with NODE_USE_ENV_PROXY=1.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const base = process.env.GITRING_URL ?? "http://127.0.0.1:5173";
const SAMPLE = fileURLToPath(new URL("../../sample/", import.meta.url));

export function authHeaders() {
  const key = process.env.GITRING_KEY;
  if (!key) {
    console.error("Set GITRING_KEY to a personal API key. Create one in gitring: Account → API keys.");
    process.exit(2);
  }
  return { Authorization: `Bearer ${key}` };
}

function filesOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(dir, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

async function post(path, headers, body, method = "POST") {
  const res = await fetch(new URL(path, base), { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

/**
 * The project from GITRING_PROJECT, or a new private project made from the test bookshop: an upload of
 * sample/repo, its tests in the fast Dynamic Worker runner, and the five tasks of sample/intents.json.
 */
export async function projectFor(label, headers = authHeaders()) {
  if (process.env.GITRING_PROJECT) return { id: process.env.GITRING_PROJECT, fresh: false };
  const name = `${label} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const made = await post("/api/projects", headers, { name, visibility: "private", source: { kind: "upload" }, files: filesOf(join(SAMPLE, "repo")) });
  const id = made.project.id;
  console.error(`gitring: new test project ${id} (archive it when you are done: DELETE /api/projects/${id})`);
  await post(`/api/projects/${id}/settings`, headers, { checks: { runner: "worker" }, intentsInRepo: true }, "PUT");
  const intents = JSON.parse(readFileSync(join(SAMPLE, "intents.json"), "utf8"));
  for (const it of intents) {
    await post(`/api/projects/${id}/intents`, headers, { title: it.title, goal: it.goal, checks: it.checks });
  }
  return { id, fresh: true };
}
