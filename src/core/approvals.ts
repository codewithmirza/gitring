/**
 * Approvals: the rules of "a person must say yes before this work merges".
 *
 * An approval is a merge that waits for a person. These functions are pure: the project object, the
 * Worker, the MCP tools and the web app all use them, so they all say the same thing.
 *
 *   approvalNeeded   does this work need a person? (project setting + what the work is)
 *   riskSigns        what makes a change look risky (the "risky" setting)
 *   canDecide        who may answer
 *   approvalLine     one plain sentence about the work, for a card or a chat question
 *   waitingText      the text an agent reads while its work waits
 *
 * Words are plain (ASD-STE100): short sentences, no internal names.
 */
import type { Approval, ApprovalReason, ApproverRule, Attempt, CheckRun, LandingMode } from "./types";
import { noTestRan } from "./types";
import { atLeast, type Role } from "./accounts";
import { SAFE_KINDS, kindWords } from "./analysis/meaning";
import { ruleReasons, type RuleVerdict } from "./coord/folder-rules";

/** Files that build, run or deploy the code. A change there can break more than the task. */
const BUILD_OR_DEPLOY = /(^|\/)(\.github\/|package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|wrangler\.(toml|json|jsonc)$|Dockerfile[^/]*$|docker-compose[^/]*$|\.env[^/]*$|migrations\/)/;

/** A change this large is risky for a person to skip. */
export const LARGE_FILES = 15;
export const LARGE_LINES = 600;

/** "a, b, c" for up to three names, then "and N more". */
function listOf(items: string[], max = 3): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** The name of a symbol key: "src/a.js#price" gives "price". */
function nameOf(symbol: string): string {
  const at = symbol.lastIndexOf("#");
  return at >= 0 ? symbol.slice(at + 1) : symbol;
}

/**
 * What makes a change look risky. Each sign is one plain sentence. No sign means the change looks safe.
 * These signs only raise the need for a person. A change that shows none can still be wrong: the tests decide that.
 * A change of comments, formatting or documentation only (see core/analysis/meaning.ts) shows no sign.
 */
export function riskSigns(a: Pick<Attempt, "footprint" | "stats" | "meaning">): string[] {
  const signs: string[] = [];
  if (a.meaning && SAFE_KINDS.has(a.meaning.kind)) return signs;
  const changed = a.footprint.symbols.signatureChanged;
  if (changed.length) {
    signs.push(`The parameters of ${listOf([...new Set(changed.map(nameOf))])} change. Other code can call ${changed.length === 1 ? "it" : "them"}.`);
  }
  const paths = Object.keys(a.footprint.files);
  const build = paths.filter((p) => BUILD_OR_DEPLOY.test(p));
  if (build.length) signs.push(`Build or deploy files change: ${listOf(build)}.`);
  const gone = paths.filter((p) => a.footprint.files[p]?.status === "D");
  if (gone.length) signs.push(`Files are deleted: ${listOf(gone)}.`);
  const lines = a.stats.additions + a.stats.deletions;
  if (a.stats.filesChanged >= LARGE_FILES || lines >= LARGE_LINES) {
    signs.push(`This is a large change: ${a.stats.filesChanged} files, ${lines} lines.`);
  }
  return signs;
}

/**
 * Does the work need a person before it merges? The project setting says "automatic", "risky" or "ask".
 * Two things need a person in every mode: no test ran (nothing is verified), and other work copies that
 * compete on the same task (a person chooses one).
 *
 * The rules by folder (`rules`, see core/coord/folder-rules.ts) come on top: a rule that needs the yes of
 * an owner makes the question one for owners only (`ownerOnly`). Work that is all under "no yes needed"
 * rules skips the questions of the setting and of a missing test; competing work copies still need a person.
 */
export function approvalNeeded(i: { mode: LandingMode; untested: boolean; competing: number; signs: string[]; rules?: RuleVerdict }): { reason: ApprovalReason; why: string[]; ownerOnly?: boolean } | null {
  const why: string[] = [];
  const ruled = Boolean(i.rules && (i.rules.ownerYes.length || i.rules.notAllowed.length));
  const noYes = Boolean(i.rules?.noYes);
  if (i.untested && !noYes) why.push("No test ran. The work is not verified.");
  if (i.competing > 0) why.push(`${i.competing + 1} work copies compete on this task. A person chooses one.`);
  if (ruled) why.push(...ruleReasons(i.rules!));
  if (noYes) {
    /* a rule of the project: no yes of a person for this work */
  } else if (i.mode === "ask") why.push("This project asks a person before every merge.");
  else if (i.mode === "risky") why.push(...i.signs);
  if (!why.length) return null;
  const reason: ApprovalReason = i.untested && !noYes ? "no-test-ran" : i.competing > 0 ? "competing" : ruled ? "folder-rule" : i.mode === "ask" ? "project-asks" : "looks-risky";
  return { reason, why, ...(ruled ? { ownerOnly: true } : {}) };
}

/**
 * Who may answer an approval. A viewer never. An owner always. Another member only when the rule is
 * "sender" and they are the person who sent the agent, or when no person sent it (old work, or work that
 * no person started). A question for owners only (a rule by folder) has no other answer.
 */
export function canDecide(approval: Pick<Approval, "approver" | "ownerOnly"> | undefined, who: { id: string | null | undefined; role: Role | null | undefined }, rule: ApproverRule = "sender"): boolean {
  if (!who.id || !atLeast(who.role, "member")) return false;
  if (who.role === "owner") return true;
  if (rule === "owner" || approval?.ownerOnly) return false;
  return !approval?.approver || approval.approver.id === who.id;
}

/** "12 of 12 tests pass.", "No test ran.", "Tests did not run yet." */
export function testsLine(run: CheckRun | undefined): string {
  if (!run) return "Tests did not run yet.";
  if (run.wait) return "Tests wait for the hourly test budget.";
  if (noTestRan(run)) return "No test ran.";
  if (run.runner === "container") return run.ok ? "Tests pass." : "Tests fail.";
  const total = run.passed + run.failed;
  return run.ok ? `${run.passed} of ${total} tests pass.` : `${run.failed} of ${total} tests fail.`;
}

/** What a person needs to know at a glance: the size of the change, the tests, and what kind of change it is. */
export function approvalLine(a: Pick<Attempt, "stats" | "checks" | "composedChecks" | "meaning">): string {
  const n = a.stats.filesChanged;
  const size = `${n} ${n === 1 ? "file" : "files"}, +${a.stats.additions} -${a.stats.deletions}`;
  const kind = a.meaning && n > 0 ? ` ${kindWords(a.meaning.kind)}` : "";
  return `${size}. ${testsLine(a.composedChecks ?? a.checks)}${kind}`;
}

/** The question that a chat card shows: short, with the facts (`line` is approvalLine), and the reason to ask. */
export function approvalQuestion(title: string, line: string, approval: Pick<Approval, "why">): string {
  return `Merge "${title}" into main? ${line} ${approval.why[0] ?? ""}`.trim();
}

/** The path in the gitring app where a person answers the approval of a work copy. */
export function approvalPath(projectId: string, attemptId: string): string {
  return `/approve/${encodeURIComponent(attemptId)}?project=${encodeURIComponent(projectId)}`;
}

/** Plain answer for a status word. */
export const APPROVAL_WORD: Record<Approval["status"], string> = {
  waiting: "waits for a person",
  approved: "approved",
  "sent-back": "sent back",
  withdrawn: "withdrawn",
};

/**
 * What an agent reads while its work waits for a person. It says what happened, who answers, where, and
 * what the agent does next. `link` is the address where the person answers (the gitring app). `check` is
 * the plain sentence that names the tool that shows the answer (each tool set has its own). `header` replaces
 * the first line (the GitHub-compatible tools start with the pull request). `app`: the person answers only in
 * the gitring app.
 */
export function waitingText(i: { title: string; approval: Pick<Approval, "why" | "approver">; line: string; link: string; check: string; asked?: boolean; header?: string; app?: boolean }): string {
  const who = i.approval.approver?.name ?? "A person of the project";
  return [
    i.header ?? "A PERSON MUST SAY YES. The work is not merged yet.",
    `${who} must say yes to this work: "${i.title}". ${i.line}`,
    ...i.approval.why.map((w) => `Why: ${w}`),
    // `app`: the person chose to answer in the gitring app only (approvalsIn "app"). gitring does not ask in the chat.
    i.app ? "The person answers in the gitring app only. gitring does not ask in this chat." : i.asked ? "gitring asked in this chat. The person did not answer there." : "The person answers in gitring.",
    `Link: ${i.link}`,
    "Do not change the work copy while you wait. A change cancels the question.",
    `${i.check} Do not stop the task: tell the person that the work waits.`,
  ].join("\n");
}
