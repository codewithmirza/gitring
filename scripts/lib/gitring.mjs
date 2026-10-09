/**
 * Shared setup for the scripts: the gitring URL, the API key, and a project to work in.
 *
 *   GITRING_URL      the Worker (default http://127.0.0.1:5173, the dev server)
 *   GITRING_KEY      a personal API key (gitring → Connect → API keys). Required.
 *   GITRING_PROJECT  a project id. Without it, the script makes a private copy of the sample.
 */
export const base = process.env.GITRING_URL ?? "http://127.0.0.1:5173";

export function authHeaders() {
  const key = process.env.GITRING_KEY;
  if (!key) {
    console.error("Set GITRING_KEY to a personal API key. Create one in gitring: Connect → API keys.");
    process.exit(2);
  }
  return { Authorization: `Bearer ${key}` };
}

/** The project from GITRING_PROJECT, or a new private sample project (fresh: main at the seed commit). */
export async function projectFor(label, headers = authHeaders()) {
  if (process.env.GITRING_PROJECT) return { id: process.env.GITRING_PROJECT, fresh: false };
  const res = await fetch(new URL("/api/projects", base), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: `${label} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, visibility: "private", source: { kind: "sample" } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gitring did not make a project: ${json.error ?? res.status}`);
  return { id: json.project.id, fresh: true };
}
