/**
 * Logbook: the "why" record of every landing.
 *
 *  - landingMessage: commit message = subject (intent title) + short body + Bearing-* trailers.
 *  - landingNote:    git note (refs/notes/bearing) = pretty JSON, schema "bearing.logbook/v1".
 *  - intentFile:     `.bearing/intents/<slug>.md` with YAML front matter (optional in-repo copy).
 *  - parseTrailers:  read the trailers back from any commit message.
 *
 * Pure module.
 */
import type { AgentInfo, Attempt, CheckRun, Correction, CourseCheck, Decision, Intent, LandingMethod } from "./types";

export const LOGBOOK_SCHEMA = "bearing.logbook/v1";
export const SUBJECT_MAX = 72;
const BODY_WIDTH = 72;

/** URL- and file-safe slug: lowercase ASCII words joined by "-", at most 60 characters. */
export function slugify(s: string): string {
  const base = (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= 60) return base || "intent";
  const cut = base.slice(0, 60);
  const dash = cut.lastIndexOf("-");
  return (dash >= 20 ? cut.slice(0, dash) : cut).replace(/-+$/g, "") || "intent";
}

const oneLine = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

function subjectOf(title: string): string {
  const t = oneLine(title) || "Untitled intent";
  return t.length <= SUBJECT_MAX ? t : `${t.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

function wrap(text: string, width = BODY_WIDTH): string {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      const words = para.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
      const lines: string[] = [];
      let cur = "";
      for (const w of words) {
        if (!cur) cur = w;
        else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
        else {
          lines.push(cur);
          cur = w;
        }
      }
      if (cur) lines.push(cur);
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

/** First paragraph of a markdown goal, without heading marks, at most ~400 characters. */
function summaryOf(attempt: Attempt, intent: Intent): string {
  const src = attempt.summary?.trim() || intent.goal?.trim() || "";
  const para = src.split(/\n\s*\n/)[0]?.replace(/^#+\s*/gm, "").trim() ?? "";
  return para.length <= 400 ? para : `${para.slice(0, 399).trimEnd()}…`;
}

function modelOf(agent: AgentInfo): string {
  return oneLine(agent.model || agent.client || agent.kind || "unknown");
}

function checksTotal(checks: CheckRun): { passed: number; total: number } {
  const passed = checks?.passed ?? 0;
  const total = passed + (checks?.failed ?? 0) || checks?.cases?.length || 0;
  return { passed, total };
}

/** Commit message: subject, blank line, short body, blank line, Bearing-* trailers. */
export function landingMessage(args: {
  intent: Intent;
  attempt: Attempt;
  agent: AgentInfo;
  method: LandingMethod;
  corrections: Correction[];
  checks: CheckRun;
}): string {
  const { intent, attempt, agent, method, corrections, checks } = args;
  const generation = attempt.lineage?.generation ?? 1;
  const { passed, total } = checksTotal(checks);
  const body: string[] = [];
  const summary = summaryOf(attempt, intent);
  if (summary) body.push(wrap(summary));
  const rederived = attempt.lineage?.rederivedFrom ? ` (re-derived from ${attempt.lineage.rederivedFrom})` : "";
  body.push(
    [
      wrap(`Landed by ${oneLine(agent.callsign)} with ${method}. Generation ${generation}${rederived}.`),
      `Corrections: ${corrections.length}. Checks: ${passed}/${total} pass.`,
    ].join("\n"),
  );
  const trailers = [
    `Bearing-Intent: ${oneLine(intent.id)}`,
    `Bearing-Attempt: ${oneLine(attempt.id)}`,
    `Bearing-Agent: ${oneLine(agent.callsign)} (${oneLine(agent.id)})`,
    `Bearing-Model: ${modelOf(agent)}`,
    `Bearing-Method: ${method}`,
    `Bearing-Corrections: ${corrections.length}`,
    `Bearing-Checks: ${passed}/${total} pass`,
    `Bearing-Generation: ${generation}`,
  ];
  return `${subjectOf(intent.title)}\n\n${body.join("\n\n")}\n\n${trailers.join("\n")}\n`;
}

/** Git note: the full why-record as pretty JSON. */
export function landingNote(args: {
  intent: Intent;
  attempt: Attempt;
  agent: AgentInfo;
  method: LandingMethod;
  corrections: Correction[];
  courseChecks: CourseCheck[];
  checks: CheckRun;
  decision?: Decision;
}): string {
  const { intent, attempt, agent, method, corrections, courseChecks, checks, decision } = args;
  const fpFiles = Object.entries(attempt.footprint?.files ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, t]) => ({ path, status: t.status, additions: t.additions, deletions: t.deletions }));
  const sym = attempt.footprint?.symbols;
  const note = {
    schema: LOGBOOK_SCHEMA,
    intent: {
      id: intent.id,
      title: intent.title,
      goal: intent.goal,
      constraints: intent.constraints ?? [],
      version: intent.version,
      amendments: intent.amendments ?? [],
    },
    attempt: {
      id: attempt.id,
      generation: attempt.lineage?.generation ?? 1,
      rederivedFrom: attempt.lineage?.rederivedFrom ?? null,
      base: { sha: attempt.baseSha, tree: attempt.baseTree },
      course: attempt.course,
      footprint: {
        files: fpFiles,
        symbols: {
          defined: sym?.defined ?? [],
          modified: sym?.modified ?? [],
          removed: sym?.removed ?? [],
          signatureChanged: sym?.signatureChanged ?? [],
        },
        stats: attempt.stats,
      },
      summary: attempt.summary ?? null,
    },
    agent: {
      id: agent.id,
      callsign: agent.callsign,
      kind: agent.kind,
      model: agent.model ?? null,
      client: agent.client ?? null,
    },
    method,
    corrections: corrections.map((c) => ({
      id: c.id,
      kind: c.kind,
      rule: c.rule,
      message: c.message,
      standOn: c.standOnAttemptId ?? null,
      status: c.status,
      ...(c.ackNote ? { ackNote: c.ackNote } : {}),
    })),
    courseChecks: courseChecks.map((k) => ({
      id: k.id,
      trigger: k.trigger,
      verdict: k.verdict,
      source: k.source,
      confidence: k.confidence,
      latencyMs: k.latencyMs,
      assessments: k.assessments,
    })),
    checks: {
      passed: checks?.passed ?? 0,
      failed: checks?.failed ?? 0,
      cases: (checks?.cases ?? []).map((c) => ({ file: c.file, name: c.name, ok: c.ok, ...(c.error ? { error: c.error } : {}) })),
    },
    decision: decision ?? null,
  };
  return `${JSON.stringify(note, null, 2)}\n`;
}

/** YAML double-quoted scalar (JSON escapes are valid YAML escapes). */
const yq = (s: string): string => JSON.stringify(s ?? "");

/** `.bearing/intents/<slug>.md`: the intent as it landed, with YAML front matter. */
export function intentFile(
  intent: Intent,
  landing: { sha?: string; attemptId: string; agent: AgentInfo; method: LandingMethod },
): { path: string; content: string } {
  const slug = slugify(intent.title) || slugify(intent.id);
  const front = [
    "---",
    `id: ${yq(intent.id)}`,
    `title: ${yq(intent.title)}`,
    "status: landed",
    `version: ${intent.version}`,
    `landed_by: ${yq(`${landing.agent.callsign} (${landing.agent.id})`)}`,
    `method: ${landing.method}`,
    `attempt: ${yq(landing.attemptId)}`,
    ...(landing.sha ? [`sha: ${yq(landing.sha)}`] : []),
    `priority: ${intent.priority ?? "normal"}`,
    "---",
  ];
  const lines = [...front, "", `# ${oneLine(intent.title)}`, "", "## Goal", "", (intent.goal ?? "").trim() || "_No goal text._", ""];
  lines.push("## Constraints", "");
  if (intent.constraints?.length) for (const c of intent.constraints) lines.push(`- ${oneLine(c)}`);
  else lines.push("_None._");
  lines.push("", "## Checks", "");
  if (intent.checks?.length) for (const c of intent.checks) lines.push(`- \`${c.path}\` — ${oneLine(c.description)}`);
  else lines.push("_None._");
  lines.push("", "## Amendments", "");
  if (intent.amendments?.length) {
    for (const a of intent.amendments) {
      const when = Number.isFinite(a.at) ? new Date(a.at).toISOString() : "";
      lines.push(`- v${a.version} · ${oneLine(a.by?.name || a.by?.id || "unknown")} (${a.by?.kind ?? "unknown"})${when ? ` · ${when}` : ""}: ${oneLine(a.reason)} — ${oneLine(a.text)}`);
    }
  } else lines.push("_None._");
  return { path: `.bearing/intents/${slug}.md`, content: `${lines.join("\n")}\n` };
}

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*):\s?(.*)$/;

/**
 * Trailers of a commit message: "Key: value" lines of the last paragraph.
 * Continuation lines (leading whitespace) extend the previous value. Later keys win.
 */
export function parseTrailers(message: string): Record<string, string> {
  const paragraphs = (message ?? "").replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  if (paragraphs.length < 2) return {};
  const last = paragraphs[paragraphs.length - 1].split("\n");
  const out: Record<string, string> = {};
  let key: string | undefined;
  for (const line of last) {
    if (/^\s/.test(line) && key) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
      continue;
    }
    const m = TRAILER.exec(line);
    if (!m) return {}; // not a trailer block
    key = m[1];
    out[key] = m[2].trim();
  }
  return out;
}
