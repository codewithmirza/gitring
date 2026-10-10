/** Formatting helpers. Numbers are always shown in the agent voice (mono) by callers. */
import type { AttemptStatus, CorrectionKind, CourseCheck, IntentStatus, LandingMethod, Range, RuleOfTheRoad, Verdict } from "../../../src/core/types";

export function shortSha(sha: string | undefined | null, n = 7): string {
  return sha ? sha.slice(0, n) : "———————";
}

/** "@cf/zai-org/glm-5.3-flash" → "glm-5.3-flash". */
export function modelShort(model: string | undefined | null): string {
  if (!model) return "unknown model";
  const i = model.lastIndexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ago(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export function prob(p: number | undefined): string {
  if (p === undefined || Number.isNaN(p)) return "—";
  return p.toFixed(2);
}

export function int(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`;
}

/** "line 12" or "lines 10–18". */
export function lineRangeText(range: readonly [number, number]): string {
  const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]];
  return a === b ? `line ${a}` : `lines ${a}–${b}`;
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A calm day heading for lists: "Today", "Yesterday", "Mon 8 Oct", or "8 Oct 2025" in another year. */
export function dayLabel(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const start = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((start(now) - start(ms)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (d.getFullYear() !== new Date(now).getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const LANG_TEXT: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  typescript: "TypeScript",
  json: "JSON",
  jsonc: "JSON",
  css: "CSS",
  html: "HTML",
  htm: "HTML",
  md: "Markdown",
  markdown: "Markdown",
  py: "Python",
  python: "Python",
  go: "Go",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  sh: "Shell",
  txt: "Text",
  text: "Text",
};

/** The name of a language for people ("TypeScript"), from the file's lang or extension. */
export function langLabel(lang: string | undefined, path = ""): string {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return LANG_TEXT[(lang ?? "").toLowerCase()] ?? LANG_TEXT[ext] ?? (lang && lang !== "text" ? lang.toUpperCase() : "Text");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Who continues and who adapts when two pieces of work collide (the conflict-check rules). */
export const RULE_TEXT: Record<RuleOfTheRoad | "human", string> = {
  "R1-landed-has-way": "Merged work has priority",
  "R2-waiting-stands-on": "Work that waits to merge has priority",
  "R3-producer-stands-on": "The agent that changes the interface continues",
  "R4-first-declared-stands-on": "The first plan has priority",
  "R5-priority-stands-on": "The high-priority task has priority",
  "R6-smaller-gives-way": "The smaller change adapts",
  human: "A person changed the task",
};

export function ruleLabel(rule: RuleOfTheRoad | "human" | undefined): string {
  if (!rule) return "—";
  return RULE_TEXT[rule] ?? rule;
}

export const CORRECTION_KIND_TEXT: Record<CorrectionKind, string> = {
  interface: "Interface",
  region: "Same lines",
  duplicate: "Duplicate",
  upstream: "Main moved",
  "intent-amended": "Goal changed",
};

/** Short words for the change-request markers on the map. */
export const CORRECTION_KIND_SHORT: Record<CorrectionKind, string> = {
  interface: "interface",
  region: "lines",
  duplicate: "duplicate",
  upstream: "main",
  "intent-amended": "goal",
};

export const METHOD_TEXT: Record<LandingMethod, string> = {
  "fast-forward": "Fast-forward",
  merge: "3-way merge",
  rederive: "Redo",
};

/** Distance between two pieces of work in the code (0 = closest). */
export const RANGE_TEXT: Record<Range, string> = {
  0: "same lines",
  1: "shared function",
  2: "same file",
  3: "one import",
  4: "two imports",
  5: "no relation",
};

export function distanceLabel(range: Range): string {
  return `Distance ${range}: ${RANGE_TEXT[range]}`;
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  clear: "No conflict",
  correct: "Change request",
  "merge-intents": "Duplicate tasks",
  escalate: "Needs a person",
};

/** What started a conflict check. */
export const TRIGGER_TEXT: Record<CourseCheck["trigger"], string> = {
  declare: "plan",
  log: "log",
  write: "write",
  push: "push",
  "main-advanced": "main moved",
  "intent-amended": "goal changed",
};

/** Who decided a conflict check: the conflict-check model (fast or large), or the rules alone. */
export function checkSourceText(source: string): string {
  if (source === "rules") return "rules";
  return source.endsWith("-flash") ? "conflict-check model (fast)" : "conflict-check model";
}

export const ATTEMPT_STATUS_TEXT: Record<AttemptStatus, string> = {
  declared: "Plan sent",
  underway: "Working",
  submitted: "Submitted",
  checking: "Testing",
  ready: "Ready",
  landing: "Merging",
  landed: "Merged",
  stale: "Out of date",
  rederiving: "Redoing",
  alternate: "Alternative",
  abandoned: "Stopped",
  failed: "Failed",
};

export const INTENT_STATUS_TEXT: Record<IntentStatus, string> = {
  draft: "Draft",
  open: "Open",
  underway: "Working",
  judging: "Needs a choice",
  landing: "Merging",
  landed: "Merged",
  parked: "Paused",
  "merged-into": "Duplicate",
};

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Split text with `code` spans into parts for rendering. Agent text is data: never HTML. */
export function codeSpans(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}
