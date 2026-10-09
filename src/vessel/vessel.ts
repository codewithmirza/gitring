/**
 * Vessel — a built-in coding agent, one Durable Object per attempt run.
 *
 * It uses exactly the same protocol as external agents (declare → write/log → check → submit),
 * through HarborMaster RPC. Corrections arrive piggybacked on every response; the vessel feeds
 * them into its next step and keeps working (no stop, no lock).
 *
 * Modes:
 *   llm       a Workers AI model with tools (read/write/list/checks/log/submit)
 *   scripted  a deterministic replay of the demo's reference solutions (offline + reliable demos);
 *             it applies each solution as a delta (3-way) onto its real base, like a real patch.
 *
 * Each step runs in an alarm, so a long run survives eviction.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker/env";
import type * as T from "../core/types";
import { merge3 } from "../core/text/merge3";
import { applyPatch, structuredPatch } from "diff";
import { chat, lastChatError, parseJsonLoose, type ChatMessage, type ToolDef } from "../platform/ai/models";
import { DEMO, type HarborMaster } from "../harbor/harbor";

/** The HarborMaster RPC surface a vessel uses (typed as the class; RPC serializes tuples as arrays). */
type HarborApi = Pick<HarborMaster, "declare" | "log" | "write" | "read" | "list" | "check" | "submit" | "ack" | "brief" | "attemptDiff">;

export interface VesselConfig {
  projectId: string;
  attemptId: string;
  intentId: string;
  agentId: string;
  callsign: string;
  model: string;
  mode: "llm" | "scripted";
  script?: { delayMs?: number; ignoreCorrections?: boolean; startDelayMs?: number; variant?: number };
  rederiveOf?: string;
}

interface VesselState {
  config: VesselConfig;
  phase: "start" | "declared" | "working" | "submitted" | "done" | "stopped";
  step: number;
  /** LLM conversation. */
  messages: ChatMessage[];
  /** Scripted: remaining file writes. */
  queue: string[];
  variant: "files" | "adapted";
  baseCache: Record<string, string | null>;
  corrections: T.CorrectionNotice[];
  submits: number;
  lastError?: string;
  /** Stagnation guard: failing checks signature, repeats, and writes since the last check run. */
  checkSig?: string;
  sameChecks?: number;
  writesSinceCheck?: number;
  /** Scripted: re-plot corrections whose files this vessel already queued again. */
  replotted?: string[];
}

const MAX_LLM_STEPS = 30;
/** Scripted vessels stop after this many steps, whatever happens (a guard against loops). */
const MAX_SCRIPTED_STEPS = 90;
const MAX_SUBMITS = 5;

export class Vessel extends DurableObject<Env> {
  private st?: VesselState;

  private harbor(projectId: string): HarborApi {
    return this.env.HARBOR.get(this.env.HARBOR.idFromName(projectId)) as unknown as HarborApi;
  }

  async start(config: VesselConfig): Promise<void> {
    this.st = {
      config,
      phase: "start",
      step: 0,
      messages: [],
      queue: [],
      variant: "files",
      baseCache: {},
      corrections: [],
      submits: 0,
    };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + (config.script?.startDelayMs ?? 300));
  }

  async stop(): Promise<void> {
    const st = await this.load();
    if (!st) return;
    st.phase = "stopped";
    await this.save();
    await this.ctx.storage.deleteAlarm();
  }

  async status(): Promise<{ phase: string; step: number; lastError?: string; model: string; mode: string; messages: number; submits: number; lastReply?: string } | null> {
    const st = await this.load();
    if (!st) return null;
    const last = [...st.messages].reverse().find((m) => m.role === "assistant");
    return {
      phase: st.phase,
      step: st.step,
      lastError: st.lastError,
      model: st.config.model,
      mode: st.config.mode,
      messages: st.messages.length,
      submits: st.submits,
      lastReply: last ? `${(last.content ?? "").slice(0, 300)}${last.tool_calls?.length ? ` [tools: ${last.tool_calls.map((t) => t.function.name).join(", ")}]` : ""}` : undefined,
    };
  }

  async alarm(): Promise<void> {
    const st = await this.load();
    if (!st || st.phase === "done" || st.phase === "stopped") return;
    const phase0 = st.phase;
    let delay = st.config.mode === "scripted" ? (st.config.script?.delayMs ?? 1800) : 200;
    try {
      const more = st.config.mode === "scripted" ? await this.scriptedStep(st) : await this.llmStep(st);
      if (!more) st.phase = "done";
    } catch (err) {
      st.lastError = String(err).slice(0, 500);
      console.warn("vessel step failed", st.config.callsign, st.lastError);
      delay = 4000;
      if (st.step > 60) st.phase = "done";
    }
    st.step += 1;
    await this.save();
    if ((st.phase as string) !== "done" && (st.phase as string) !== "stopped") await this.ctx.storage.setAlarm(Date.now() + delay);
    void phase0;
  }

  /* ───────────────────────── scripted ───────────────────────── */

  private slug(st: VesselState, brief: { demoSlug?: string }): string | undefined {
    return brief.demoSlug;
  }

  private async scriptedStep(st: VesselState): Promise<boolean> {
    const c = st.config;
    const h = this.harbor(c.projectId);
    const brief = await h.brief(c.attemptId, c.intentId);
    const slug = this.slug(st, brief);
    const di = DEMO.intents.find((x) => x.slug === slug);
    const sol = slug ? DEMO.solutions[slug] : undefined;

    if (st.phase === "start") {
      const sigs = scriptedSymbols(slug, di?.expect.symbols ?? []);
      const res = await h.declare({
        attemptId: c.attemptId,
        intentId: c.intentId,
        agent: { id: c.agentId, kind: "builtin", model: c.model },
        plan: planFor(slug, di?.title ?? brief.intent.title),
        files: di?.expect.files ?? brief.intent.scope?.paths ?? [],
        symbols: sigs,
        approach: approachFor(slug, brief.intent.title, c.rederiveOf),
        mode: "api",
      });
      this.absorb(st, res.clearance);
      // A re-derive on a main that already has the producer's change uses the adapted variant.
      if (c.rederiveOf && sol?.adapted) st.variant = "adapted";
      st.queue = Object.keys(sol ? (st.variant === "adapted" && sol.adapted ? sol.adapted : sol.files) : {});
      st.phase = "working";
      return true;
    }

    if (st.phase === "working") {
      if (st.step > MAX_SCRIPTED_STEPS) {
        st.phase = "submitted";
        return true;
      }
      if (!sol) {
        await h.log({ attemptId: c.attemptId, message: "No scripted solution for this intent. Submit as is." });
        st.phase = "submitted";
        return true;
      }
      // A re-plot moved the work onto the new main. Make the change again where Bearing kept the main
      // version: queue each such file once per correction (read it again first: the cache goes).
      const handled = (st.replotted ??= []);
      for (const n of st.corrections.filter((x) => x.constraints?.replot && !handled.includes(x.id))) {
        handled.push(n.id);
        for (const r of n.constraints?.reapply ?? []) {
          delete st.baseCache[r.path];
          st.queue = [r.path, ...st.queue.filter((q) => q !== r.path)];
        }
      }
      // React to corrections: an interface correction, or a landing that changed a signature, switches to the adapted variant.
      const adapts = (n: T.CorrectionNotice) =>
        n.kind === "interface" || (n.kind === "upstream" && (!n.constraints?.replot || !!n.constraints?.useSignatures?.length));
      for (const n of st.corrections.filter((x) => x.constraints?.replot && !adapts(x))) {
        if (c.script?.ignoreCorrections) break;
        this.absorb(st, await h.ack(c.attemptId, n.id, "I read the moved files again and continue on the new main."));
        st.corrections = st.corrections.filter((x) => x.id !== n.id);
      }
      const wantsAdapt = st.corrections.some(adapts);
      if (wantsAdapt && sol.adapted && st.variant === "files" && !c.script?.ignoreCorrections) {
        st.variant = "adapted";
        const done = Object.keys(sol.files).filter((p) => !st.queue.includes(p));
        st.queue = [...new Set([...done, ...Object.keys(sol.adapted)])];
        const ack = st.corrections[0];
        const clr = await h.ack(c.attemptId, ack.id, "I use the new signature in my calls and keep my lines apart.");
        this.absorb(st, clr);
        await h.log({ attemptId: c.attemptId, message: `Apply correction ${ack.id}: call formatPrice with the currency and keep the currency parameter.` });
        return true;
      }
      for (const n of st.corrections.filter((x) => x.kind === "region" || x.kind === "duplicate" || x.kind === "intent-amended")) {
        if (c.script?.ignoreCorrections) break;
        const clr = await h.ack(c.attemptId, n.id, n.kind === "region" ? "I keep my change out of those lines." : "Noted.");
        this.absorb(st, clr);
      }
      st.corrections = st.corrections.filter((x) => x.kind === "interface" || x.kind === "upstream");
      const path = st.queue.shift();
      if (!path) {
        st.phase = "submitted";
        return true;
      }
      const target = variantOf(slug, c.script?.variant ?? 0, path, (st.variant === "adapted" && sol.adapted?.[path]) || sol.files[path]);
      const ref = st.variant === "adapted" && sol.adapted?.[path] ? adaptedRef(path) : DEMO.repo[path];
      if (!(path in st.baseCache)) {
        st.baseCache[path] = (await h.read(c.attemptId, path)).content;
      }
      const content = applyDelta(ref, st.baseCache[path] ?? undefined, target);
      const res = await h.write({ attemptId: c.attemptId, files: [{ path, content }], message: writeNote(slug, path) });
      this.absorb(st, res.clearance);
      return true;
    }

    if (st.phase === "submitted") {
      if (st.submits >= MAX_SUBMITS) return false;
      st.submits += 1;
      const res = await h.submit(c.attemptId, summaryFor(slug, brief.intent.title, st.variant));
      this.absorb(st, res.clearance);
      if (res.next === "fix-checks" && sol?.adapted && st.variant === "files") {
        st.variant = "adapted";
        st.queue = Object.keys(sol.adapted);
        st.phase = "working";
        return true;
      }
      return res.next === "fix-checks" && st.submits < MAX_SUBMITS;
    }
    return false;
  }

  /* ───────────────────────── LLM ───────────────────────── */

  private async llmStep(st: VesselState): Promise<boolean> {
    const c = st.config;
    const h = this.harbor(c.projectId);

    if (st.phase === "start") {
      const brief = await h.brief(c.attemptId, c.intentId);
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
        { role: "system", content: systemPrompt(c.callsign) },
        { role: "user", content: briefPrompt(brief, prior) },
      ];
      const plan = await chat(this.env.AI as never, c.model, [...st.messages, { role: "user", content: COURSE_REQUEST }], {
        maxTokens: 1200,
        temperature: 0.2,
        timeoutMs: 120_000,
      });
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
      st.messages.push({ role: "assistant", content: `My course: ${JSON.stringify({ plan: course.plan, files: course.files, symbols: course.symbols, approach: course.approach })}` });
      st.messages.push({ role: "user", content: clearanceText(res.clearance) + "\nNow do the work with the tools." });
      this.absorb(st, res.clearance);
      st.phase = "working";
      return true;
    }

    if (st.phase === "working") {
      if (st.step > MAX_LLM_STEPS) {
        st.phase = "submitted";
        return true;
      }
      const res = await chat(this.env.AI as never, c.model, trimMessages(st.messages), { tools: TOOLS, toolChoice: "auto", maxTokens: 6000, temperature: 0.2, timeoutMs: 150_000 });
      if (!res) {
        st.lastError = `model call failed: ${lastChatError ?? "no answer"}`;
        // Rate limits on paid models: wait longer before the next turn.
        if (/429|rate|capacity|busy|3040|5035/i.test(lastChatError ?? "")) await new Promise((r) => setTimeout(r, 12_000));
        return true;
      }
      const msg = res.message;
      st.messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
      if (!msg.tool_calls?.length) {
        st.messages.push({ role: "user", content: "Use the tools. Write the files with write_file, run run_checks, then call submit." });
        return true;
      }
      for (const call of msg.tool_calls) {
        const out = await this.runTool(st, call.function.name, safeArgs(call.function.arguments));
        st.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: out.text.slice(0, 14_000) });
        if (out.done) {
          st.phase = "done";
          return false;
        }
      }
      const recent = st.messages.slice(-8).filter((m) => m.role === "tool").map((m) => m.name);
      if (recent.filter((n) => n === "write_file").length >= 2 && !recent.includes("run_checks")) {
        st.messages.push({ role: "user", content: "Run run_checks now. The checks are the contract: make every assertion pass." });
      }
      if (st.corrections.length) {
        st.messages.push({ role: "user", content: correctionsText(st.corrections) });
        for (const n of st.corrections) await h.ack(c.attemptId, n.id, "I apply this correction.").catch(() => undefined);
        st.corrections = [];
      }
      return true;
    }

    if (st.phase === "submitted") {
      if (st.submits >= MAX_SUBMITS) return false;
      st.submits += 1;
      const res = await h.submit(c.attemptId, "Work complete.");
      this.absorb(st, res.clearance);
      return res.next === "fix-checks" && st.submits < MAX_SUBMITS ? (st.phase = "working", true) : false;
    }
    return false;
  }

  private async runTool(st: VesselState, name: string, args: Record<string, unknown>): Promise<{ text: string; done?: boolean }> {
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
      case "write_file": {
        const res = await h.write({ attemptId: c.attemptId, files: [{ path: String(args.path ?? ""), content: String(args.content ?? "") }], message: String(args.note ?? "") });
        this.absorb(st, res.clearance);
        if (res.written.length) st.writesSinceCheck = (st.writesSinceCheck ?? 0) + 1;
        const notes = [
          `Written: ${res.written.join(", ") || "nothing"}.`,
          res.merged?.length ? `Main moved after your last read: Bearing merged your write with the landed changes in ${res.merged.join(", ")}. Read the file again before the next edit.` : "",
          ...(res.refused ?? []).map((r) => `Not written: ${r.reason}`),
          res.written.length || res.refused?.length ? "" : "The path is protected or not valid.",
          res.clearance.advice,
        ];
        return { text: notes.filter(Boolean).join(" ") };
      }
      case "run_checks": {
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
      case "log_progress": {
        const clr = await h.log({ attemptId: c.attemptId, message: String(args.message ?? "progress"), files: Array.isArray(args.files) ? (args.files as string[]) : undefined });
        this.absorb(st, clr);
        return { text: clr.advice };
      }
      case "submit": {
        st.submits += 1;
        const res = await h.submit(c.attemptId, String(args.summary ?? "Work complete."));
        this.absorb(st, res.clearance);
        if (res.next === "fix-checks" && st.submits < MAX_SUBMITS) return { text: res.message };
        return { text: res.message, done: true };
      }
      default:
        return { text: `Unknown tool ${name}.` };
    }
  }

  /* ───────────────────────── shared ───────────────────────── */

  private absorb(st: VesselState, clr: T.Clearance | undefined): void {
    if (!clr?.corrections?.length) return;
    for (const n of clr.corrections) if (!st.corrections.some((x) => x.id === n.id)) st.corrections.push(n);
  }

  private async load(): Promise<VesselState | undefined> {
    if (!this.st) this.st = await this.ctx.storage.get<VesselState>("st");
    return this.st;
  }

  private async save(): Promise<void> {
    if (this.st) await this.ctx.storage.put("st", this.st);
  }
}

/* ───────────────────────── scripted helpers ───────────────────────── */

/** Apply a solution as a delta: ref → target, onto the current base (3-way). */
export function applyDelta(ref: string | undefined, current: string | undefined, target: string): string {
  if (ref === undefined || current === undefined || current === ref) return target;
  if (current === target) return target;
  const m = merge3(ref, current, target);
  if (m.clean) return m.content;
  // Edits on adjacent lines conflict in a 3-way merge. A patch with some fuzz can still place the delta.
  const fuzzy = applyPatch(current, structuredPatch("a", "b", ref, target, "", "", { context: 2 }), { fuzzFactor: 2 });
  return typeof fuzzy === "string" ? fuzzy : target;
}

/**
 * Best-of-N needs real alternatives: the second scripted dark-mode vessel ships a warm "night reading"
 * palette and label instead of the cool teal one. (LLM vessels differ on their own.)
 */
function variantOf(slug: string | undefined, variant: number, path: string, content: string): string {
  if (slug !== "dark-mode" || variant % 2 === 0) return content;
  if (path === "src/render.js") return content.replace(/◐<\/span> Dark mode/g, "☾</span> Night reading");
  if (path === "src/styles.js") {
    const swap: Record<string, string> = {
      "#0f1a1c": "#1b1611",
      "#142427": "#261e17",
      "#e8eee9": "#f3e8d8",
      "#a7b6b2": "#c9b8a2",
      "#26393c": "#3a2f25",
      "#7cc4ba": "#e3a857",
      "#1c3533": "#3b2c1c",
      "#233230": "#2f261d",
    };
    return content.replace(/#[0-9a-f]{6}\b/gi, (hex) => swap[hex.toLowerCase()] ?? hex);
  }
  return content;
}

/** Adapted solutions were made on top of the currency change. */
function adaptedRef(path: string): string | undefined {
  return DEMO.solutions["currency"]?.files[path] ?? DEMO.repo[path];
}

/** The producer declares its new signature up front, so consumers get an early correction. */
function scriptedSymbols(slug: string | undefined, symbols: string[]): string[] {
  if (slug === "currency") return symbols.map((s) => (s === "src/products.js#formatPrice" ? 'src/products.js#formatPrice(cents, currency = "USD")' : s));
  return symbols;
}

function planFor(slug: string | undefined, title: string): string[] {
  const plans: Record<string, string[]> = {
    currency: ["Add a rate table for USD, EUR and INR", "Change formatPrice(cents) to formatPrice(cents, currency)", "Read ?currency= in renderPage", "Add a currency picker", "Run the checks"],
    "dark-mode": ["Add theme tokens for dark", "Add a toggle at the end of the nav", "Remember the choice", "Run the checks"],
    search: ["Add findProducts(query)", "Add a search form below the tagline", "Filter the shelf with ?q=", "Run the checks"],
    "staff-picks": ["Mark three books as staff picks", "Show a badge next to the price", "Style the badge", "Run the checks"],
    "api-item": ["Route /api/products/:id", "Return 404 JSON for unknown ids", "Run the checks"],
  };
  return plans[slug ?? ""] ?? ["Read the code", `Implement "${title}"`, "Run the checks"];
}

function approachFor(slug: string | undefined, title: string, rederiveOf?: string): string {
  const base: Record<string, string> = {
    currency: "Change the formatPrice interface and pass the currency through the render path.",
    "dark-mode": "CSS tokens plus a header toggle with aria-pressed.",
    search: "A pure findProducts filter and a small search form.",
    "staff-picks": "A staffPick flag on books and a badge in renderItem.",
    "api-item": "One new route in index.js that returns JSON.",
  };
  const a = base[slug ?? ""] ?? `Implement "${title}" with small, focused changes.`;
  return rederiveOf ? `Re-derive on the new main: ${a}` : a;
}

function writeNote(slug: string | undefined, path: string): string {
  const notes: Record<string, Record<string, string>> = {
    currency: { "src/products.js": "Add rates and the currency parameter to formatPrice.", "src/render.js": "Pass the currency to every formatPrice call.", "src/styles.js": "Style the currency picker." },
    "dark-mode": { "src/render.js": "Add the theme toggle to the header.", "src/styles.js": "Add dark theme tokens." },
    search: { "src/products.js": "Add findProducts.", "src/render.js": "Add the search form and the results count.", "src/styles.js": "Style the search form." },
    "staff-picks": { "src/products.js": "Mark three books as staff picks.", "src/render.js": "Show the badge next to the price.", "src/styles.js": "Style the badge." },
    "api-item": { "src/index.js": "Add the /api/products/:id route." },
  };
  return notes[slug ?? ""]?.[path] ?? `Update ${path}.`;
}

function summaryFor(slug: string | undefined, title: string, variant: string): string {
  return `${title}. ${variant === "adapted" ? "Adapted to the new formatPrice interface." : "Applied on my base."} Checks pass.`;
}

/* ───────────────────────── LLM helpers ───────────────────────── */

const COURSE_REQUEST =
  "Declare your course before you write code. Reply with JSON only: " +
  '{"plan": ["short steps"], "files": ["paths you will change"], "symbols": ["path#name for functions you will add or change; add (params) if you change a signature"], "approach": "one sentence"}';

function systemPrompt(callsign: string): string {
  return [
    `You are ${callsign}, a coding agent inside Bearing. Many agents change this repository at the same time.`,
    "Bearing checks your course against all traffic. It never blocks you. It sends corrections.",
    "Rules:",
    "1. Read every BEARING COURSE CORRECTION. Apply it in your next edits. Continue your work.",
    "2. Write complete file contents with write_file. Keep unrelated code unchanged.",
    "3. Do not edit test files of other intents. Do not edit .bearing/.",
    "4. Call log_progress after each meaningful step.",
    "5. The checks are the contract. Read the check files first. Make every assertion pass.",
    "6. Call run_checks after you write. Fix every failure. Then call submit with a one-line summary.",
    "7. Plain ES modules only. No dependencies. Use relative links in HTML.",
  ].join("\n");
}

function briefPrompt(brief: { intent: T.Intent; context: Record<string, string>; checks: { path: string; content: string }[]; constraints: string[]; traffic: T.TrafficVessel[] }, prior: string): string {
  const files = Object.entries(brief.context)
    .map(([p, t]) => `--- ${p}\n${t}`)
    .join("\n\n");
  return [
    `INTENT: ${brief.intent.title}`,
    brief.intent.goal,
    brief.constraints.length ? `CONSTRAINTS:\n${brief.constraints.map((c) => `- ${c}`).join("\n")}` : "",
    `CHECKS (must pass): ${brief.checks.map((c) => c.path).join(", ")}`,
    brief.traffic.length ? `TRAFFIC (other agents near your work):\n${brief.traffic.map((t) => `- ${t.callsign} on "${t.intentTitle}": ${t.approach} (files: ${t.files.join(", ")})`).join("\n")}` : "",
    prior ? `A PREVIOUS ATTEMPT made this diff on an older main. Re-apply its intent on the current files:\n${prior}` : "",
    `FILES:\n${files}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function clearanceText(clr: T.Clearance): string {
  const parts = [`Bearing course check: ${clr.verdict}. ${clr.advice}`];
  if (clr.corrections.length) parts.push(correctionsText(clr.corrections));
  if (clr.traffic.length) parts.push(`Traffic: ${clr.traffic.map((t) => `${t.callsign} (R${t.range}${t.closing ? ", closing" : ""}) on "${t.intentTitle}"`).join("; ")}.`);
  return parts.join("\n");
}

function correctionsText(cs: T.CorrectionNotice[]): string {
  return `BEARING COURSE CORRECTION:\n${cs.map((c) => `- [${c.id}] ${c.message}`).join("\n")}\nApply these corrections in your next edits. Continue your work.`;
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return parseJsonLoose<Record<string, unknown>>(raw) ?? {};
  }
}

/** Keep the system prompt, the brief and the latest turns. */
function trimMessages(messages: ChatMessage[], keep = 24): ChatMessage[] {
  if (messages.length <= keep + 2) return messages;
  const head = messages.slice(0, 2);
  let tail = messages.slice(-keep);
  // Never start the tail with a tool message (its assistant call would be missing).
  while (tail.length && tail[0].role === "tool") tail = tail.slice(1);
  return [...head, ...tail];
}

const TOOLS: ToolDef[] = [
  { type: "function", function: { name: "read_file", description: "Read a file of your attempt.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_files", description: "List files of your attempt.", parameters: { type: "object", properties: { dir: { type: "string" } } } } },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write the COMPLETE new content of one file. Bearing checks your course after each write.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, note: { type: "string", description: "One line: what changed and why." } }, required: ["path", "content"] },
    },
  },
  { type: "function", function: { name: "run_checks", description: "Run all checks on your attempt in an isolate.", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "log_progress",
      description: "Tell Bearing and the other agents what you did and which files you touched.",
      parameters: { type: "object", properties: { message: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["message"] },
    },
  },
  { type: "function", function: { name: "submit", description: "Submit when all checks pass.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];
