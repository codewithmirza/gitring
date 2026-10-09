/** Formatting helpers. Numbers are always shown in the agent voice (mono) by callers. */
import type { AttemptStatus, CorrectionKind, IntentStatus, LandingMethod, Range, RuleOfTheRoad } from "../../../src/core/types";

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
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const RULE_TEXT: Record<RuleOfTheRoad | "human", { code: string; text: string }> = {
  "R1-landed-has-way": { code: "R1", text: "landed has way" },
  "R2-waiting-stands-on": { code: "R2", text: "waiting stands on" },
  "R3-producer-stands-on": { code: "R3", text: "producer stands on" },
  "R4-first-declared-stands-on": { code: "R4", text: "first declared stands on" },
  "R5-priority-stands-on": { code: "R5", text: "priority stands on" },
  "R6-smaller-gives-way": { code: "R6", text: "smaller gives way" },
  human: { code: "H", text: "human amendment" },
};

export function ruleLabel(rule: RuleOfTheRoad | "human" | undefined): string {
  if (!rule) return "—";
  const r = RULE_TEXT[rule];
  return r ? `${r.code} · ${r.text}` : rule;
}

export const CORRECTION_KIND_TEXT: Record<CorrectionKind, string> = {
  interface: "Interface",
  region: "Region",
  duplicate: "Duplicate",
  upstream: "Upstream",
  "intent-amended": "Intent amended",
};

export const METHOD_TEXT: Record<LandingMethod, string> = {
  "fast-forward": "Fast-forward",
  merge: "Merge",
  rederive: "Re-derive",
};

export const RANGE_TEXT: Record<Range, string> = {
  0: "same lines or symbol",
  1: "interface use",
  2: "same file",
  3: "direct import",
  4: "two imports apart",
  5: "open water",
};

export const ATTEMPT_STATUS_TEXT: Record<AttemptStatus, string> = {
  declared: "Declared",
  underway: "Underway",
  submitted: "Submitted",
  checking: "Checking",
  ready: "Ready",
  landing: "Landing",
  landed: "Landed",
  stale: "Stale",
  rederiving: "Re-deriving",
  alternate: "Alternate",
  abandoned: "Abandoned",
  failed: "Failed",
};

export const INTENT_STATUS_TEXT: Record<IntentStatus, string> = {
  draft: "Draft",
  open: "Open",
  underway: "Underway",
  judging: "Needs a pick",
  landing: "Landing",
  landed: "Landed",
  parked: "Parked",
  "merged-into": "Merged",
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
