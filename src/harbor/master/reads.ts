/**
 * Answers read-only questions: status, diff, events, trees, files, history and connection data.
 * Layer 13 of the chain in master/README.md. Extends HarborApprovals (approvals.ts).
 * History questions read the derived data of main (src/harbor/derived.ts).
 * Read next: checks.ts.
 */
import type * as T from "../../core/types";
import type { CompareAnswer, HistoryAnswer, SearchAnswer, WhyAnswer } from "../../core/history";
import type { TimelinePage } from "../../core/timeline";
import { approvalLine } from "../../core/approvals";
import { unifiedDiff, lineDiff } from "../../core/text/diff";
import { contentKey } from "../../platform/checks/runner";
import { DerivedHistory } from "../derived";
import { readTimeline } from "../timeline";
import { fileNodes, langOf } from "../views";
import { hookKey } from "../support/access";
import { TERMINAL } from "../support/constants";
import { errorLine, normPath, opaqueDiff } from "../support/helpers";
import type { CallInfo } from "../support/types";
import { copyStatusWord } from "../support/words";
import { HarborApprovals } from "./approvals";

export abstract class HarborReads extends HarborApprovals {
  // ───── Status, diffs and events ─────

  /** Where is this work copy? An agent that waits for a person calls this. The answer also brings new change requests. */
  async status(attemptId: string, call: CallInfo = {}): Promise<T.WorkStatus> {
    this.rememberOrigin(call.origin);
    const a = this.mustAttempt(attemptId);
    const returned = a.returned; // heard() clears it
    // A member who did not send the agent looks: that is not an answer of the agent.
    if (this.sentBy(a, call.viewer)) this.heard(a);
    const intent = this.intents.get(a.intentId)!;
    const ap = a.approval;
    const landing = this.landings.find((l) => l.attemptId === a.id);
    let message: string;
    if (a.status === "landed") message = `Merged${landing ? ` at ${landing.mainAfter.slice(0, 7)}` : ""}. The task is done.`;
    else if (ap?.status === "waiting" && a.status === "ready") message = `${this.waitingMessage(a)} Wait. Do not change the work copy.`;
    else if (ap?.status === "sent-back" && a.status === "underway") message = `${ap.answer?.by.name ?? "A person"} sent the work back${ap.answer?.note ? `: ${ap.answer.note}` : "."} Change the work, run the tests, and submit again.`;
    else if (ap?.status === "approved" && (a.status === "ready" || a.status === "landing")) message = a.mergeWait ? `${a.mergeWait.message} The merge waits in the queue.` : "A person said yes. The merge is in the queue.";
    else if (ap?.status === "withdrawn" && a.status === "underway") message = `${ap.closed ?? "The question closed."} Submit again to ask again.`;
    else if (a.status === "underway" && returned) message = `The work did not merge: ${returned.reason} The work is back with you. Change it on the new main, run the tests, and submit again.`;
    else if (a.mergeWait && (a.status === "ready" || a.status === "landing")) message = `${a.mergeWait.message} The work copy waits in the merge queue. Do not change it.`;
    else if (a.status === "underway") message = "The work copy is in work. It is not in the merge queue. Change it, run the tests, and call gitring_submit.";
    else if (TERMINAL.has(a.status)) message = `The work copy is ${copyStatusWord(a.status)}. ${this.overAdvice(a)}`;
    else message = `The work copy is ${copyStatusWord(a.status)}.`;
    return {
      attemptId,
      status: a.status,
      task: { id: intent.id, title: intent.title, status: intent.status },
      ...(ap ? { approval: ap, ...this.mayAnswerOf(a, call.viewer) } : {}),
      line: approvalLine(a),
      link: this.approvalLink(a),
      mainSha: this.requireProject().mainSha,
      ...(landing ? { landing: { sha: landing.mainAfter, method: landing.method, at: landing.at } } : {}),
      ...(a.mergeWait ? { mergeWait: a.mergeWait } : {}),
      message,
      // A member who did not send the agent sees the state, and the change requests stay for the agent.
      clearance: this.withAgain(a, this.clearanceFor(attemptId, this.sentBy(a, call.viewer)), call.again),
    };
  }

  async attemptDiff(attemptId: string): Promise<{ files: { path: string; status: T.FileChangeStatus; additions: number; deletions: number; diff: string }[] }> {
    const a = this.mustAttempt(attemptId);
    const view = await this.attemptView(a);
    const text = view.changed.map((c) => {
      const d = lineDiff(c.base ?? "", c.head ?? "");
      return {
        path: c.path,
        status: (c.base === null ? "A" : c.head === null ? "D" : "M") as T.FileChangeStatus,
        additions: d.additions,
        deletions: d.deletions,
        diff: unifiedDiff(c.path, c.base, c.head),
      };
    });
    // Changes without text (binary or large files, modes): they merge too, so people see them.
    const other = view.opaque.map((c) => ({ path: c.path, status: c.status, additions: 0, deletions: 0, diff: opaqueDiff(c) }));
    return { files: [...text, ...other].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)) };
  }

  async landingDetail(id: string): Promise<{ landing: T.Landing; note: unknown; diff: Awaited<ReturnType<HarborReads["attemptDiff"]>> } | null> {
    const landing = this.landings.find((l) => l.id === id);
    if (!landing) return null;
    const noteText = this.db.landingNote(id);
    let note: unknown = noteText;
    try {
      note = noteText ? JSON.parse(noteText) : null;
    } catch {
      /* keep text */
    }
    return { landing, note, diff: await this.attemptDiff(landing.attemptId) };
  }

  /**
   * The whole history of the project, oldest first, one page at a time (the Replay view reads it). It reads
   * the activity log and the conflict checks from storage, not only the recent window of the live state.
   * `after`: the `next` cursor of the page before (absent: from the start).
   */
  async events(after?: string | null, limit?: number): Promise<TimelinePage> {
    this.requireProject();
    const sources = {
      intents: this.intents.values(),
      attempts: this.attempts.values(),
      corrections: this.corrections.values(),
      decisions: this.decisions,
      landings: this.landings,
      agents: this.agents.values(),
    };
    return readTimeline(this.ctx.storage.sql, sources, after ?? null, limit);
  }

  /** Files for a live preview: "main" or an attempt id. */
  async previewFiles(ref: string): Promise<{ key: string; files: Record<string, string> } | null> {
    await this.ensure(this.project?.id);
    let files: Map<string, string>;
    if (ref === "main") files = (await this.loadMain()).text;
    else {
      const a = this.attempts.get(ref);
      if (!a) return null;
      files = (await this.attemptView(a)).files;
    }
    const js = new Map([...files].filter(([p]) => /\.(m?js)$/.test(p) && !p.startsWith("tests/")));
    return { key: await contentKey(js), files: Object.fromEntries(js) };
  }

  async connectInfo(origin: string): Promise<T.ConnectInfo> {
    const p = await this.ensure(this.project?.id);
    const providers = await this.directory()
      .providers()
      .catch(() => ({ github: null }));
    const [slackKey, githubKey] = await Promise.all([
      this.env.SLACK_SIGNING_SECRET ? hookKey(this.env.SLACK_SIGNING_SECRET, "slack", p.id) : null,
      this.env.GITHUB_WEBHOOK_SECRET ? hookKey(this.env.GITHUB_WEBHOOK_SECRET, "github", p.id) : null,
    ]);
    return {
      projectId: p.id,
      mcpUrl: `${origin}/mcp`,
      hookUrl: `${origin}/hooks/claude/${encodeURIComponent(p.id)}`,
      intentsUrl: `${origin}/hooks/intents`,
      artifacts: { namespace: p.repo.namespace, repo: p.repo.name, remote: p.repo.remote, backend: p.repo.backend },
      inputs: { slack: Boolean(this.env.SLACK_SIGNING_SECRET), githubIssues: Boolean(providers.github?.webhook) },
      ...(slackKey ? { slackUrl: `${origin}/hooks/slack?project=${encodeURIComponent(p.id)}&key=${slackKey}` } : {}),
      ...(githubKey ? { githubHookUrl: `${origin}/hooks/github?project=${encodeURIComponent(p.id)}&key=${githubKey}` } : {}),
      githubApp: providers.github ? { slug: providers.github.slug, installUrl: providers.github.installUrl } : null,
    };
  }

  /** The GitHub repository of this project: the linked one, else the imported one. */
  async githubRepoOf(): Promise<string | null> {
    const p = this.requireProject();
    return p.settings.github.repo || (p.source?.kind === "github" ? p.source.repo : null) || null;
  }

  // ───── Trees and files ─────

  /**
   * A cheap version of a ref for HTTP caching (ETag), without reading files: main and commits are their
   * commit ids; a work copy is its id, base, last push and edit counter. Null: unknown ref.
   */
  async refVersion(ref: string): Promise<string | null> {
    const p = this.requireProject();
    if (ref === "main") return p.mainSha || null;
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    const a = this.attempts.get(ref);
    if (!a) return null;
    return `${a.id}@${a.baseSha.slice(0, 10)}.${(a.headSha ?? "").slice(0, 10)}.${this.attemptVersion.get(a.id) ?? 0}.${this.bootId}`;
  }

  /** The files of main, a work copy (base + its work) or a commit, for the code view. */
  async tree(ref: string): Promise<T.TreeResponse> {
    const p = this.requireProject();
    if (ref === "main" || ref === p.mainSha) {
      const m = await this.loadMain();
      return { ref, sha: m.sha, files: m.files };
    }
    const a = this.attempts.get(ref);
    if (a) {
      const view = await this.attemptView(a);
      // Every file of the work, text or not (the tree that merges), plus text the agent wrote to a path git cannot hold.
      const paths = new Set([...view.snapshot.keys(), ...view.files.keys()]);
      const files = [...paths].sort().map((path) => ({ path, size: view.files.get(path)?.length ?? 0, lang: langOf(path) }));
      return { ref, sha: (await this.refVersion(ref)) ?? a.id, files };
    }
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`Unknown ref ${ref}. Use main, a work copy id or a commit id.`);
    const commit = await this.backend.readCommit(p.repo.name, ref);
    if (!commit) throw new Error(`Commit ${ref.slice(0, 7)} is not in this project.`);
    const tt = await this.treeText(p.repo.name, commit.treeHash);
    return { ref, sha: ref, files: fileNodes(tt.snapshot, tt.text) };
  }

  async file(ref: string, path: string): Promise<string | null> {
    const p = this.requireProject();
    if (ref === "main" || ref === p.mainSha) return (await this.loadMain()).text.get(normPath(path)) ?? null;
    const a = this.attempts.get(ref);
    if (a) return (await this.attemptView(a)).files.get(normPath(path)) ?? null;
    const commit = await this.backend.readCommit(p.repo.name, ref);
    if (!commit) return null;
    return (await this.treeText(p.repo.name, commit.treeHash)).text.get(normPath(path)) ?? null;
  }

  // ───── History questions (derived data) ─────

  protected derivedData?: DerivedHistory;

  protected get derived(): DerivedHistory {
    this.derivedData ??= new DerivedHistory({
      sql: this.ctx.storage.sql,
      main: () => {
        const p = this.project;
        return p && !p.importing && p.mainSha && p.mainTree ? { repo: p.repo.name, sha: p.mainSha, tree: p.mainTree } : undefined;
      },
      landings: () => this.landings,
      note: (id) => this.db.landingNote(id),
      callsign: (agentId) => this.agents.get(agentId)?.callsign ?? agentId,
      title: (intentId) => this.intents.get(intentId)?.title ?? intentId,
      commit: (sha) => this.backend.readCommit(this.requireProject().repo.name, sha),
      readTree: async (tree) => {
        const hit = this.treeCache.get(tree);
        if (hit) return hit;
        const entries = await this.backend.readTree(this.requireProject().repo.name, tree);
        if (entries) this.treeCache.set(tree, entries);
        return entries;
      },
      text: (blob) => this.readText(this.requireProject().repo.name, blob),
      treeText: (tree) => this.treeText(this.requireProject().repo.name, tree),
      workCopy: async (id) => {
        const a = this.attempts.get(id);
        if (!a) return undefined;
        const view = await this.attemptView(a);
        const deleted = view.changed.filter((c) => c.head === null).map((c) => c.path);
        return { attempt: a, files: view.files, deleted, callsign: this.callsign(a.id) ?? a.agentId, title: this.intents.get(a.intentId)?.title ?? a.intentId };
      },
      background: (work) => this.ctx.waitUntil(work.catch((e) => console.warn("history", errorLine(e)))),
    });
    return this.derivedData;
  }

  /** Why a line (or a file) is what it is on main, a commit of main or a work copy. */
  async why(input: { path: string; line?: number; ref?: string }): Promise<WhyAnswer> {
    return this.derived.why(input);
  }

  /** The changes of a file or a folder, or of main, the newest first. */
  async pathHistory(input: { path?: string; limit?: number }): Promise<HistoryAnswer> {
    return this.derived.history(input);
  }

  /** Find a text in the files of main. */
  async searchCode(input: { query: string; path?: string; limit?: number }): Promise<SearchAnswer> {
    return this.derived.search(input);
  }

  /** The changes between two versions (main, a commit id or a work copy id), for all files or under a path. */
  async compareRefs(from: string, to: string, path?: string): Promise<CompareAnswer> {
    return this.derived.compare(from, to, path);
  }
}
