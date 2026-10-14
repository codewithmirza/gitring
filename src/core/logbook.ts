/**
 * History: the record of why each merge happened.
 *
 *  - landingMessage: commit message = subject (intent title) + short body + gitring-* trailers.
 *  - landingNote:    git note (refs/notes/gitring) = pretty JSON, schema "gitring.logbook/v1".
 *  - intentFile:     `.gitring/intents/<slug>.md` with YAML front matter (optional in-repo copy).
 *  - parseTrailers:  read the trailers back from any commit message.
 *
 * Pure module.
 */
import type { AgentInfo, Attempt, CheckRun, Correction, CourseCheck, Decision, Intent, LandingMethod } from "./types";

export const LOGBOOK_SCHEMA = "gitring.logbook/v1";
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

/** A merge that rode in a train: its place and the size of the train, and every work copy of the train. */
export interface TrainInfo {
  id: string;
  place: number;
  size: number;
  attemptIds: string[];
}

/** Commit message: subject, blank line, short body, blank line, gitring-* trailers. */
export function landingMessage(args: {
  intent: Intent;
  attempt: Attempt;
  agent: AgentInfo;
  method: LandingMethod;
  corrections: Correction[];
  checks: CheckRun;
  /** The merge rode in a train of independent work. */
  train?: TrainInfo;
  /** The tests of main plus the work run after the merge (post-merge test mode). */
  testsAfter?: boolean;
}): string {
  const { intent, attempt, agent, method, corrections, checks, train, testsAfter } = args;
  const generation = attempt.lineage?.generation ?? 1;
  const { passed, total } = checksTotal(checks);
  const body: string[] = [];
  const summary = summaryOf(attempt, intent);
  if (summary) body.push(wrap(summary));
  const rederived = attempt.lineage?.rederivedFrom ? ` (a redo of ${attempt.lineage.rederivedFrom})` : "";
  const how = method === "rederive" ? "a redo on the new main" : method === "merge" ? "a 3-way merge" : "a fast-forward";
  const tests = testsAfter ? `Tests of the work: ${passed}/${total} pass. Main is tested after the merge.` : `Tests: ${passed}/${total} pass.`;
  body.push(
    [
      wrap(`Merged by gitring: work of ${oneLine(agent.callsign)}, ${how}${train ? ` (train ${train.place} of ${train.size})` : ""}.`),
      `Try ${generation}${rederived}.`,
      `Change requests: ${corrections.length}. ${tests}`,
    ].join("\n"),
  );
  const trailers = [
    `Gitring-Intent: ${oneLine(intent.id)}`,
    `Gitring-Attempt: ${oneLine(attempt.id)}`,
    `Gitring-Agent: ${oneLine(agent.callsign)} (${oneLine(agent.id)})`,
    `Gitring-Model: ${modelOf(agent)}`,
    `Gitring-Method: ${method}`,
    `Gitring-Corrections: ${corrections.length}`,
    `Gitring-Checks: ${passed}/${total} pass`,
    `Gitring-Generation: ${generation}`,
    ...(train ? [`Gitring-Train: ${oneLine(train.id)} ${train.place}/${train.size}`] : []),
    ...(testsAfter ? ["Gitring-Tests: after"] : []),
  ];
  return `${subjectOf(intent.title)}\n\n${body.join("\n\n")}\n\n${trailers.join("\n")}\n`;
}

/**
 * The commit message of a revert: gitring takes a merge back because the tests of main failed after it
 * (post-merge test mode). The trailers name the merge and the work copy, so that the record is complete.
 */
export function revertMessage(args: { intent: Intent; attempt: Attempt; agent: AgentInfo; mergeSha: string; failed: string[]; checks: CheckRun }): string {
  const { intent, attempt, agent, mergeSha, failed, checks } = args;
  const { passed, total } = checksTotal(checks);
  const names = failed.slice(0, 5).join(", ") + (failed.length > 5 ? ` and ${failed.length - 5} more` : "");
  const body = [
    wrap(`Reverted by gitring: tests failed on main after this merge (${mergeSha.slice(0, 7)}, work of ${oneLine(agent.callsign)}).`),
    wrap(`Failed: ${names || "see the test log"}. Tests on main: ${passed}/${total} pass.`),
    "The task is open again. The agent gets a change request with the failed tests.",
  ];
  const trailers = [
    `Gitring-Intent: ${oneLine(intent.id)}`,
    `Gitring-Attempt: ${oneLine(attempt.id)}`,
    `Gitring-Agent: ${oneLine(agent.callsign)} (${oneLine(agent.id)})`,
    `Gitring-Method: revert`,
    `Gitring-Revert: ${mergeSha}`,
    `Gitring-Checks: ${passed}/${total} pass`,
  ];
  return `${subjectOf(`Revert "${intent.title}"`)}\n\n${body.join("\n\n")}\n\n${trailers.join("\n")}\n`;
}

/** Git note of a revert: the why-record ("reverted: tests failed on main"), with the tests that failed. */
export function revertNote(args: { intent: Intent; attempt: Attempt; agent: AgentInfo; mergeSha: string; landingId: string; checks: CheckRun; approvedBy?: string }): string {
  const { intent, attempt, agent, mergeSha, landingId, checks, approvedBy } = args;
  const note = {
    schema: LOGBOOK_SCHEMA,
    intent: { id: intent.id, title: intent.title, goal: intent.goal, version: intent.version },
    attempt: { id: attempt.id, generation: attempt.lineage?.generation ?? 1, base: { sha: attempt.baseSha, tree: attempt.baseTree } },
    agent: { id: agent.id, callsign: agent.callsign, kind: agent.kind, model: agent.model ?? null, client: agent.client ?? null },
    method: "revert",
    revert: {
      reason: "reverted: tests failed on main",
      of: { landing: landingId, commit: mergeSha },
      ...(approvedBy ? { approvedBy } : {}),
    },
    checks: {
      scope: "main",
      passed: checks?.passed ?? 0,
      failed: checks?.failed ?? 0,
      cases: (checks?.cases ?? []).filter((c) => !c.ok).map((c) => ({ file: c.file, name: c.name, ok: c.ok, ...(c.error ? { error: c.error } : {}) })),
    },
  };
  return `${JSON.stringify(note, null, 2)}\n`;
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
  train?: TrainInfo;
  testsAfter?: boolean;
}): string {
  const { intent, attempt, agent, method, corrections, courseChecks, checks, decision, train, testsAfter } = args;
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
      ...(c.alsoStandOn?.length ? { alsoStandOn: c.alsoStandOn } : {}),
      // The note is written at the merge: a change request that the agent did not confirm closes with it.
      status: c.status === "pending" || c.status === "delivered" ? "closed" : c.status,
      ...(c.ackNote ? { ackNote: c.ackNote } : {}),
      ...(c.check ? { check: { applied: c.check.applied, reason: c.check.reason } } : {}),
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
      // "after": the tests of the work alone; main is tested after the merge (post-merge test mode).
      ...(testsAfter ? { when: "after" } : {}),
      passed: checks?.passed ?? 0,
      failed: checks?.failed ?? 0,
      cases: (checks?.cases ?? []).map((c) => ({ file: c.file, name: c.name, ok: c.ok, ...(c.error ? { error: c.error } : {}) })),
    },
    decision: decision ?? null,
    ...(train ? { train: { id: train.id, place: train.place, size: train.size, attempts: train.attemptIds } } : {}),
  };
  return `${JSON.stringify(note, null, 2)}\n`;
}

/** YAML double-quoted scalar (JSON escapes are valid YAML escapes). */
const yq = (s: string): string => JSON.stringify(s ?? "");

/** `.gitring/intents/<slug>.md`: the intent as it landed, with YAML front matter. */
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
  return { path: `.gitring/intents/${slug}.md`, content: `${lines.join("\n")}\n` };
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
