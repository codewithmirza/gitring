/**
 * The agent protocol: declare a plan, write, read, list, log, give up, confirm a change request and read the brief.
 * Layer 11 of the chain in master/README.md. Extends HarborCourseCheck (course-check.ts).
 * Every method here answers with the check result, so that change requests ride in each answer.
 * Read next: approvals.ts.
 */
import type * as T from "../../core/types";
import { checkFolderRules, planNotes, planRefusal } from "../../core/coord/folder-rules";
import { merge3 } from "../../core/text/merge3";
import { contextBudget } from "../../platform/ai/models";
import { newId, repoSafe } from "../ids";
import { ACTIVE, PROTOCOL, type MainView } from "../views";
import { checkAck } from "../ack-check";
import { rankForBrief } from "../support/brief-rank";
import { GITRING_AUTHOR, TERMINAL } from "../support/constants";
import { emptyFootprint, normDir, normPath, personOf } from "../support/helpers";
import type { Brief, CallInfo } from "../support/types";
import { copyStatusWord, taskStatusWord } from "../support/words";
import { HarborCourseCheck } from "./course-check";

// ───── Types ─────

/** What an agent sends to gitring_declare, with the fields that the Worker and the Claude Code hook add. */
type DeclareCall = T.DeclareInput & { attemptId?: string; projectId?: string; workdir?: string; by?: T.Actor };

export abstract class HarborProtocol extends HarborCourseCheck {
  // ───── Declare a plan ─────

  async declare(input: DeclareCall): Promise<T.DeclareResult> {
    await this.ensure(input.projectId);
    const p = this.requireProject();
    const main = await this.loadMain();
    const agent = this.upsertAgent(input.agent ?? {});

    const resolved = await this.intentForDeclare(input, agent);
    let intent = resolved.intent;
    const createdIntent = resolved.createdIntent;

    const mode = input.mode ?? "api";
    let attempt = input.attemptId ? this.attempts.get(input.attemptId) : undefined;
    const now = Date.now();
    const { course, rules } = this.planForDeclare(input, p, attempt, now);
    attempt = this.openAttempt({ input, p, main, intent, agent, attempt, course, mode, now });
    this.registerDeclared(input, agent, intent, attempt, course, mode);
    const workspace = await this.declareWorkspace(attempt, intent, mode);

    await this.refreshFootprint(attempt);
    // A work copy is in flight: the steward (when on) watches from now on.
    await this.armSteward();
    let check = await this.courseCheck(attempt.id, "declare");
    // A duplicate of a new intent joins the existing intent as another attempt (best-of-N).
    if (check?.verdict === "merge-intents" && createdIntent) {
      check = await this.mergeDuplicate(attempt, intent, check);
      intent = this.intents.get(attempt.intentId)!;
    }
    return this.declareResult(attempt, agent, intent, workspace, rules);
  }

  // ───── The steps of a declare ─────

  /** The task of the plan: an existing one, or a new one that the agent describes. A task that is over is refused. */
  protected async intentForDeclare(input: DeclareCall, agent: T.AgentInfo): Promise<{ intent: T.Intent; createdIntent: boolean }> {
    let intent: T.Intent | undefined = input.intentId ? this.intents.get(input.intentId) : undefined;
    let createdIntent = false;
    if (!intent && input.newIntent) {
      intent = await this.createIntent(
        { title: input.newIntent.title, goal: input.newIntent.goal, source: { kind: "mcp", ref: agent.callsign } },
        { kind: "agent", id: agent.id, name: agent.callsign },
      );
      createdIntent = true;
    }
    if (!intent) throw new Error("Unknown task. Give intentId from gitring_intents, or give newIntent.");
    if (intent.status === "landed" || intent.status === "parked") {
      throw new Error(`The task "${intent.title}" is ${taskStatusWord(intent.status)}. Choose an open task.`);
    }
    return { intent, createdIntent };
  }

  /** The plan as stored, and the sentences of the folder rules. A plan that a rule forbids is refused here, before any work exists. */
  protected planForDeclare(input: DeclareCall, p: T.Project, attempt: T.Attempt | undefined, now: number): { course: T.Course; rules: ReturnType<typeof planNotes> } {
    const uses = [...new Set((input.uses ?? []).map(String))].slice(0, 100);
    const course: T.Course = {
      plan: (input.plan ?? []).slice(0, 20).map(String),
      files: [...new Set((input.files ?? []).map(normPath))],
      symbols: [...new Set((input.symbols ?? []).map(String))],
      ...(uses.length ? { uses } : {}),
      approach: String(input.approach ?? "").slice(0, 400),
      // A new plan for the same work copy keeps the time of the first plan: R4 compares the true order.
      declaredAt: attempt?.course.declaredAt ?? now,
    };
    // The rules by folder: a plan that touches files only other people's agents may change is refused here,
    // before any work exists. The other rules go into the answer as plain sentences.
    const ruled = checkFolderRules(p.settings.folderRules, course.files, (attempt?.sender ?? personOf(input.by))?.id);
    const refusal = planRefusal(ruled);
    if (refusal) throw new Error(refusal);
    const rules = planNotes(ruled);
    return { course, rules };
  }

  /** A new work copy for the plan, or the changed plan of the work copy that exists. */
  protected openAttempt(f: { input: DeclareCall; p: T.Project; main: MainView; intent: T.Intent; agent: T.AgentInfo; attempt: T.Attempt | undefined; course: T.Course; mode: T.Attempt["mode"]; now: number }): T.Attempt {
    const { input, p, main, intent, agent, course, mode, now } = f;
    let { attempt } = f;
    if (!attempt) {
      const id = newId("a");
      attempt = {
        id,
        intentId: intent.id,
        agentId: agent.id,
        fork: { repo: repoSafe(`${p.repo.name}-${id}`) },
        mode,
        baseSha: main.sha,
        baseTree: main.tree,
        status: "declared",
        course,
        footprint: emptyFootprint(),
        corrections: [],
        lineage: { generation: 1 },
        stats: { filesChanged: 0, additions: 0, deletions: 0, steps: 0 },
        ...(personOf(input.by) ? { sender: personOf(input.by) } : {}),
        createdAt: now,
        updatedAt: now,
      };
    } else {
      if (!attempt.sender && personOf(input.by)) attempt.sender = personOf(input.by);
      attempt.agentId = agent.id;
      attempt.course = course;
      attempt.mode = mode;
      attempt.intentId = intent.id;
    }
    return attempt;
  }

  /** Saves the agent, the work copy and the task, and logs the plan. */
  protected registerDeclared(input: DeclareCall, agent: T.AgentInfo, intent: T.Intent, attempt: T.Attempt, course: T.Course, mode: T.Attempt["mode"]): void {
    agent.status = "underway";
    agent.attemptId = attempt.id;
    this.putAgent(agent);
    if (input.workdir) this.db.setHook(`cwd:${normDir(input.workdir)}`, attempt.id);

    // The intent's checks are part of the attempt from the start.
    if (mode === "api") {
      for (const c of intent.checks) this.db.writeWorktree(attempt.id, c.path, c.content);
    }
    this.putAttempt(attempt);
    if (intent.status === "open" || intent.status === "draft") {
      intent.status = "underway";
      this.putIntent(intent);
    }
    this.addLog({
      kind: "declare",
      attemptId: attempt.id,
      agentId: agent.id,
      intentId: intent.id,
      message: `${agent.callsign} sends a plan for "${intent.title}": ${course.approach || course.plan[0] || "no approach given"}`,
      files: course.files,
    });
  }

  protected async declareWorkspace(attempt: T.Attempt, intent: T.Intent, mode: T.Attempt["mode"]): Promise<T.DeclareResult["workspace"]> {
    // Fork: git mode needs the remote now. Api mode makes no fork: the work lives in gitring's own
    // storage as a changeset over main. A fork is made later, on demand (`workCopyRemote`).
    let workspace: T.DeclareResult["workspace"] = { mode, baseSha: attempt.baseSha };
    if (mode === "git") {
      await this.ensureFork(attempt, intent);
      const tok = await this.backend.createToken(attempt.fork.repo, "write", 6 * 3600);
      workspace = {
        mode,
        baseSha: attempt.baseSha,
        remote: attempt.fork.remote ?? (await this.backend.remoteUrl(attempt.fork.repo)),
        token: tok?.token,
        tokenExpiresAt: tok?.expiresAt,
      };
    }
    return workspace;
  }

  protected declareResult(attempt: T.Attempt, agent: T.AgentInfo, intent: T.Intent, workspace: T.DeclareResult["workspace"], rules: ReturnType<typeof planNotes>): T.DeclareResult {
    const clr = this.clearanceFor(attempt.id);
    return {
      attemptId: attempt.id,
      agentId: agent.id,
      callsign: agent.callsign,
      intent: {
        id: intent.id,
        title: intent.title,
        goal: intent.goal,
        constraints: intent.constraints,
        version: intent.version,
        checks: intent.checks.map((c) => ({ path: c.path, description: c.description })),
      },
      workspace,
      clearance: clr,
      ...(rules.length ? { rules } : {}),
      protocol: PROTOCOL,
    };
  }

  protected ensureFork(a: T.Attempt, intent: T.Intent): Promise<void> {
    let job = this.forks.get(a.id);
    if (job) return job;
    const p = this.requireProject();
    job = (async () => {
      const fork = await this.backend.fork(p.repo.name, a.fork.repo, { description: `${intent.title} · ${a.id}`, allBranches: p.repo.forkAllBranches });
      a.fork.remote = fork.remote ?? (await this.backend.remoteUrl(a.fork.repo));
      if (a.mode === "git" && intent.checks.length) {
        // Put the intent's checks into the fork so a git client sees them after clone.
        const tip = (await this.backend.resolve(a.fork.repo, this.branch)) ?? a.baseSha;
        const res = await this.backend.commit({
          repo: a.fork.repo,
          branch: this.branch,
          parent: tip,
          changes: intent.checks.map((c) => ({ path: c.path, content: c.content })),
          message: `Add the tests of "${intent.title}"\n\nGitring-Intent: ${intent.id}\nGitring-Attempt: ${a.id}`,
          author: GITRING_AUTHOR,
        });
        a.headSha = res.sha;
        this.bump(a.id);
      }
      this.putAttempt(a);
    })();
    this.forks.set(a.id, job);
    job.catch(() => this.forks.delete(a.id));
    return job;
  }

  // ───── Report and write ─────

  async log(input: T.LogInput, call: CallInfo = {}): Promise<T.Clearance> {
    const a = this.mustAttempt(input.attemptId);
    this.mayChange(a, call.viewer);
    this.heard(a);
    const agent = this.agents.get(a.agentId);
    if (agent) {
      agent.lastSeen = Date.now();
      this.putAgent(agent);
    }
    let trigger: T.CourseCheck["trigger"] = "log";
    if (input.files?.length) a.course.files = [...new Set([...a.course.files, ...input.files.map(normPath)])];
    if (input.symbols?.length) a.course.symbols = [...new Set([...a.course.symbols, ...input.symbols])];
    if (input.headSha && input.headSha !== a.headSha) {
      a.headSha = input.headSha;
      a.mode = "git";
      trigger = "push";
      this.db.clearWorktree(a.id); // the push supersedes shadow edits
      await this.refreshGitBase(a);
    }
    if (a.status === "declared") a.status = "underway";
    a.stats.steps += 1;
    await this.refreshFootprint(a);
    this.putAttempt(a);
    this.addLog({
      kind: trigger === "push" ? "push" : "log",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${agent?.callsign ?? a.agentId}: ${String(input.message).slice(0, 300)}`,
      files: input.files?.length ? input.files.map(normPath) : Object.keys(a.footprint.files),
    });
    await this.courseCheck(a.id, trigger);
    return this.clearanceFor(a.id);
  }

  /**
   * Git mode: when the agent merged a newer main into its work (git pull), its base is that main commit.
   * gitring looks for main commits in the pushed history (at most 300 commits back) and moves the base
   * to the newest one, so that the next merge compares the work with the main that the agent saw.
   */
  protected async refreshGitBase(a: T.Attempt): Promise<void> {
    if (a.mode !== "git" || !a.headSha) return;
    const from = this.mainPlace(a.baseSha);
    let best = from;
    let bestSha: string | undefined;
    const seen = new Set<string>();
    const queue = [a.headSha];
    while (queue.length && seen.size < 300) {
      const sha = queue.shift()!;
      if (seen.has(sha) || sha === a.baseSha) continue;
      seen.add(sha);
      const at = this.mainIndex.get(sha);
      if (at !== undefined && at > from) {
        if (at > best) {
          best = at;
          bestSha = sha;
        }
        continue; // older main commits are behind this one
      }
      const c = await this.backend.readCommit(a.fork.repo, sha).catch(() => null);
      if (c) queue.push(...c.parents);
    }
    if (!bestSha) return;
    const commit = await this.backend.readCommit(this.requireProject().repo.name, bestSha).catch(() => null);
    if (!commit) return;
    const from7 = a.baseSha.slice(0, 7);
    a.baseSha = bestSha;
    a.baseTree = commit.treeHash;
    this.attemptViews.delete(a.id);
    this.addLog({ kind: "replot", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${this.callsign(a.id)} merged main into its work: its base moves from ${from7} to ${bestSha.slice(0, 7)}.` });
  }

  /**
   * Git mode: take the latest push to the work copy, so that an agent that did not report its push with
   * gitring_log is still checked and tested on its own code. Returns true when the head moved.
   */
  protected async adoptForkTip(a: T.Attempt): Promise<boolean> {
    if (a.mode !== "git" || TERMINAL.has(a.status)) return false;
    const tip = await this.backend.resolve(a.fork.repo, this.branch).catch(() => null);
    if (!tip || tip === a.headSha) return false;
    a.headSha = tip;
    this.db.clearWorktree(a.id); // the push supersedes shadow edits
    if (a.status === "declared") a.status = "underway";
    await this.refreshGitBase(a);
    await this.refreshFootprint(a);
    this.putAttempt(a);
    this.addLog({
      kind: "push",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} pushed ${tip.slice(0, 7)} to its work copy.`,
      files: Object.keys(a.footprint.files),
    });
    await this.courseCheck(a.id, "push");
    return true;
  }

  async write(input: T.WriteInput, call: CallInfo = {}): Promise<T.WriteResult> {
    const a = this.mustAttempt(input.attemptId);
    this.mayChange(a, call.viewer);
    this.heard(a);
    if (TERMINAL.has(a.status)) throw new Error(`Work copy ${a.id} is ${copyStatusWord(a.status)}. ${this.overAdvice(a)}`);
    if (a.mode === "git") throw new Error("This work copy uses git mode. Push to its remote. gitring reads your latest push at gitring_check and gitring_submit.");
    const protectedPaths = new Set(
      [...this.intents.values()].filter((i) => i.id !== a.intentId).flatMap((i) => i.checks.map((c) => c.path)),
    );
    const written: string[] = [];
    const merged: string[] = [];
    const refused: { path: string; reason: string }[] = [];
    const before = await this.attemptView(a);
    for (const f of input.files ?? []) {
      const path = normPath(f.path);
      if (!path || path.startsWith("../")) continue;
      if (protectedPaths.has(path)) continue; // checks of other intents are not yours to edit
      if (path.startsWith(".gitring/")) continue;
      const content: string | null = f.delete ? null : String(f.content ?? "");
      const g = this.guardWrite(a, path, content, before.files.get(path) ?? null);
      if (g.refused) {
        refused.push({ path, reason: g.refused });
        continue;
      }
      this.db.writeWorktree(a.id, path, g.content);
      // The agent's own text stays its copy: a later write from the same copy merges again.
      this.db.setSeen(a.id, path, content);
      if (g.merged) merged.push(path);
      written.push(path);
    }
    if (a.status === "declared") a.status = "underway";
    a.stats.steps += 1;
    a.course.files = [...new Set([...a.course.files, ...written])];
    await this.refreshFootprint(a);
    this.putAttempt(a);
    const agent = this.agents.get(a.agentId);
    this.addLog({
      kind: "write",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message:
        `${agent?.callsign ?? a.agentId} writes ${written.join(", ") || "nothing"}${input.message ? `: ${String(input.message).slice(0, 200)}` : ""}` +
        (merged.length ? ` gitring merged the write with main changes in ${merged.join(", ")}.` : "") +
        (refused.length ? ` gitring did not write ${refused.map((r) => r.path).join(", ")}: the file changed after the last read.` : ""),
      files: written,
    });
    await this.courseCheck(a.id, "write");
    return {
      written,
      ...(merged.length ? { merged } : {}),
      ...(refused.length ? { refused } : {}),
      footprint: {
        files: Object.keys(a.footprint.files),
        symbols: [...a.footprint.symbols.defined, ...a.footprint.symbols.modified, ...a.footprint.symbols.removed],
      },
      clearance: this.clearanceFor(a.id),
    };
  }

  // ───── Read and list ─────

  /**
   * A file of a work copy. Every member can read it. Only a read of the agent (the person who sent it, or a call
   * from inside gitring) is an answer of the agent and the base of its next write of the file.
   */
  async read(attemptId: string, path: string, call: CallInfo = {}): Promise<{ path: string; content: string | null }> {
    const a = this.mustAttempt(attemptId);
    const mine = this.sentBy(a, call.viewer);
    if (mine) this.heard(a);
    const view = await this.attemptView(a);
    const p = normPath(path);
    const content = view.files.get(p) ?? null;
    if (mine && a.mode === "api" && !TERMINAL.has(a.status)) {
      this.db.setSeen(a.id, p, content);
      this.db.setMustRead(a.id, p, false);
    }
    return { path: p, content };
  }

  /**
   * A write against what the agent last saw of the file. Main can move a file under an API-mode
   * agent (a re-plot): a write from the older copy merges 3-way with the landed change, or gitring
   * refuses it ("read again") when the two overlap, or when one side deleted the file. A file that
   * gitring reset to the main version must be read before the agent writes it.
   */
  protected guardWrite(a: T.Attempt, path: string, content: string | null, current: string | null): { content: string | null; merged?: boolean; refused?: string } {
    if (this.db.mustRead(a.id, path)) {
      return { content, refused: `gitring kept the main version of ${path}. Read ${path}, then make your change again on the new text.` };
    }
    const seen = this.db.seen(a.id, path);
    if (seen === undefined || seen === current || content === current) return { content };
    if (content === null) return { content, refused: `${path} changed on main after your last read. Read ${path} again before you delete it.` };
    if (current === null) return { content, refused: `Main deleted ${path} after your last read. Call gitring_traffic before you add ${path} again.` };
    const m = merge3(seen ?? "", current, content);
    if (!m.clean) return { content, refused: `${path} changed after your last read: main moved. Read ${path} again, then write your change on the new text.` };
    return { content: m.content, merged: m.content !== content };
  }

  async list(attemptId: string, dir?: string, call: CallInfo = {}): Promise<string[]> {
    const a = this.mustAttempt(attemptId);
    if (this.sentBy(a, call.viewer)) this.heard(a);
    const view = await this.attemptView(a);
    const prefix = dir ? normPath(dir).replace(/\/?$/, "/") : "";
    return [...view.files.keys()].filter((p) => !prefix || p.startsWith(prefix)).sort();
  }

  async traffic(attemptId: string, call: CallInfo = {}): Promise<T.TrafficReport> {
    const a = this.mustAttempt(attemptId);
    if (this.sentBy(a, call.viewer)) this.heard(a);
    const main = await this.loadMain();
    const vessels = this.trafficFor(a);
    const baseIdx = this.mainPlace(a.baseSha);
    const landed = this.landings.filter((l) => this.mainPlace(l.mainAfter) > baseIdx);
    return {
      attemptId,
      vessels,
      mainSha: main.sha,
      landedSinceBase: landed.map((l) => ({
        intentId: l.intentId,
        title: this.intents.get(l.intentId)?.title ?? l.intentId,
        sha: l.mainAfter,
        files: Object.keys(this.attempts.get(l.attemptId)?.footprint.files ?? {}),
      })),
    };
  }

  // ───── Finish and brief ─────

  /**
   * An agent stops without work that passes its checks: the attempt fails and leaves the traffic.
   * Ready, landing and closed attempts do not change.
   */
  async giveUp(attemptId: string, reason: string): Promise<T.AttemptStatus> {
    const a = this.mustAttempt(attemptId);
    if (TERMINAL.has(a.status) || a.status === "ready" || a.status === "landing") return a.status;
    a.status = "failed";
    this.putAttempt(a);
    this.addLog({ kind: "system", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${this.callsign(a.id)} stops: ${String(reason).slice(0, 240)}` });
    const intent = this.intents.get(a.intentId);
    if (intent && intent.status === "underway" && ![...this.attempts.values()].some((x) => x.intentId === intent.id && ACTIVE.has(x.status))) {
      intent.status = "open";
      this.putIntent(intent);
    }
    return a.status;
  }

  /**
   * The agent confirms a change request. gitring checks the code of the work copy against the constraints of
   * the request (see ack-check.ts). When the code still breaks them, the request stays open and the answer
   * says what to change. An id that is not an open request of this work copy is an error that names the open ones.
   */
  async ack(attemptId: string, correctionId: string, note?: string, call: CallInfo = {}): Promise<T.AckResult> {
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, call.viewer);
    this.heard(a);
    const c = this.corrections.get(String(correctionId ?? "").trim());
    const answer = (outcome: T.AckResult["outcome"], message: string): T.AckResult => ({ correctionId, outcome, ...(c?.check ? { check: c.check } : {}), message, clearance: this.clearanceFor(a.id) });
    if (!c || c.attemptId !== a.id) throw new Error(`${correctionId || "This id"} is not a change request of work copy ${a.id}. ${this.openRequestsLine(a)}`);
    if (c.status === "superseded") throw new Error(`The change request ${c.id} is old: a newer change request replaced it. ${this.openRequestsLine(a)}`);
    if (c.status === "acknowledged") return answer("already", `You confirmed ${c.id} before.`);
    if (c.status === "closed") return answer("already", `The change request ${c.id} closed when the work merged.`);
    // The latest push of a git-mode work copy is the code that the agent confirms.
    await this.adoptForkTip(a);
    const view = await this.attemptView(a);
    const standOn = c.standOnAttemptId ? this.attempts.get(c.standOnAttemptId) : undefined;
    // The lines of a request count while the work that holds them is still in the traffic.
    const regions = !c.standOnAttemptId || (!!standOn && ACTIVE.has(standOn.status));
    const now = Date.now();
    const result = checkAck(c, { footprint: a.footprint, files: view.files, signatures: view.signatures }, { regions });
    c.check = { ...result, at: now };
    c.ackNote = note ? String(note).slice(0, 300) : c.ackNote;
    if (result.applied === false) {
      // The agent knows the request now: it stays open, and it does not come again as new.
      c.status = "delivered";
      c.deliveredAt = c.deliveredAt ?? now;
      this.putCorrection(c);
      this.addLog({ kind: "ack", attemptId: a.id, agentId: a.agentId, intentId: a.intentId, message: `${this.callsign(a.id)} confirms ${c.id}, but the code check fails: ${result.reason}` });
      return answer("open", `${result.reason} Change it, then call gitring_ack again. The change request stays open.`);
    }
    c.status = "acknowledged";
    c.acknowledgedAt = now;
    this.putCorrection(c);
    this.stats.correctionsAcknowledged += 1;
    this.persistStats();
    this.addLog({
      kind: "ack",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `${this.callsign(a.id)} acknowledges ${c.id}${note ? `: ${note}` : "."}`,
    });
    return answer("acknowledged", result.applied ? `Confirmed. ${result.reason}` : "Confirmed.");
  }

  /**
   * The first prompt of a built-in agent: the task, the tests, and the text of the files it likely needs, in
   * rank order. `model` sets the size: a model with a 1M-token context (GLM 5.3) gets far more file text.
   */
  async brief(attemptId: string | undefined, intentId?: string, opts: { model?: string } = {}): Promise<Brief> {
    const a = attemptId ? this.attempts.get(attemptId) : undefined;
    const intent = this.intents.get(a?.intentId ?? intentId ?? "");
    if (!intent) throw new Error("Unknown task.");
    const main = await this.loadMain();
    const files = a ? (await this.attemptView(a)).files : main.text;
    const context: Record<string, string> = {};
    const size = contextBudget(opts.model);
    let budget = size.briefChars;
    const wanted = new Set([...(intent.scope?.paths ?? []), ...(a?.course.files ?? [])].map(normPath));
    for (const [path, text] of rankForBrief(files, intent, wanted)) {
      if (/(^|\/)tests?\//.test(path) && !intent.checks.some((c) => c.path === path) && !wanted.has(path)) continue;
      // A huge file stays out (the agent reads it with read_file when it needs it).
      if (text.length > size.fileChars || budget - text.length < 0) continue;
      context[path] = text;
      budget -= text.length;
    }
    return {
      attemptId: a?.id,
      intent,
      files: [...files.keys()].sort().map((path) => ({ path, size: files.get(path)?.length ?? 0 })),
      context,
      checks: intent.checks.map((c) => ({ path: c.path, description: c.description, content: c.content })),
      constraints: intent.constraints,
      traffic: a ? this.trafficFor(a) : [],
      runner: this.checkSettings(),
    };
  }
}
