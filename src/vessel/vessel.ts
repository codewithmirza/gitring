/**
 * The agent runner (Vessel): a built-in coding agent, one Durable Object for each work copy run.
 * Called by HarborTasks.startVessel (src/harbor/master/tasks.ts). It calls back through the HarborMaster RPC methods.
 * Never keep a change request that the model did not see: the vessel acknowledges a request only after the model acted on it.
 * Read next: ../platform/ai/models.ts (the model calls).
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker/env";
import type * as T from "../core/types";
import { chat, contextBudget, lastChatError, parseJsonLoose, type ChatMessage, type ToolDef } from "../platform/ai/models";
import type { HarborMaster } from "../harbor/harbor";
import { tokenWeight } from "../core/plans";

/** The HarborMaster RPC surface a vessel uses (typed as the class; RPC serializes tuples as arrays). */
type HarborApi = Pick<HarborMaster, "declare" | "log" | "write" | "read" | "list" | "check" | "submit" | "ack" | "brief" | "attemptDiff" | "giveUp">;

export interface VesselConfig {
  projectId: string;
  attemptId: string;
  intentId: string;
  agentId: string;
  callsign: string;
  model: string;
  rederiveOf?: string;
}

interface VesselState {
  config: VesselConfig;
  phase: "start" | "declared" | "working" | "submitted" | "done" | "stopped";
  step: number;
  /** LLM conversation. */
  messages: ChatMessage[];
  /** Corrections that arrived and that the model did not see yet. */
  corrections: T.CorrectionNotice[];
  /** Corrections that the model saw and did not act on yet, with the files it wrote since then. */
  open?: OpenRequest[];
  /** Ids of the corrections that this vessel acknowledged (a later answer can still list one). */
  acked?: string[];
  submits: number;
  lastError?: string;
  /** Stagnation guard: failing checks signature, repeats, and writes since the last check run. */
  checkSig?: string;
  sameChecks?: number;
  writesSinceCheck?: number;
  /** Model calls that failed in a row. */
  failStreak?: number;
}

/** A correction in the prompt of the model, and the files that the model wrote after it saw it. */
export interface OpenRequest {
  notice: T.CorrectionNotice;
  files: string[];
}

const MAX_LLM_STEPS = 30;
const MAX_SUBMITS = 5;
/** Model calls that may fail in a row before the vessel stops. */
const MAX_FAIL_STREAK = 6;
/** A tool answer keeps at least this many characters when the tool answers of a turn use up their room. */
const MIN_TOOL_CHARS = 2_000;

/**
 * It uses exactly the same protocol as external agents (declare → write/log → check → submit). Change requests
 * arrive in every answer; the vessel feeds them into its next step and keeps working (no stop, no lock). It
 * acknowledges a change request only after the model saw it and acted on it: at its next write (the note
 * names the files), or at the submit without a write ("No code change was needed").
 *
 * A vessel is a Workers AI model with tools (read, write, list, checks, log, submit). Each step runs in an
 * alarm, so a long run survives an eviction.
 */
export class Vessel extends DurableObject<Env> {
  private st?: VesselState;

  /** Metering hook: the tokens of a model call, counted for the project. One token of a dearer model counts more. */
  private countTokens(c: VesselConfig, usage: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined): void {
    const n = usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
    if (!n) return;
    try {
      const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
      void Promise.resolve(dir.usageAdd(c.projectId, "agentTokens", Math.round(n * tokenWeight(c.model)))).catch(() => undefined);
    } catch {
      /* a counter that fails never stops the work */
    }
  }

  private harbor(projectId: string): HarborApi {
    return this.env.HARBOR.get(this.env.HARBOR.idFromName(projectId)) as unknown as HarborApi;
  }

  async start(config: VesselConfig): Promise<void> {
    this.st = {
      config,
      phase: "start",
      step: 0,
      messages: [],
      corrections: [],
      submits: 0,
    };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + 300);
  }

  async stop(): Promise<void> {
    const st = await this.load();
    if (!st) return;
    st.phase = "stopped";
    await this.save();
    await this.ctx.storage.deleteAlarm();
  }

  async status(): Promise<{ phase: string; step: number; lastError?: string; model: string; messages: number; submits: number; lastReply?: string } | null> {
    const st = await this.load();
    if (!st) return null;
    const last = [...st.messages].reverse().find((m) => m.role === "assistant");
    return {
      phase: st.phase,
      step: st.step,
      lastError: st.lastError,
      model: st.config.model,
      messages: st.messages.length,
      submits: st.submits,
      lastReply: last ? `${(last.content ?? "").slice(0, 300)}${last.tool_calls?.length ? ` [tools: ${last.tool_calls.map((t) => t.function.name).join(", ")}]` : ""}` : undefined,
    };
  }

  async alarm(): Promise<void> {
    const st = await this.load();
    if (!st || st.phase === "done" || st.phase === "stopped") return;
    const phase0 = st.phase;
    let delay = 200;
    try {
      const more = await this.llmStep(st);
      if (!more) st.phase = "done";
    } catch (err) {
      st.lastError = String(err).slice(0, 500);
      console.warn("vessel step failed", st.config.callsign, st.lastError);
      delay = 4000;
      if (st.step > 60) st.phase = "done";
    }
    if ((st.failStreak ?? 0) >= MAX_FAIL_STREAK) st.phase = "done";
    st.step += 1;
    // Storage keeps only the history that the next turns can send: the oldest turns never go to the model
    // again, and one value in storage holds at most 2 MB.
    st.messages = trimMessages(st.messages, contextBudget(st.config.model).turnChars);
    if ((st.phase as string) === "done") {
      // Work that did not reach "ready" leaves the traffic; the attempt fails with the reason.
      const why =
        (st.failStreak ?? 0) >= MAX_FAIL_STREAK
          ? `the model ${st.config.model} did not answer ${st.failStreak} times in a row (${st.lastError ?? "no answer"}).`
          : st.submits >= MAX_SUBMITS
            ? `${st.submits} submits, and the checks still fail.`
            : `the agent finished after ${st.step} steps without work that passes the checks.`;
      await this.harbor(st.config.projectId)
        .giveUp(st.config.attemptId, why)
        .catch(() => undefined);
    }
    await this.save();
    if ((st.phase as string) !== "done" && (st.phase as string) !== "stopped") await this.ctx.storage.setAlarm(Date.now() + delay);
    void phase0;
  }

  // ───── Model steps ─────

  private async llmStep(st: VesselState): Promise<boolean> {
    if (st.phase === "start") return this.planStep(st);
    if (st.phase === "working") return this.workStep(st);
    if (st.phase === "submitted") return this.submitStep(st);
    return false;
  }

  /** The first step: read the brief, ask the model for a plan, and declare it. */
  private async planStep(st: VesselState): Promise<boolean> {
    const c = st.config;
    const h = this.harbor(c.projectId);
    // A model with a large context (GLM 5.3) gets far more file text in its first prompt.
    const brief = await h.brief(c.attemptId, c.intentId, { model: c.model });
    let prior = "";
    if (c.rederiveOf) {
      try {
        const diff = await h.attemptDiff(c.rederiveOf);
        prior = diff.files.map((f) => f.diff).join("\n").slice(0, 12_000);
      } catch {
        /* no prior diff */
      }
    }
    st.messages = [
      { role: "system", content: systemPrompt(c.callsign, brief.runner) },
      { role: "user", content: briefPrompt(brief, prior) },
    ];
    // The plan is the hard part: the model thinks more ("high") than in a routine tool turn ("low"), so the
    // call gets more time (up to 16,384 reasoning tokens before the answer).
    const plan = await chat(this.env.AI as never, c.model, [...st.messages, { role: "user", content: COURSE_REQUEST }], {
      maxTokens: 1200,
      temperature: 0.2,
      timeoutMs: 240_000,
      reasoning: "high",
    });
    this.countTokens(c, plan?.usage);
    if (!plan) st.lastError = `planning call failed: ${lastChatError ?? "no answer"}`;
    const course = parseJsonLoose<{ plan?: string[]; files?: string[]; symbols?: string[]; approach?: string }>(plan?.message.content) ?? {};
    const res = await h.declare({
      attemptId: c.attemptId,
      intentId: c.intentId,
      agent: { id: c.agentId, kind: "builtin", model: c.model },
      plan: (course.plan ?? ["Read the code", "Change the code", "Run the checks"]).slice(0, 8),
      files: course.files ?? brief.intent.scope?.paths ?? [],
      symbols: course.symbols ?? [],
      approach: course.approach ?? `Implement "${brief.intent.title}".`,
      mode: "api",
    });
    st.messages.push({ role: "assistant", content: `My plan: ${JSON.stringify({ plan: course.plan, files: course.files, symbols: course.symbols, approach: course.approach })}` });
    st.messages.push({ role: "user", content: clearanceText(res.clearance) + "\nNow do the work with the tools." });
    // The clearance text holds its change requests: the model sees them in its next turn.
    this.show(st, res.clearance.corrections ?? []);
    st.phase = "working";
    return true;
  }

  /** One turn of work: the model answers with tool calls, and the tools run. False: the vessel is done. */
  private async workStep(st: VesselState): Promise<boolean> {
    const c = st.config;
    if (st.step > MAX_LLM_STEPS) {
      st.phase = "submitted";
      return true;
    }
    const budget = contextBudget(c.model);
    const turn = withOpenRequests(trimMessages(st.messages, budget.turnChars), st.open ?? []);
    const res = await chat(this.env.AI as never, c.model, turn, { tools: TOOLS, toolChoice: "auto", maxTokens: 6000, temperature: 0.2, timeoutMs: 150_000, reasoning: "low" });
    if (!res) {
      st.failStreak = (st.failStreak ?? 0) + 1;
      st.lastError = `model call failed: ${lastChatError ?? "no answer"}`;
      // Rate limits on paid models: wait longer before the next turn.
      if (/429|rate|capacity|busy|3040|5035/i.test(lastChatError ?? "")) await new Promise((r) => setTimeout(r, 12_000));
      return true;
    }
    st.failStreak = 0;
    this.countTokens(c, res.usage);
    const msg = res.message;
    st.messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) {
      st.messages.push({ role: "user", content: "Use the tools. Write the files with write_file, run run_checks, then call submit." });
      this.showNew(st);
      return true;
    }
    // All the tool answers of one turn share a limit too (a model can call read_file many times in one turn).
    let room = budget.turnToolChars;
    for (const call of msg.tool_calls) {
      const out = await this.runTool(st, call.function.name, safeArgs(call.function.arguments), msg.content);
      const text = out.text.slice(0, Math.min(budget.toolChars, Math.max(MIN_TOOL_CHARS, room)));
      room -= text.length;
      st.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: text });
      if (out.done) {
        st.phase = "done";
        return false;
      }
    }
    // The model wrote files after it saw a change request: it acted on the request.
    await this.ackActed(st);
    const recent = st.messages.slice(-8).filter((m) => m.role === "tool").map((m) => m.name);
    if (recent.filter((n) => n === "write_file").length >= 2 && !recent.includes("run_checks")) {
      st.messages.push({ role: "user", content: "Run run_checks now. The checks are the contract: make every assertion pass." });
    }
    this.showNew(st);
    return true;
  }

  /** The step limit sends the work to the merge, or a submit that came back with failing checks sends it again. */
  private async submitStep(st: VesselState): Promise<boolean> {
    const c = st.config;
    const h = this.harbor(c.projectId);
    if (st.submits >= MAX_SUBMITS) return false;
    st.submits += 1;
    // The step limit sends the work, not the model: a request that the model did not act on stays open
    // (the model did not say that it needs no change).
    await this.ackActed(st);
    const res = await h.submit(c.attemptId, "Work complete.");
    this.absorb(st, res.clearance);
    return res.next === "fix-checks" && st.submits < MAX_SUBMITS ? (st.phase = "working", true) : false;
  }

  /** One tool call of the model. `said`: the text of the model in the same turn (the reason for a submit). */
  private async runTool(st: VesselState, name: string, args: Record<string, unknown>, said?: string | null): Promise<{ text: string; done?: boolean }> {
    const c = st.config;
    const h = this.harbor(c.projectId);
    switch (name) {
      case "read_file": {
        const r = await h.read(c.attemptId, String(args.path ?? ""));
        return { text: r.content ?? `The file ${r.path} does not exist.` };
      }
      case "list_files": {
        return { text: (await h.list(c.attemptId, args.dir ? String(args.dir) : undefined)).join("\n") };
      }
      case "write_file":
        return this.writeFileTool(st, args);
      case "run_checks":
        return this.runChecksTool(st);
      case "log_progress": {
        const clr = await h.log({ attemptId: c.attemptId, message: String(args.message ?? "progress"), files: Array.isArray(args.files) ? (args.files as string[]) : undefined });
        this.absorb(st, clr);
        return { text: clr.advice };
      }
      case "submit": {
        st.submits += 1;
        await this.ackBeforeSubmit(st, firstLine(said) || firstLine(String(args.summary ?? "")));
        const res = await h.submit(c.attemptId, String(args.summary ?? "Work complete."));
        this.absorb(st, res.clearance);
        if (res.next === "fix-checks" && st.submits < MAX_SUBMITS) return { text: res.message };
        return { text: res.message, done: true };
      }
      default:
        return { text: `Unknown tool ${name}.` };
    }
  }

  /** The write_file tool: gitring writes the file, and the answer says what happened. */
  private async writeFileTool(st: VesselState, args: Record<string, unknown>): Promise<{ text: string }> {
    const c = st.config;
    const h = this.harbor(c.projectId);
    const res = await h.write({ attemptId: c.attemptId, files: [{ path: String(args.path ?? ""), content: String(args.content ?? "") }], message: String(args.note ?? "") });
    this.absorb(st, res.clearance);
    if (res.written.length) {
      st.writesSinceCheck = (st.writesSinceCheck ?? 0) + 1;
      for (const o of st.open ?? []) for (const f of res.written) if (!o.files.includes(f)) o.files.push(f);
    }
    const notes = [
      `Written: ${res.written.join(", ") || "nothing"}.`,
      res.merged?.length ? `Main moved after your last read: gitring merged your write with the landed changes in ${res.merged.join(", ")}. Read the file again before the next edit.` : "",
      ...(res.refused ?? []).map((r) => `Not written: ${r.reason}`),
      res.written.length || res.refused?.length ? "" : "The path is protected or not valid.",
      res.clearance.advice,
    ];
    return { text: notes.filter(Boolean).join(" ") };
  }

  /** The run_checks tool. The same failure twice in a row, or no new write, gets a hint instead of a new run. */
  private async runChecksTool(st: VesselState): Promise<{ text: string }> {
    const c = st.config;
    const h = this.harbor(c.projectId);
    if (st.checkSig && (st.writesSinceCheck ?? 0) === 0) {
      return { text: `No file changed since the last run, so the result is the same:\n${st.checkSig}\nWrite a fix with write_file before you run the checks again.` };
    }
    const run = await h.check(c.attemptId);
    const failed = run.cases.filter((x) => !x.ok).slice(0, 8);
    const sig = failed.map((f) => `FAIL ${f.file} › ${f.name}: ${f.error ?? ""}`).join("\n");
    st.writesSinceCheck = 0;
    st.sameChecks = sig && sig === st.checkSig ? (st.sameChecks ?? 0) + 1 : 0;
    st.checkSig = sig || undefined;
    let text = `${run.passed}/${run.passed + run.failed} checks pass.${run.error ? ` Runner error: ${run.error}` : ""}\n${sig}`;
    if ((st.sameChecks ?? 0) >= 1 && sig) {
      text +=
        "\nThe same checks fail again after your last change. Stop and compare: read each 'expected X to be Y'. " +
        "Find the line of code that produces X. Check the units and the arithmetic step by step. Change that computation, then write the file.";
    }
    return { text };
  }

  // ───── Shared helpers ─────

  /** Keep the new corrections of an answer (gitring lists a correction again until the vessel acknowledges it). */
  private absorb(st: VesselState, clr: T.Clearance | undefined): void {
    if (!clr?.corrections?.length) return;
    for (const n of clr.corrections) {
      if (st.corrections.some((x) => x.id === n.id) || st.open?.some((o) => o.notice.id === n.id) || st.acked?.includes(n.id)) continue;
      st.corrections.push(n);
    }
  }

  /** The model has these corrections in its prompt now: they wait for its next write or its submit. */
  private show(st: VesselState, notices: T.CorrectionNotice[]): void {
    const open = (st.open ??= []);
    for (const n of notices) if (!open.some((o) => o.notice.id === n.id) && !st.acked?.includes(n.id)) open.push({ notice: n, files: [] });
    const shown = new Set(notices.map((n) => n.id));
    st.corrections = st.corrections.filter((n) => !shown.has(n.id));
  }

  /** New change requests go into the prompt now. gitring hears about them when the model acts on them. */
  private showNew(st: VesselState): void {
    if (!st.corrections.length) return;
    st.messages.push({ role: "user", content: correctionsText(st.corrections) });
    this.show(st, st.corrections);
  }

  /** Acknowledge each open correction that the model acted on: it wrote files after it saw the request. */
  private async ackActed(st: VesselState): Promise<void> {
    for (const o of [...(st.open ?? [])]) if (o.files.length) await this.ack(st, o, changedNote(o.files));
  }

  /**
   * Before a submit: acknowledge the corrections that the model acted on, and say for the others that no code
   * change was needed (the model submits without a write since it saw them). `line`: the reason of the model.
   */
  private async ackBeforeSubmit(st: VesselState, line: string): Promise<void> {
    // The requests that are open now (an answer below can open a request again: it waits for a new write).
    for (const o of [...(st.open ?? [])]) await this.ack(st, o, o.files.length ? changedNote(o.files) : `No code change was needed: ${line || "the work meets the request."}`);
  }

  private async ack(st: VesselState, o: OpenRequest, note: string): Promise<void> {
    st.open = (st.open ?? []).filter((x) => x !== o);
    st.acked = [...(st.acked ?? []), o.notice.id].slice(-100);
    const res: unknown = await this.harbor(st.config.projectId)
      .ack(st.config.attemptId, o.notice.id, note)
      .catch(() => undefined);
    // The answer is the clearance of the work copy, or an answer that holds the clearance and the code check
    // of the acknowledgement (contract C2).
    const answer = res as (Partial<T.Clearance> & { clearance?: T.Clearance; outcome?: string; check?: { applied?: boolean | null; reason?: string } }) | undefined;
    this.absorb(st, answer?.clearance ?? (answer?.corrections ? (answer as T.Clearance) : undefined));
    if (answer?.outcome !== "open" && answer?.check?.applied !== false) return;
    // gitring checked the code, and the work does not follow the request yet: the request stays open. The
    // model sees it again at the end of this turn (with the reason), and the vessel waits for a new write.
    st.acked = st.acked.filter((id) => id !== o.notice.id);
    st.corrections.push(stillOpen(o.notice, answer.check?.reason));
  }

  private async load(): Promise<VesselState | undefined> {
    if (!this.st) this.st = await this.ctx.storage.get<VesselState>("st");
    return this.st;
  }

  private async save(): Promise<void> {
    if (this.st) await this.ctx.storage.put("st", this.st);
  }
}

// ───── Model helpers ─────

const COURSE_REQUEST =
  "Send your plan before you write code. Reply with JSON only: " +
  '{"plan": ["short steps"], "files": ["paths you will change"], "symbols": ["path#name for functions you will add or change; add (params) if you change a signature"], "approach": "one sentence"}';

function systemPrompt(callsign: string, runner?: T.CheckSettings): string {
  const container = runner?.runner === "container";
  return [
    `You are ${callsign}, a coding agent inside gitring. Many agents change this repository at the same time.`,
    "gitring checks your plan against the 20 nearest active plans. It never blocks you. It sends change requests.",
    "Rules:",
    "1. Read every GITRING CHANGE REQUEST. Apply it in your next edits. Continue your work.",
    "2. Write complete file contents with write_file. Keep unrelated code unchanged.",
    "3. Do not edit the test files of other tasks. Do not edit .gitring/.",
    "4. Call log_progress after each important step.",
    "5. The tests are the contract. Read the test files first. Make every assertion pass.",
    "6. Call run_checks after you write. Fix every failure. Then call submit with a one-line summary.",
    container
      ? "7. Follow the conventions of this repository: its language, style, test framework and folder layout. Use list_files and read_file to learn them. Add a dependency only when the task needs it, in the manifest (for example package.json)."
      : "7. Plain ES modules only. No dependencies. Use relative links in HTML.",
  ].join("\n");
}

function briefPrompt(
  brief: { intent: T.Intent; context: Record<string, string>; checks: { path: string; content: string }[]; constraints: string[]; traffic: T.TrafficVessel[]; runner?: T.CheckSettings; files?: { path: string }[] },
  prior: string,
): string {
  const files = Object.entries(brief.context)
    .map(([p, t]) => `--- ${p}\n${t}`)
    .join("\n\n");
  const r = brief.runner;
  const how =
    r?.runner === "container"
      ? `HOW TESTS RUN: in a Linux container with Node.js 24: ${r.install || "npm ci (or npm install)"}, then ${r.test || "npm test"}. The whole test suite must pass.` +
        (brief.checks.length ? "" : " This task has no test files: add tests for the task next to the existing tests.")
      : "";
  const shown = new Set(Object.keys(brief.context));
  const others = (brief.files ?? []).map((f) => f.path).filter((p) => !shown.has(p));
  return [
    `TASK: ${brief.intent.title}`,
    brief.intent.goal,
    brief.constraints.length ? `CONSTRAINTS:\n${brief.constraints.map((c) => `- ${c}`).join("\n")}` : "",
    brief.checks.length ? `TESTS (must pass): ${brief.checks.map((c) => c.path).join(", ")}` : "",
    how,
    others.length ? `OTHER FILES (read them with read_file when you need them):\n${others.slice(0, 300).join("\n")}${others.length > 300 ? `\n… and ${others.length - 300} more (list_files)` : ""}` : "",
    brief.traffic.length ? `ACTIVE WORK (other agents near your work):\n${brief.traffic.map((t) => `- ${t.callsign} on "${t.intentTitle}": ${t.approach} (files: ${t.files.join(", ")})`).join("\n")}` : "",
    prior ? `AN EARLIER WORK COPY made this diff on an older main. Make the same change on the current files:\n${prior}` : "",
    `FILES:\n${files}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function clearanceText(clr: T.Clearance): string {
  const parts = [`gitring conflict check: ${clr.verdict === "correct" ? "change request" : clr.verdict}. ${clr.advice}`];
  if (clr.corrections.length) parts.push(correctionsText(clr.corrections));
  if (clr.traffic.length) parts.push(`Active work near you: ${clr.traffic.map((t) => `${t.callsign} (distance ${t.range}${t.closing ? ", closer now" : ""}) on "${t.intentTitle}"`).join("; ")}.`);
  return parts.join("\n");
}

function correctionsText(cs: T.CorrectionNotice[]): string {
  return `GITRING CHANGE REQUEST:\n${cs.map((c) => `- [${c.id}] ${c.message}`).join("\n")}\nApply these change requests in your next edits. Continue your work.`;
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return parseJsonLoose<Record<string, unknown>>(raw) ?? {};
  }
}

/** The note of an acknowledgement after a write: the files that the model changed (the ack note holds 300 characters). */
export function changedNote(files: string[]): string {
  const shown = files.slice(0, 6).join(", ");
  return `I changed ${shown}${files.length > 6 ? ` and ${files.length - 6} more files` : ""} for this change request.`;
}

/** The first line of a model text, short (an ack note quotes it). */
export function firstLine(text: string | null | undefined): string {
  const line = (text ?? "").trim().split("\n")[0].trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** A change request that stays open after an acknowledgement: gitring checked the code, and the work does not follow it yet. */
export function stillOpen(notice: T.CorrectionNotice, reason: string | undefined): T.CorrectionNotice {
  return { ...notice, message: `${notice.message} This change request is still open: ${reason?.trim() || "the code does not follow it yet."}` };
}

/** The characters of a message in a model call. */
function sizeOf(m: ChatMessage): number {
  return (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

/**
 * Keep the system prompt, the brief and the latest turns: at most `keep` messages after the brief, and at most
 * `maxChars` characters in all (the oldest turns go first). The last model turn and its tool answers stay.
 */
export function trimMessages(messages: ChatMessage[], maxChars = Infinity, keep = 24): ChatMessage[] {
  const head = messages.slice(0, 2);
  let tail = messages.length <= keep + 2 ? messages.slice(2) : messages.slice(-keep);
  const room = maxChars - head.reduce((n, m) => n + sizeOf(m), 0);
  let total = tail.reduce((n, m) => n + sizeOf(m), 0);
  const lastTurn = tail.map((m) => m.role).lastIndexOf("assistant");
  let drop = 0;
  while (total > room && drop < lastTurn) total -= sizeOf(tail[drop++]);
  tail = tail.slice(drop);
  // Never start the tail with a tool message (its assistant call would be missing).
  while (tail.length && tail[0].role === "tool") tail = tail.slice(1);
  return [...head, ...tail];
}

/**
 * A change request stays in the prompt until the vessel acknowledges it. When the turn of the request left
 * the trimmed history, the request comes back after the brief.
 */
export function withOpenRequests(turn: ChatMessage[], open: OpenRequest[]): ChatMessage[] {
  const missing = open.filter((o) => !turn.some((m) => m.role === "user" && (m.content ?? "").includes(`[${o.notice.id}]`)));
  if (!missing.length) return turn;
  return [...turn.slice(0, 2), { role: "user", content: `STILL OPEN. ${correctionsText(missing.map((o) => o.notice))}` }, ...turn.slice(2)];
}

const TOOLS: ToolDef[] = [
  { type: "function", function: { name: "read_file", description: "Read a file of your attempt.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_files", description: "List files of your attempt.", parameters: { type: "object", properties: { dir: { type: "string" } } } } },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write the COMPLETE new content of one file. gitring checks your plan after each write.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, note: { type: "string", description: "One line: what changed and why." } }, required: ["path", "content"] },
    },
  },
  { type: "function", function: { name: "run_checks", description: "Run all checks on your attempt in an isolate.", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "log_progress",
      description: "Tell gitring and the other agents what you did and which files you touched.",
      parameters: { type: "object", properties: { message: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["message"] },
    },
  },
  { type: "function", function: { name: "submit", description: "Submit when all checks pass.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];
