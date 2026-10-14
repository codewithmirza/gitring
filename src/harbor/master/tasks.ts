/**
 * Creates tasks, starts and stops the built-in agents, keeps the AI budget and runs the steward.
 * Layer 6 of the chain in master/README.md. Extends HarborLive (live.ts).
 * The built-in agent runs in the Vessel object (src/vessel/vessel.ts) and calls back through the public methods.
 * Read next: import.ts.
 */
import type * as T from "../../core/types";
import { DEFAULT_SETTINGS } from "../../core/types";
import { STEWARD_OPTIONS } from "../../core/inbox";
import { callsignFor, colorFor, newId, repoSafe } from "../ids";
import { stewardFindings, stewardModel, wordFinding } from "../steward";
import { ACTIVE } from "../views";
import { LLM_STARTS_PER_HOUR, LLM_STARTS_PER_USER_HOUR, STEWARD_EVERY_MS, STEWARD_WORDS_PER_SWEEP } from "../support/constants";
import { HUMAN, clock, emptyFootprint, normPath, personOf } from "../support/helpers";
import type { LaunchInput } from "../support/types";
import { taskStatusWord } from "../support/words";
import { HarborLive } from "./live";

export abstract class HarborTasks extends HarborLive {
  // ───── Tasks ─────

  async createIntent(
    input: { title: string; goal: string; checks?: { path: string; content: string; description?: string }[]; priority?: "normal" | "high"; source?: T.Intent["source"] },
    by: T.Actor = HUMAN,
  ): Promise<T.Intent> {
    await this.ensure(this.project?.id);
    const now = Date.now();
    const intent: T.Intent = {
      id: newId("i"),
      title: String(input.title).slice(0, 140),
      goal: String(input.goal ?? "").slice(0, 4000),
      constraints: [],
      checks: (input.checks ?? [])
        .filter((c) => c && c.path && c.content)
        .map((c, i) => ({ id: `chk_${i}`, path: normPath(c.path), content: c.content, description: c.description ?? "" })),
      priority: input.priority ?? "normal",
      status: "open",
      version: 1,
      amendments: [],
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      source: input.source ?? { kind: "ui" },
    };
    this.putIntent(intent);
    this.addLog({ kind: "intent", intentId: intent.id, message: `${by.name} opens the task "${intent.title}"${intent.source.kind !== "ui" ? ` (from ${intent.source.kind}${intent.source.ref ? ` ${intent.source.ref}` : ""})` : ""}.` });
    this.webhook("intent", { intent: { id: intent.id, title: intent.title } });
    return intent;
  }

  async park(intentId: string, reason: string, by: T.Actor = HUMAN): Promise<T.Intent> {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("Unknown task.");
    intent.status = "parked";
    this.putIntent(intent);
    for (const a of this.attempts.values()) {
      if (a.intentId === intentId && ACTIVE.has(a.status)) {
        a.status = "abandoned";
        this.putAttempt(a);
        this.stopVessel(a.id).catch(() => {});
      }
    }
    this.recordDecision({ kind: "park", intentId, attemptIds: [], by, rationale: reason });
    this.addLog({ kind: "decision", intentId, message: `${by.name} pauses "${intent.title}": ${reason || "no reason given"}.` });
    return intent;
  }

  // ───── Built-in agents ─────

  async launch(intentId: string, input: LaunchInput = {}, by: T.Actor = HUMAN): Promise<{ attempts: T.Attempt[]; waiting: number }> {
    const p = this.requireProject();
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("Unknown task.");
    if (["landed", "parked", "merged-into"].includes(intent.status)) throw new Error(`The task "${intent.title}" is ${taskStatusWord(intent.status)}.`);
    const main = await this.loadMain();
    const fanout = Math.max(1, Math.min(4, Math.round(Number(input.fanout ?? intent.suggestedFanout ?? p.settings.fanout) || 1)));
    const ok = this.allowedModels();
    const asked = (input.models ?? []).filter((m) => typeof m === "string" && ok(m));
    const models = asked.length ? asked : this.projectModels(p);
    if (!models.length) throw new Error("No agent model is set for this project. Add one in the settings.");
    const budget = await this.takeLlmBudget(fanout, by);
    const created: T.Attempt[] = [];
    const first = asked.length ? 0 : this.agents.size;
    for (let i = 0; i < fanout; i++) {
      const model = models[(first + i) % models.length];
      const agent = this.upsertAgent({ kind: "builtin", model });
      const id = newId("a");
      const now = Date.now();
      const a: T.Attempt = {
        id,
        intentId,
        agentId: agent.id,
        fork: { repo: repoSafe(`${p.repo.name}-${id}`) },
        mode: "api",
        baseSha: main.sha,
        baseTree: main.tree,
        status: "declared",
        course: { plan: ["Read the task and the code", "Plan the change"], files: [], symbols: [], approach: "Planning", declaredAt: now },
        footprint: emptyFootprint(),
        corrections: [],
        lineage: { generation: 1 },
        stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
        ...(personOf(by) ? { sender: personOf(by) } : {}),
        createdAt: now,
        updatedAt: now,
        waitsForBudget: i < budget.granted ? undefined : budget.retryAt,
      };
      this.putAttempt(a);
      agent.status = a.waitsForBudget ? "waiting" : "underway";
      agent.attemptId = id;
      this.putAgent(agent);
      created.push(a);
      if (!a.waitsForBudget) await this.startVessel(a, agent);
    }
    const waiting = created.filter((a) => a.waitsForBudget).length;
    if (waiting) await this.scheduleBudgetRetry(budget.retryAt);
    if (intent.status === "open" || intent.status === "draft") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    const names = created.map((c) => this.agents.get(c.agentId)?.model).join(", ");
    this.addLog({
      kind: "intent",
      intentId,
      message: `${by.name} starts ${fanout} built-in agent${fanout > 1 ? "s" : ""} on "${intent.title}" (${names}).${waiting ? ` ${waiting} ${waiting === 1 ? "waits" : "wait"} for the hourly AI budget and ${waiting === 1 ? "starts" : "start"} at ${clock(budget.retryAt)} UTC.` : ""}`,
    });
    return { attempts: created, waiting };
  }

  /** Launch built-in agents on every open intent (each with its suggested fan-out). */
  async launchAll(by: T.Actor = HUMAN): Promise<{ intents: number; launched: number; queued: number }> {
    this.requireProject();
    const open = [...this.intents.values()].filter((i) => i.status === "open").sort((a, b) => a.createdAt - b.createdAt);
    let launched = 0;
    let queued = 0;
    for (const intent of open) {
      const res = await this.launch(intent.id, {}, by);
      launched += res.attempts.length - res.waiting;
      queued += res.waiting;
    }
    return { intents: open.length, launched, queued };
  }

  protected upsertAgent(id: T.AgentIdentity): T.AgentInfo {
    const existing = id.id ? this.agents.get(id.id) : undefined;
    if (existing) {
      existing.lastSeen = Date.now();
      if (id.model) existing.model = id.model;
      if (id.client) existing.client = id.client;
      this.putAgent(existing);
      return existing;
    }
    const n = this.agents.size;
    const agent: T.AgentInfo = {
      id: id.id ?? newId("ag"),
      callsign: id.name && /^[A-Z]+-\d+$/.test(id.name) ? id.name : callsignFor(n),
      kind: id.kind ?? (id.client ? "mcp" : "builtin"),
      model: id.model,
      client: id.client,
      color: colorFor(n),
      status: "idle",
      lastSeen: Date.now(),
    };
    this.putAgent(agent);
    return agent;
  }

  protected async startVessel(a: T.Attempt, agent: T.AgentInfo, rederiveOf?: string): Promise<void> {
    const p = this.requireProject();
    const ok = this.allowedModels();
    const model = agent.model && ok(agent.model) ? agent.model : this.projectModels(p)[0];
    const stub = this.env.VESSEL.get(this.env.VESSEL.idFromName(`${p.id}:${a.id}`));
    await stub.start({ projectId: p.id, attemptId: a.id, intentId: a.intentId, agentId: agent.id, callsign: agent.callsign, model, rederiveOf });
  }

  protected async stopVessel(attemptId: string): Promise<void> {
    const p = this.project;
    if (!p) return;
    const a = this.attempts.get(attemptId);
    const agent = a ? this.agents.get(a.agentId) : undefined;
    if (agent?.kind !== "builtin") return;
    await this.env.VESSEL.get(this.env.VESSEL.idFromName(`${p.id}:${attemptId}`)).stop();
  }

  // ───── Models and the AI budget ─────

  /** Agent models a settings change or a launch can choose: the operator's list (AGENT_MODELS) and the defaults. */
  protected allowedModels(): (m: string) => boolean {
    const ok = new Set([...this.operatorModels(), ...DEFAULT_SETTINGS.agentModels]);
    return (m) => ok.has(m);
  }

  /** The agent models of this deployment for new projects: AGENT_MODELS, or the defaults (GLM 5.3 Flash, GLM 5.3). */
  protected operatorModels(): string[] {
    const list = (this.env.AGENT_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    return list.length ? list : DEFAULT_SETTINGS.agentModels;
  }

  /**
   * The agent models of a project that the deployment still offers. When none is left (the project chose
   * models before the deployment changed its list), the project uses the models of the deployment.
   */
  protected projectModels(p: T.Project): string[] {
    const own = p.settings.agentModels.filter(this.allowedModels());
    return own.length ? own : this.operatorModels();
  }

  /**
   * Guardrail for AI spend: built-in agent starts per hour, per person (AI_AGENTS_PER_USER_HOUR) and for
   * the whole deployment (AI_AGENTS_PER_HOUR). Over the budget, an agent waits and starts when a slot frees.
   * gitring never fakes the work.
   */
  protected async takeLlmBudget(n: number, by?: T.Actor): Promise<{ granted: number; retryAt: number }> {
    const global = Math.max(1, Math.round(Number(this.env.AI_AGENTS_PER_HOUR) || LLM_STARTS_PER_HOUR));
    const perUser = Math.max(1, Math.round(Number(this.env.AI_AGENTS_PER_USER_HOUR) || LLM_STARTS_PER_USER_HOUR));
    const charge = by?.kind === "human" ? by.id : (this.project?.ownerId ?? null);
    const res = await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"))
      .budgetTake(charge, n, perUser, global)
      .catch(() => ({ granted: 0, retryAt: Date.now() + 60_000 }));
    if (res.granted < n) {
      this.addLog({ kind: "system", message: `The AI agent budget for this hour is used. ${n - res.granted} agent${n - res.granted === 1 ? "" : "s"} start at ${clock(res.retryAt)} UTC.` });
    }
    return res;
  }

  protected async scheduleBudgetRetry(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, at));
  }

  // ───── The steward ─────

  /** The steward works only while agents work: a work copy in flight, or work in the merge queue. */
  protected stewardActive(): boolean {
    const p = this.project;
    if (!p?.settings.steward || p.importing) return false;
    return [...this.attempts.values()].some((a) => ACTIVE.has(a.status)) || this.db.queue().length > 0;
  }

  /** When the next sweep of the steward is due (undefined: the steward is off, or no agent works). */
  protected stewardWakeAt(): number | undefined {
    if (!this.stewardActive()) return undefined;
    return (this.db.getMeta<number>("stewardAt") ?? Date.now()) + STEWARD_EVERY_MS;
  }

  /** Make sure the alarm comes by the next sweep of the steward (the setting turned on, or a work copy started). */
  protected async armSteward(): Promise<void> {
    const at = this.stewardWakeAt();
    if (at === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, at));
  }

  /**
   * One sweep of the steward (harbor/steward.ts): count the facts, and put each new finding in the inbox as a
   * question of kind "steward" with the one answer "Seen". The facts decide; the model only words the first
   * sentence, and the template sentence stands when it fails. One fact gives one open note: a fact with an
   * open note is not asked again, and a fact that a person saw comes back only when its measure doubled.
   */
  protected async stewardSweep(force = false): Promise<void> {
    if (!this.stewardActive()) return;
    const now = Date.now();
    const last = this.db.getMeta<number>("stewardAt") ?? 0;
    if (!force && now - last < STEWARD_EVERY_MS) return;
    this.db.setMeta("stewardAt", now);
    const findings = stewardFindings({
      now,
      attempts: [...this.attempts.values()],
      agents: [...this.agents.values()],
      intents: [...this.intents.values()],
      corrections: [...this.corrections.values()],
      logs: this.logs,
      landings: this.landings,
      queue: this.db.queueEntries(),
    });
    const notes = [...this.questions.values()].filter((q) => q.kind === "steward");
    const ask = stewardModel(this.env.AI);
    let worded = 0;
    for (const f of findings) {
      if (notes.some((q) => q.status === "open" && q.fact === f.key)) continue;
      const seen = notes.filter((q) => q.status !== "open" && q.fact === f.key).sort((x, y) => x.updatedAt - y.updatedAt).at(-1);
      if (seen && f.measure < 2 * Math.max(1, seen.measure ?? 1)) continue;
      let facts = f.facts;
      if (worded < STEWARD_WORDS_PER_SWEEP) {
        worded += 1;
        const sentence = await wordFinding(ask, f);
        if (sentence) facts = [sentence, ...f.facts];
      }
      // The sweep waited for the model: the project may have closed meanwhile.
      if (!this.project) return;
      const at = Date.now();
      const q: T.Question = { id: newId("q"), kind: "steward", status: "open", intentId: f.intentId, attemptIds: f.attemptIds, fact: f.key, measure: f.measure, facts, options: [...STEWARD_OPTIONS], askedAt: at, updatedAt: at };
      this.putQuestion(q);
      notes.push(q);
      this.addLog({ kind: "system", ...(f.attemptIds[0] ? { attemptId: f.attemptIds[0] } : {}), ...(f.intentId ? { intentId: f.intentId } : {}), message: `The steward noticed: ${facts[0]}` });
      this.questionAsked(q);
    }
  }
}
