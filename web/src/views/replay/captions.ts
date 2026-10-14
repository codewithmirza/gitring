/**
 * Replay words: one plain caption per step, and the names and lines of the "Inside gitring" stages.
 * Every sentence follows ASD-STE100: at most 20 words, active voice, no "-ing" forms. Callsigns, paths,
 * commit ids and numbers are identifiers. Task titles stay in quotes: they are the words of people.
 *
 * Pure module (no React, no DOM): the tests check every caption with the STE checker.
 */
import type { CorrectionKind, LandingMethod, Range, Verdict } from "../../../../src/core/types";
import { RANGE_TEXT } from "../../state/format";

/**
 * The stages of the "Inside gitring" pipeline, in order. "note" is not a station of the pipeline: a note of
 * the project (it is ready, a person pauses a task) lights no station.
 */
export type Stage = "task" | "plan" | "check" | "request" | "work" | "tests" | "queue" | "composed" | "compose" | "commit" | "replot" | "note";

export const STAGES: Stage[] = ["task", "plan", "check", "request", "work", "tests", "queue", "composed", "compose", "commit", "replot"];

export const STAGE_NAME: Record<Stage, string> = {
  task: "Task",
  plan: "Plan",
  check: "Conflict check",
  request: "Change request",
  work: "Work",
  tests: "Tests alone",
  queue: "Merge queue",
  composed: "Tests on main + work",
  compose: "Compose",
  commit: "Commit + why-record",
  replot: "Other work moves",
  note: "Note",
};

/** What gitring does at each stage, in one sentence. */
export const STAGE_LINE: Record<Stage, string> = {
  task: "A person or an agent writes a task with its tests.",
  plan: "The agent sends its plan before it writes code.",
  check: "gitring compares the plan with the 20 nearest plans.",
  request: "One side adapts. Its agent gets a change request.",
  work: "The agent writes code in its own work copy.",
  tests: "The tests of the task run on the work alone.",
  queue: "One merge at a time. The first in the queue holds the lease.",
  composed: "The tests run again on main plus the work.",
  compose: "gitring puts the work on main: fast-forward or 3-way merge.",
  commit: "One commit on main. The why-record goes into git notes.",
  replot: "Main moved. gitring moves the other work onto the new main.",
  note: "gitring writes a note in the history of the project.",
};

const q = (title: string) => `"${title.replace(/"/g, "'")}"`;

/** "src/a.js", "src/a.js and src/b.js", "src/a.js, src/b.js and 3 more files". */
export function fileList(files: string[]): string {
  if (!files.length) return "no file";
  if (files.length === 1) return files[0];
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  return `${files[0]}, ${files[1]} and ${files.length - 2} more ${files.length - 2 === 1 ? "file" : "files"}`;
}

/** "KESTREL-4", "KESTREL-4 and HERON-2", "KESTREL-4, HERON-2 and PETREL-7". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "other agents";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function taskCaption(by: string, title: string): string {
  return `${by} opens the task ${q(title)}.`;
}

export function planCaption(agent: string, title: string, files: number, redo: boolean): string {
  if (redo) return `${agent} does the task ${q(title)} again on the new main.`;
  return `${agent} sends a plan for ${q(title)}. The plan names ${files} ${files === 1 ? "file" : "files"}.`;
}

/** The caption of a conflict check: the verdict and the nearest other work. */
export function checkCaption(o: { agent: string; verdict: Verdict; range?: Range; other?: string; adapts?: string }): string {
  const head = `Conflict check for ${o.agent}`;
  if (o.verdict === "merge-intents") return `${head}: ${o.other ?? "other work"} does the same task.`;
  if (o.verdict === "escalate") return `${head}: the risk is not clear. A person decides.`;
  if (o.range === undefined) return `${head}: no other work is near. The plan is clear.`;
  const where = `distance ${o.range}, ${RANGE_TEXT[o.range]}${o.other ? ` with ${o.other}` : ""}`;
  if (o.verdict === "clear") return `${head}: ${where}. No conflict.`;
  return `${head}: ${where}. ${o.adapts ?? o.agent} must adapt.`;
}

const REQUEST_WHAT: Record<CorrectionKind, string> = {
  region: "keep out of the same lines",
  interface: "use the new form of a shared function",
  duplicate: "another agent does the same task",
  upstream: "read the merged change",
  "intent-amended": "the task changed",
  review: "a person sent the work back",
};

export function requestCaption(kind: CorrectionKind, to: string, from?: string): string {
  if (kind === "upstream") return `Main moved. gitring sends a change request to ${to}: read the merged change.`;
  if (kind === "review") return `A person sends the work of ${to} back with a note.`;
  if (kind === "intent-amended") return `The task changed. gitring sends a change request to ${to}.`;
  return `gitring sends a change request to ${to}: ${REQUEST_WHAT[kind]}.${from ? ` ${from} continues.` : ""}`;
}

export function deliverCaption(to: string): string {
  return `The change request reaches ${to} in its next answer from gitring.`;
}

export function ackCaption(agent: string): string {
  return `${agent} applies the change request and confirms it.`;
}

export function workCaption(kind: "write" | "log" | "push", agent: string, files: string[], byGitring = false): string {
  if (byGitring) return `gitring saves the work of ${agent} as a commit in its work copy.`;
  if (kind === "write") return `${agent} writes ${fileList(files)}.`;
  if (kind === "push") return `${agent} pushes its work${files.length ? `: ${fileList(files)}` : ""}.`;
  return `${agent} reports its work${files.length ? ` on ${fileList(files)}` : ""}.`;
}

export function testsCaption(agent: string, scope: "attempt" | "composed", passed: number, total: number, ok: boolean): string {
  const what = scope === "attempt" ? `the work of ${agent} alone` : `main plus the work of ${agent}`;
  const head = `gitring tests ${what}: ${passed} of ${total} ${total === 1 ? "test passes" : "tests pass"}.`;
  if (ok) return head;
  return scope === "attempt" ? `${head} ${agent} must fix the code.` : `${head} The work cannot merge now.`;
}

export function testsWaitCaption(agent: string): string {
  return `The test budget for this hour is used. The tests of ${agent} wait.`;
}

export type SubmitOutcome = "queue" | "approval" | "fix";

export function submitCaption(agent: string, title: string, outcome: SubmitOutcome): string {
  if (outcome === "approval") return `${agent} submits ${q(title)}. A person must say yes before the merge.`;
  if (outcome === "fix") return `${agent} submits ${q(title)}. Tests fail, so the work goes back to ${agent}.`;
  return `${agent} submits ${q(title)}. The work goes into the merge queue.`;
}

export function pickCaption(by: string, agent: string): string {
  return `${by} chooses the work of ${agent}. It goes into the merge queue.`;
}

export function leaseCaption(agent: string): string {
  return `The merge queue gives the lease to ${agent}. One merge runs at a time.`;
}

export function composeCaption(agent: string, method: LandingMethod): string {
  if (method === "fast-forward") return `Main did not move. gitring puts the work of ${agent} on top of main: a fast-forward.`;
  if (method === "merge") return `Main moved after the plan of ${agent}. gitring joins the work and main with a 3-way merge.`;
  return `gitring puts the redo of ${agent} on the new main.`;
}

export function commitCaption(title: string, sha: string): string {
  return `${q(title)} is on main now as commit ${sha.slice(0, 7)}. Its why-record goes into git notes.`;
}

export function replotCaption(agents: string[]): string {
  return `Main moved. gitring moves the work of ${nameList(agents)} onto the new main.`;
}

export function staleCaption(agent: string): string {
  return `The work of ${agent} cannot merge on the new main.`;
}

export function endCaption(agent: string, title: string, why: "alternate" | "abandoned" | "failed"): string {
  if (why === "alternate") return `Another work copy of ${q(title)} merged first. ${agent} stops.`;
  if (why === "failed") return `The work of ${agent} on ${q(title)} failed.`;
  return `${agent} stops the work on ${q(title)}.`;
}

export function redoAskCaption(by: string, title: string): string {
  return `${by} asks for a redo of ${q(title)} on the new main.`;
}

/* ───────────── title and end cards ───────────── */

export function introLine(tasks: number, agents: number, merges: number): string {
  return `${tasks} ${tasks === 1 ? "task" : "tasks"}, ${agents} ${agents === 1 ? "agent" : "agents"}, ${merges} ${merges === 1 ? "merge" : "merges"}. This is the real history of the project.`;
}

export function endLine(checks: number, requests: number, merges: number): string {
  return `${checks} conflict ${checks === 1 ? "check" : "checks"}, ${requests} change ${requests === 1 ? "request" : "requests"}, ${merges} ${merges === 1 ? "merge" : "merges"}. Each merge has a why-record in git notes.`;
}
