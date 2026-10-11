/**
 * Pure helpers for scripts/load.mjs: options, the cost warning, seeded scheduling, percentiles and the
 * report. No network and no clock here, so the tests can run them anywhere.
 */

export const LIMITS = { agents: 500, tasks: 100 };

/** A small seeded random number generator. The same seed gives the same numbers. */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same random stream for the same seed and name (one stream for each agent). */
export function streamFor(seed, name) {
  let h = seed >>> 0;
  for (const c of String(name)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return mulberry32(h);
}

/** A seeded shuffle. It does not change the list that it gets. */
export function seededShuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The delay before each agent starts, in milliseconds. The agents do not all start in the same moment. */
export function startDelays(seed, agents, spreadMs) {
  const rng = mulberry32(seed ^ 0x51ed270b);
  return Array.from({ length: agents }, () => Math.floor(rng() * spreadMs));
}

/** Nearest-rank percentile of a list of numbers that is already sorted. p is from 0 to 100. */
export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Count, p50, p95 and max of a list of numbers (in any order). */
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1] : 0 };
}

/** Records of calls: tool name, time in milliseconds, and the kind of answer. */
export class Metrics {
  constructor() {
    this.calls = [];
    this.counts = { landed: 0, handed: 0, failed: 0, changeRequests: 0, toolErrors: 0, protocolErrors: 0, rateLimited: 0 };
    this.notes = [];
  }
  record(tool, ms) {
    this.calls.push({ tool, ms });
  }
  count(name, n = 1) {
    this.counts[name] += n;
  }
  /** A short note for the report (for example the first protocol error). At most 8 notes. */
  note(text) {
    if (this.notes.length < 8) this.notes.push(String(text).slice(0, 200));
  }
  perTool() {
    const by = new Map();
    for (const c of this.calls) by.set(c.tool, [...(by.get(c.tool) ?? []), c.ms]);
    return [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([tool, ms]) => ({ tool, ...summarize(ms) }));
  }
}

/** The exit code of a run: 1 when there was any protocol error, else 0. */
export function exitCode(counts) {
  return counts.protocolErrors > 0 ? 1 : 0;
}

/** The report, as lines of plain text. */
export function formatReport(metrics, info) {
  const c = metrics.counts;
  const lines = [
    `Load test finished in ${(info.totalMs / 1000).toFixed(1)} s.`,
    `Project ${info.project}. ${info.agents} agents, ${info.tasks} tasks for each agent (${info.agents * info.tasks} tasks). Seed ${info.seed}.`,
    `Tasks: ${c.landed} landed, ${c.handed} handed to a person, ${c.failed} failed.`,
    `Change requests: ${c.changeRequests}.`,
    `Tool errors: ${c.toolErrors}. Protocol errors: ${c.protocolErrors}. Answers with status 429: ${c.rateLimited}.`,
    "",
    `${"tool".padEnd(18)} ${"calls".padStart(6)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"max ms".padStart(8)}`,
  ];
  for (const t of metrics.perTool()) lines.push(`${t.tool.padEnd(18)} ${String(t.count).padStart(6)} ${String(Math.round(t.p50)).padStart(8)} ${String(Math.round(t.p95)).padStart(8)} ${String(Math.round(t.max)).padStart(8)}`);
  if (metrics.notes.length) lines.push("", "First problems:", ...metrics.notes.map((n) => `- ${n}`));
  if (c.protocolErrors > 0) lines.push("", "The run had protocol errors. The exit code is 1.");
  return lines;
}

/** The text that people read before they spend money. */
export function costWarning(options) {
  return [
    "This script sends real calls to a deployed gitring. It costs money.",
    "The calls use Artifacts operations, Workers AI and test containers. All of them are billed to the account of that gitring.",
    `This run: ${options.agents} agents with ${options.tasks} tasks each, on project ${options.project}.`,
    "The script does not create projects. It makes new tasks and files in the project that you name. Use a project that you can throw away.",
    "To start the run, add --yes to the command.",
  ];
}

export const USAGE = [
  "Usage: GITRING_URL=https://your-gitring.example.com GITRING_KEY=<key> npm run load -- --project <id> [--agents N] [--tasks M] [--seed S] --yes",
  "  --project <id>  the project to load. The script does not create projects.",
  `  --agents N      agents that work at the same time (default 10, at most ${LIMITS.agents})`,
  `  --tasks M       tasks for each agent (default 2, at most ${LIMITS.tasks})`,
  "  --seed S        seed of the scheduling (default 1)",
  "  --yes           confirm the cost. Without it, the script prints a warning and stops.",
  "GITRING_URL must start with https://. GITRING_KEY is read from the environment only. The script never prints it.",
];

/** The MCP address for GITRING_URL: https only. An address that ends in /mcp stays as it is. */
export function endpointOf(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new Error("GITRING_URL is not a web address. Use https://your-gitring.example.com");
  }
  if (url.protocol !== "https:") throw new Error("GITRING_URL must start with https://. The script does not send a key over http.");
  url.hash = "";
  url.search = "";
  if (!/\/mcp\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/+$/, "")}/mcp`;
  return url;
}

function whole(name, raw, min, max) {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} needs a whole number from ${min} to ${max}.`);
  return n;
}

/**
 * Read the command line and the environment. The result has `lines` to print and a `code` to exit with
 * when the script must not run. When it may run, `options` and `key` are set. The key is never in `lines`.
 */
export function prepare(argv, env) {
  const raw = {};
  let yes = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--help" || a === "-h") return { code: 0, lines: USAGE };
      if (a === "--yes") {
        yes = true;
        continue;
      }
      const m = /^--(project|agents|tasks|seed)(?:=(.*))?$/.exec(a);
      if (!m) throw new Error(`Unknown option ${a}.`);
      raw[m[1]] = m[2] ?? argv[++i];
    }
    if (!raw.project) throw new Error("--project <id> is needed. The script does not create projects.");
    if (!/^[\w.-]{1,80}$/.test(raw.project)) throw new Error("--project must be a project id: letters, digits, dot, dash or underscore.");
    const options = {
      project: raw.project,
      agents: raw.agents === undefined ? 10 : whole("agents", raw.agents, 1, LIMITS.agents),
      tasks: raw.tasks === undefined ? 2 : whole("tasks", raw.tasks, 1, LIMITS.tasks),
      seed: raw.seed === undefined ? 1 : whole("seed", raw.seed, 0, 2 ** 31 - 1),
    };
    const endpoint = endpointOf(env.GITRING_URL);
    const key = env.GITRING_KEY;
    if (!key) throw new Error("GITRING_KEY is not set. Set it in the environment. Do not put a key on the command line.");
    if (!yes) return { code: 2, lines: costWarning(options) };
    return { code: 0, lines: [], options, endpoint, key };
  } catch (e) {
    return { code: 2, lines: [String(e?.message ?? e), "", ...USAGE] };
  }
}

/** Parse the change requests in the text of an answer: the ids and the callsign that continues. */
export function changeRequestsIn(text) {
  const out = [];
  if (!String(text).startsWith("GITRING CHANGE REQUEST")) return out;
  for (const line of String(text).split("\n")) {
    const m = /^- \[([^\]]+)\] \(([^)]*)\)/.exec(line);
    if (m) out.push({ id: m[1], kind: m[2] });
  }
  return out;
}

/** The JSON block at the end of an answer (the last line that is only "{" or "["). */
export function lastJson(text) {
  const lines = String(text).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "{" || lines[i] === "[") {
      try {
        return JSON.parse(lines.slice(i).join("\n"));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
