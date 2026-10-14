/**
 * Optional GitHub link: sends main to GitHub, brings GitHub changes into main, and checks the rights of a person.
 * Layer 16 of the chain in master/README.md. Extends HarborRebase (rebase.ts).
 * GitHub is optional. Nothing here runs when the project has no linked repository.
 * Read next: merge-record.ts.
 */
import type * as T from "../../core/types";
import { noTestRan } from "../../core/types";
import { RepoConflictError } from "../../platform/repo/backend";
import { syncToGithub } from "../../platform/github/sync";
import { upstreamChanges, type UpstreamResult } from "../../platform/github/upstream";
import { type MainView } from "../views";
import { GITRING_AUTHOR } from "../support/constants";
import { errorLine } from "../support/helpers";
import type { GithubRepoState } from "../support/types";
import { HarborRebase } from "./rebase";

export abstract class HarborGithub extends HarborRebase {
  // ───── The link and the rights of a person ─────

  /**
   * What gitring knows about the linked repository (the Worker asks before a project goes public, and
   * when an owner changes the GitHub settings): whether it is private, whether private code came into
   * the project, and the person whose GitHub rights gitring checks for the link.
   */
  async githubFacts(): Promise<{ repo?: string; private?: boolean; privateCode?: boolean; actor?: { userId: string; gone?: string } }> {
    const p = this.requireProject();
    const repo = p.settings.github.repo;
    const privateCode = Boolean(p.privateCode);
    if (!repo) return { privateCode };
    const st = this.gh(repo);
    return { repo, private: st.private, privateCode, ...(st.actor ? { actor: { userId: st.actor.userId, ...(st.actor.gone ? { gone: st.actor.gone } : {}) } } : {}) };
  }

  /**
   * The person whose GitHub rights gitring re-checks for this link (the importer, or the owner who
   * linked it or turned on sync), and what GitHub said at that time.
   */
  async setGithubActor(userId: string | null, facts: { read: boolean; push: boolean; private?: boolean }): Promise<void> {
    const repo = this.requireProject().settings.github.repo;
    if (!repo) return;
    this.setGh(repo, {
      actor: userId ? { userId, checkedAt: Date.now(), read: facts.read, push: facts.push } : undefined,
      ...(facts.private !== undefined ? { private: facts.private } : {}),
    });
  }

  /**
   * A person left the project (or is a viewer now). When gitring checked their GitHub rights for the
   * link, it stops: sync and pulls of a private repository wait until an owner saves the GitHub settings
   * again, and that owner's rights count then.
   */
  async githubActorLeft(userId: string): Promise<void> {
    const p = this.requireProject();
    const repo = p.settings.github.repo;
    if (!repo || !userId) return;
    const st = this.gh(repo);
    if (!st.actor || st.actor.userId !== userId || st.actor.gone) return;
    const gone = `The person whose GitHub rights gitring checked for ${repo} is no longer a member of this project. An owner saves the GitHub settings again (Settings → GitHub); then that owner's GitHub rights count.`;
    this.setGh(repo, { actor: { ...st.actor, read: false, push: false, gone } });
    this.addLog({ kind: "system", message: `GitHub ${repo}: ${gone}` });
    if (p.settings.github.mode !== "off") this.setGithub({ state: "error", message: gone, repo, mode: p.settings.github.mode, at: Date.now() });
  }

  /**
   * Does the person behind the link still have the rights on GitHub (push for sync, read for pulls of a
   * private repository)? GitHub is asked at most once a day; with `fresh`, it is asked now (a private
   * repository: a read that GitHub allowed earlier does not count). Links made with the operator key
   * have no person to check.
   */
  protected async githubRights(repo: string, need: "read" | "push", fresh = false): Promise<{ ok: true } | { ok: false; message: string }> {
    const st = this.gh(repo);
    const actor = st.actor;
    if (!actor) return { ok: true };
    if (actor.gone) return { ok: false, message: actor.gone };
    const recent = Date.now() - actor.checkedAt < 24 * 3600_000;
    if (!fresh && recent && actor[need]) return { ok: true };
    try {
      const perm = await this.directory().githubPermission(actor.userId, repo);
      this.setGh(repo, { actor: { ...actor, checkedAt: Date.now(), read: perm.read, push: perm.push }, ...(perm.private !== undefined ? { private: perm.private } : {}) });
      if (perm[need]) return { ok: true };
      return { ok: false, message: `The person who linked ${repo} can no longer ${need === "push" ? "push to" : "read"} it on GitHub (${perm.message}) An owner links it again in Settings → GitHub.` };
    } catch (e) {
      // GitHub did not answer. For a push, a recent good answer still counts (a week), so a short outage
      // stops nothing. For a private repository's code, nothing comes in without an answer.
      if (!fresh && actor[need] && Date.now() - actor.checkedAt < 7 * 24 * 3600_000) return { ok: true };
      return { ok: false, message: `gitring could not check the GitHub rights for ${repo}: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
  }

  /**
   * An issue of the repository becomes a task. An issue of a private repository goes only into a private
   * project, and only when the person behind the link can read the repository now: the issue text is
   * private too, and from then on the project stays private.
   */
  async githubIssueIntent(input: { repo: string; private?: boolean; title: string; goal: string; number?: number }): Promise<{ intent: T.Intent } | { refused: string }> {
    const p = this.requireProject();
    const repo = input.repo;
    const isPrivate = input.private ?? this.gh(repo).private ?? false;
    if (isPrivate) {
      if ((await this.directory().visibilityOf(p.id)) === "public") return { refused: `${repo} is private on GitHub, and this project is public. The issue does not become a task.` };
      const rights = await this.githubRights(repo, "read", true);
      if (!rights.ok) return { refused: rights.message };
      this.setGh(repo, { private: true });
      this.holdPrivate(repo);
    }
    const intent = await this.createIntent(
      { title: input.title, goal: input.goal || input.title, source: { kind: "webhook", ref: `github:${repo}#${input.number ?? ""}` } },
      { kind: "system", id: "github", name: "GitHub" },
    );
    return { intent };
  }

  /** The GitHub sync status for people (settings and the overview). */
  async githubStatus(): Promise<T.GithubSyncStatus> {
    const p = this.requireProject();
    const g = p.settings.github;
    const pull = g.repo ? this.gh(g.repo).pull : undefined;
    const withPull = (st: T.GithubSyncStatus): T.GithubSyncStatus => (pull ? { ...st, pull } : st);
    if (g.mode === "off") return withPull({ state: "off", message: "GitHub sync is off. Merged code stays in Cloudflare Artifacts.", mode: "off", ...(g.repo ? { repo: g.repo } : {}) });
    if (!g.repo) return { state: "not-linked", message: "Link a GitHub repository to send merged code to GitHub.", mode: g.mode };
    const st = p.github;
    if (st && st.repo === g.repo && st.mode === g.mode) return withPull(st);
    return withPull({ state: "pending", message: "gitring sends main to GitHub after the next merge, or when you choose Sync now.", repo: g.repo, mode: g.mode, branch: g.mode === "main" ? g.base : g.branch });
  }

  protected githubRun?: Promise<T.GithubSyncStatus>;
  protected githubAgain = false;

  // ───── Send main to GitHub ─────

  /** Send main to GitHub now (settings.github). One run at a time; a request during a run runs again after it. */
  async githubSync(): Promise<T.GithubSyncStatus> {
    const p = this.requireProject();
    const g = p.settings.github;
    if (g.mode === "off" || !g.repo) return this.githubStatus();
    if (this.githubRun) {
      this.githubAgain = true;
      return this.githubRun;
    }
    this.githubRun = this.githubSyncOnce(p, g.repo, g.mode, g.branch, g.base).finally(() => {
      this.githubRun = undefined;
      if (this.githubAgain) {
        this.githubAgain = false;
        this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
      }
    });
    return this.githubRun;
  }

  protected async githubSyncOnce(p: T.Project, repo: string, mode: "pull-request" | "main", branch: string, baseBranch?: string): Promise<T.GithubSyncStatus> {
    const base = { repo, mode, ...(mode === "pull-request" ? { branch } : baseBranch ? { branch: baseBranch } : {}) };
    if (!p.mainSha) return this.setGithub({ state: "pending", message: "Main is empty. gitring syncs after the first commit.", ...base });
    const before = p.github;
    this.setGithub({ ...(before?.repo === repo ? before : {}), state: "pending", message: "gitring sends main to GitHub.", ...base, at: Date.now() });
    const rights = await this.githubRights(repo, "push");
    if (!rights.ok) return this.setGithub({ state: "error", message: rights.message, ...base, at: Date.now() });
    const run = async (fresh: boolean) => {
      const access = await this.directory()
        .githubRepoAccess(repo, fresh)
        .catch((e) => ({ ok: false as const, state: "error" as const, message: `gitring could not ask GitHub: ${String((e as Error)?.message ?? e).slice(0, 160)}`, installUrl: undefined as string | undefined }));
      if (!access.ok) return { access };
      const st = this.gh(repo);
      const out = await syncToGithub(
        { repo, token: access.token },
        {
          backend: this.backend,
          source: p.repo.name,
          mainSha: p.mainSha,
          mode,
          branch,
          base: baseBranch,
          known: st.known,
          upstreamOf: st.upstreamOf,
          pr: {
            title: `gitring: merged work for ${p.name}`,
            body: [
              "This pull request holds the work that gitring merged on main.",
              "Each commit is one merged task. Its record (plan, conflict checks, change requests, tests) is a git note on `refs/notes/gitring` in the gitring repository.",
              "",
              "Merge it with **Create a merge commit**: then the next pull request shows only new work.",
            ].join("\n"),
          },
        },
      );
      return { out };
    };
    let res = await run(false);
    if ("out" in res && res.out?.unauthorized) res = await run(true);
    if ("access" in res && res.access && !res.access.ok) {
      const a = res.access;
      return this.setGithub({ state: a.state, message: a.message, ...base, ...(a.installUrl ? { installUrl: a.installUrl } : {}), at: Date.now() });
    }
    const out = (res as { out: Awaited<ReturnType<typeof syncToGithub>> }).out;
    // Pairs are kept even when the run stopped: the next run continues from them.
    this.setGh(repo, { known: out.known, ...(out.status.githubSha && (out.status.state === "ok" || out.status.state === "pending") ? { last: out.status.githubSha } : {}) });
    // The link changed during the run: the answer belongs to the old repository.
    if (this.requireProject().settings.github.repo?.toLowerCase() !== repo.toLowerCase()) return this.githubStatus();
    const st = this.setGithub(out.status);
    if (out.more) this.githubAgain = true;
    // Straight to main, and GitHub has commits that gitring does not have: bring them in, then send again.
    if (st.state === "blocked" && mode === "main" && !this.pullRun && /commits that gitring does not have/.test(st.message)) {
      this.ctx.waitUntil(
        this.githubPull({ reason: "sync" })
          .then((after) => (after.pull?.state === "merged" ? this.githubSync() : undefined))
          .catch((e) => console.warn("github pull failed", String(e))),
      );
    }
    if (st.state === "ok" && st.githubSha !== before?.githubSha) {
      this.addLog({ kind: "system", message: `GitHub ${repo}: ${st.message}` });
    } else if (st.state !== "ok" && st.state !== "pending" && (st.state !== before?.state || st.message !== before?.message)) {
      this.addLog({ kind: "system", message: `GitHub sync of ${repo} stopped: ${st.message}` });
    }
    return st;
  }

  protected setGithub(st: T.GithubSyncStatus): T.GithubSyncStatus {
    const p = this.requireProject();
    const { pull: _pull, ...rest } = st;
    p.github = rest;
    this.db.setMeta("project", p);
    const repo = p.settings.github.repo;
    const pull = repo ? this.gh(repo).pull : undefined;
    const out = pull ? { ...rest, pull } : rest;
    this.emit({ type: "github", github: out });
    return out;
  }

  protected setPull(repo: string, pull: T.GithubPullStatus): void {
    this.setGh(repo, { pull });
    const p = this.requireProject();
    if (p.settings.github.repo?.toLowerCase() !== repo.toLowerCase()) return;
    this.emit({ type: "github", github: { ...(p.github ?? { state: "off", message: "" }), pull } });
  }

  protected pullRun?: Promise<void>;
  protected pullAgain = false;

  // ───── Bring GitHub changes into main ─────

  /** A GitHub commit that main has: the last sync of main, else the last pull or sync, or the import. */
  protected githubSince(repo: string): string | null {
    const p = this.requireProject();
    const st = this.gh(repo);
    return st.known[p.mainSha] ?? st.last ?? null;
  }

  /**
   * Bring new commits of the followed GitHub branch into main (a push webhook, Pull now, a merged
   * conflict task, or a blocked sync). One run at a time, after the merges in the queue; a request
   * during a run runs once more after it. Answers the GitHub status with the pull result.
   */
  async githubPull(opts: { reason?: "webhook" | "manual" | "task" | "sync"; ref?: string; defaultBranch?: string } = {}): Promise<T.GithubSyncStatus> {
    const p = this.requireProject();
    const g = p.settings.github;
    const repo = g.repo;
    if (!repo) throw new Error("Link a GitHub repository first (Settings → GitHub).");
    if (p.importing) return this.githubStatus();
    // GitHub is optional: a push on GitHub changes main only when an owner turned GitHub sync on. A member
    // can still bring the changes in by hand (Pull now).
    if (opts.reason === "webhook" && g.mode === "off") return this.githubStatus();
    // A push webhook: only pushes to the followed branch matter.
    if (opts.ref && opts.ref !== `refs/heads/${g.base || opts.defaultBranch}`) return this.githubStatus();
    if (this.pullRun) {
      this.pullAgain = true;
    } else {
      const reason = opts.reason ?? "manual";
      // Pulls run in the merge queue: no merge moves main while gitring reads and merges GitHub's changes.
      const job = this.landingChain.then(() => this.githubPullOnce(repo, reason));
      this.landingChain = job.catch(() => undefined);
      this.pullRun = job
        .catch((e) => this.setPull(repo, { state: "error", message: `gitring could not bring the GitHub changes in: ${String((e as Error)?.message ?? e).slice(0, 200)}`, at: Date.now() }))
        .finally(() => {
          this.pullRun = undefined;
          if (this.pullAgain) {
            this.pullAgain = false;
            this.ctx.waitUntil(this.githubPull({ reason }).catch((e) => console.warn("github pull failed", String(e))));
          }
        });
    }
    await this.pullRun;
    return this.githubStatus();
  }

  protected async githubPullOnce(repo: string, reason: string, again = 0): Promise<void> {
    const p = this.requireProject();
    const sameLink = () => this.requireProject().settings.github.repo?.toLowerCase() === repo.toLowerCase();
    if (!sameLink()) return;
    const since = this.githubSince(repo);
    if (!since) {
      return this.setPull(repo, { state: "error", message: "gitring does not know which GitHub commit main came from. You can bring changes in only for projects imported from GitHub.", at: Date.now() });
    }
    const st0 = this.gh(repo);
    this.setPull(repo, { ...(st0.pull ?? { message: "" }), state: "pending", message: "gitring reads the GitHub changes.", at: Date.now() });
    // A private repository: the person behind the link must be able to read it now (GitHub is asked on
    // every pull). When gitring does not know yet whether it is private, the daily check runs here and
    // the answer of GitHub below decides.
    let checkedNow = false;
    if (st0.private !== false) {
      const rights = await this.githubRights(repo, "read", st0.private === true);
      if (!rights.ok) return this.setPull(repo, { state: "error", message: rights.message, at: Date.now() });
      checkedNow = st0.private === true;
    }
    const { access, main, conflict, conflictIntent, res } = await this.askUpstream(repo, p, since);
    if (!sameLink()) return;
    if (res.state === "error") {
      const hint = !access.ok && access.installUrl ? ` Install the gitring GitHub App on ${repo} for private repositories.` : "";
      return this.setPull(repo, { state: "error", message: `${res.message}${hint}`, at: Date.now() });
    }
    // What GitHub says now counts: a repository that turned private is private from this pull on.
    this.setGh(repo, { private: res.private });
    if (res.private && !checkedNow) {
      // The read that GitHub allowed at link time does not count: the person must read it now.
      const rights = await this.githubRights(repo, "read", true);
      if (!rights.ok) return this.setPull(repo, { state: "error", message: rights.message, at: Date.now() });
    }
    // Private code never flows into a public project.
    if (res.private && (await this.directory().visibilityOf(p.id)) === "public") {
      return this.setPull(repo, { state: "error", message: `${repo} is private on GitHub, and this project is public. Make the project private to bring the changes in.`, at: Date.now() });
    }
    if (res.state === "up-to-date") {
      this.closeConflictTask(repo, "GitHub has nothing new for this task: main has every GitHub change.");
      return this.setPull(repo, { state: "up-to-date", message: res.message, headSha: res.head, at: Date.now() });
    }
    // From here on, GitHub's content goes into the project (a task's text, or main).
    if (res.private) this.holdPrivate(repo);
    if (res.state === "conflict") return this.openConflictTask(repo, res, conflict, conflictIntent);
    const n = `${res.commits} commit${res.commits === 1 ? "" : "s"}`;
    const links = Object.keys(res.gitlinks);
    // Main has exactly GitHub's files (GitHub merged gitring's pull request with a merge commit): no commit.
    // Main is GitHub's head from now on, so the next sync starts there and opens no empty pull request.
    if (!res.changes.length && !links.length && res.headTree === main.tree) {
      return this.markPullUpToDate(repo, reason, p, res, main, n);
    }
    const message = this.upstreamMessage(repo, res, n, links);
    let committed: { sha: string; tree: string };
    try {
      committed = await this.backend.commit({ repo: p.repo.name, branch: this.branch, parent: main.sha, changes: res.changes, message, author: GITRING_AUTHOR });
    } catch (err) {
      // main moved while gitring read GitHub: read again on the new main.
      if ((err instanceof RepoConflictError || String(err).includes("RepoConflict")) && again < 3) return this.githubPullOnce(repo, reason, again + 1);
      throw err;
    }
    await this.recordPull(repo, reason, p, res, committed, links, n);
  }

  // ───── The steps of a pull ─────

  /** Asks GitHub what changed since the commit that main came from. Answers the access, main, the open conflict task and GitHub's answer. */
  protected async askUpstream(repo: string, p: T.Project, since: string) {
    const access = await this.directory()
      .githubRepoAccess(repo)
      .catch(() => ({ ok: false as const, state: "error" as const, message: "gitring could not ask GitHub for access.", installUrl: undefined as string | undefined }));
    // Public repositories work without the app (GitHub's limits for anonymous calls apply).
    const token = access.ok ? access.token : null;
    const main = await this.loadMain();
    const conflict = this.gh(repo).conflict;
    const conflictIntent = conflict ? this.intents.get(conflict.intentId) : undefined;
    // Only the files that the merged conflict task changed count as merged by hand.
    let resolved: Record<string, string | null> | undefined;
    if (conflict && conflictIntent?.status === "landed") {
      const chosen = conflictIntent.chosenAttemptId ? this.attempts.get(conflictIntent.chosenAttemptId) : undefined;
      const touched = new Set(Object.keys(chosen?.footprint.files ?? {}));
      resolved = Object.fromEntries(Object.entries(conflict.files).filter(([path]) => touched.has(path)));
    }
    const res = await upstreamChanges({ repo, token, backend: this.backend, source: p.repo.name, main: main.snapshot, since, resolved, branch: p.settings.github.base });
    return { access, main, conflict, conflictIntent, res };
  }

  /** GitHub and main changed the same lines: one task asks an agent or a person to merge them. A new conflict replaces the old task. */
  protected async openConflictTask(repo: string, res: Extract<UpstreamResult, { state: "conflict" }>, conflict: GithubRepoState["conflict"], conflictIntent: T.Intent | undefined): Promise<void> {
    const files = Object.fromEntries(res.conflicts.map((c) => [c.path, c.theirs]));
    const open = conflict && conflictIntent && !["landed", "parked", "merged-into"].includes(conflictIntent.status);
    const same = open && Object.keys(files).every((f) => f in conflict!.files && conflict!.files[f] === files[f]);
    let intentId = conflict?.intentId;
    if (!same) {
      if (open) this.closeConflictTask(repo, "GitHub has newer changes: a new task replaces this one.");
      const diffs = res.conflicts.map((c) => c.diff).join("\n");
      const intent = await this.createIntent(
        {
          title: `Merge GitHub changes into main (${res.conflicts.length} file${res.conflicts.length === 1 ? "" : "s"})`,
          goal: [
            `GitHub ${repo} ${res.branch} has ${res.commits} new commit${res.commits === 1 ? "" : "s"} (${res.compareUrl}).`,
            `In ${res.conflicts.map((c) => c.path).join(", ")}, GitHub and main changed the same lines.`,
            "Apply GitHub's change below to main's version of these files. Keep the work that is on main.",
            "When this task merges, gitring brings the other GitHub changes in.",
            "",
            diffs.length > 2600 ? `${diffs.slice(0, 2600)}\n… (the full change: ${res.compareUrl})` : diffs,
          ].join("\n"),
          priority: "high",
          source: { kind: "webhook", ref: `github:${repo}` },
        },
        { kind: "system", id: "github", name: "GitHub" },
      );
      intentId = intent.id;
      this.setGh(repo, { conflict: { head: res.head, files, intentId } });
    }
    return this.setPull(repo, { state: "conflict", message: `${res.message} The task "Merge GitHub changes into main" asks an agent or a person to merge them.`, headSha: res.head, files: Object.keys(files), intentId, compareUrl: res.compareUrl, at: Date.now() });
  }

  /** Main has exactly GitHub's files: no commit, and main is GitHub's head from now on. */
  protected markPullUpToDate(repo: string, reason: string, p: T.Project, res: Extract<UpstreamResult, { state: "changes" }>, main: MainView, n: string): void {
    const st = this.gh(repo);
    this.setGh(repo, { known: { ...st.known, [main.sha]: res.head }, last: res.head });
    this.closeConflictTask(repo, "GitHub has nothing new for this task: main has every GitHub change.");
    this.addLog({ kind: "system", message: `GitHub ${repo} ${res.branch} has main's files at ${res.head.slice(0, 7)} (${n}). Nothing to merge.` });
    this.setPull(repo, { state: "up-to-date", message: `main has the files of GitHub ${res.branch} (${res.head.slice(0, 7)}).`, headSha: res.head, mainSha: main.sha, at: Date.now() });
    // The sync status follows (the pull request is merged: the branch moves, no new pull request opens).
    if (p.settings.github.mode !== "off" && reason !== "sync") this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
  }

  protected upstreamMessage(repo: string, res: Extract<UpstreamResult, { state: "changes" }>, n: string, links: string[]): string {
    const message = [
      `Bring GitHub changes into main`,
      "",
      `${n} from ${repo} ${res.branch} (${res.base.slice(0, 7)}..${res.head.slice(0, 7)}).${res.authors.length ? ` Changes by ${res.authors.join(", ")}.` : ""}`,
      ...(res.changes.length ? [] : ["main already had these changes."]),
      ...(links.length ? [`Submodules (kept on GitHub): ${links.slice(0, 5).join(", ")}.`] : []),
      "",
      `Gitring-Upstream: ${repo}@${res.head}`,
    ].join("\n");
    return message;
  }

  /** After the commit of the GitHub changes: main, the GitHub state, the app, the webhooks, the work copies and the tests of the new main. */
  protected async recordPull(repo: string, reason: string, p: T.Project, res: Extract<UpstreamResult, { state: "changes" }>, committed: { sha: string; tree: string }, links: string[], n: string): Promise<void> {
    const before = p.mainSha;
    p.mainSha = committed.sha;
    p.mainTree = committed.tree;
    this.db.setMeta("project", p);
    this.appendMainSeq(committed.sha);
    const st = this.gh(repo);
    this.setGh(repo, { upstreamOf: { ...st.upstreamOf, [committed.sha]: links.length ? { head: res.head, gitlinks: res.gitlinks } : res.head }, last: res.head });
    this.closeConflictTask(repo, "GitHub's changes are in main now.");
    const files = res.changes.map((c) => c.path);
    const newMain = await this.loadMain();
    this.emit({ type: "main", sha: newMain.sha, tree: newMain.tree, files: newMain.files, imports: newMain.imports });
    this.addLog({ kind: "system", message: `GitHub changes merged into main: ${n} from ${repo} ${res.branch} (${committed.sha.slice(0, 7)}, ${files.length} file${files.length === 1 ? "" : "s"}).`, files });
    this.setPull(repo, { state: "merged", message: `main has ${n} from GitHub ${res.branch} (${res.head.slice(0, 7)}).`, headSha: res.head, mainSha: committed.sha, compareUrl: res.compareUrl, at: Date.now() });
    this.webhook("main", { reason: "github", mainBefore: before, mainSha: committed.sha, files });
    if (files.length) await this.mainMovedUnder(newMain, { title: `GitHub changes (${repo})`, files });
    // The tests run on the new main. A failure does not undo the pull: it opens a task for agents.
    if (files.length) this.ctx.waitUntil(this.testMainAfterPull(repo, newMain, n).catch((e) => console.warn("tests after pull failed", errorLine(e))));
    // Send the merge back, so the GitHub branch has main again (fast-forward or the pull request).
    if (p.settings.github.mode !== "off" && reason !== "sync") this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
  }

  // ───── Tests of main after a pull ─────

  /** The test runs of main after GitHub changes, one after the other. */
  protected pullTests: Promise<unknown> = Promise.resolve();

  /**
   * The tests of main after GitHub changes came in. When tests fail, a high-priority task asks agents to
   * fix them (one open task at a time). A run that did not happen opens no task: the test budget, a test
   * container that did not start, or a project with no test command (nothing in the code to fix).
   * One run at a time, so that two pulls in a row cannot open two tasks.
   */
  protected testMainAfterPull(repo: string, main: MainView, what: string): Promise<T.CheckRun> {
    const run = this.pullTests.then(() => this.testMainOnce(repo, main, what));
    this.pullTests = run.catch(() => undefined);
    return run;
  }

  protected async testMainOnce(repo: string, main: MainView, what: string): Promise<T.CheckRun> {
    const run = await this.runTreeChecks(main.text, "main", "main");
    const total = run.passed + run.failed;
    if (run.wait) {
      this.addLog({ kind: "check", message: `Tests after the GitHub changes: not run. ${run.wait.message}`, data: { checkRunId: run.id, ok: false } });
      return run;
    }
    const failed = run.cases.filter((c) => !c.ok);
    if (run.ok) {
      const message = noTestRan(run) ? "Tests after the GitHub changes: no test ran. Add tests in tests/*.test.js." : `Tests after the GitHub changes: ${run.passed}/${total} pass.`;
      this.addLog({ kind: "check", message, data: { checkRunId: run.id, ok: true } });
      return run;
    }
    if (!failed.length && run.runner === "container") {
      this.addLog({ kind: "check", message: `Tests after the GitHub changes: not run. ${run.error ?? "The test container gave no result."}`, data: { checkRunId: run.id, ok: false } });
      return run;
    }
    this.addLog({
      kind: "check",
      message: failed.length ? `Tests after the GitHub changes: ${failed.length} of ${total} fail on main ${main.sha.slice(0, 7)}.` : `Tests after the GitHub changes: the tests do not run on main ${main.sha.slice(0, 7)}.`,
      data: { checkRunId: run.id, ok: false },
    });
    const openId = this.db.getMeta<string>("pullTestTask");
    const open = openId ? this.intents.get(openId) : undefined;
    if (open && !["landed", "parked", "merged-into"].includes(open.status)) return run;
    const intent = await this.createIntent(
      {
        title: "Fix the tests after GitHub changes",
        goal: [
          failed.length
            ? `${what} from GitHub ${repo} came into main (${main.sha.slice(0, 7)}). After that change, ${failed.length} of ${total} tests fail on main:`
            : `${what} from GitHub ${repo} came into main (${main.sha.slice(0, 7)}). After that change, the tests do not run on main.`,
          ...failed.slice(0, 12).map((c) => `- ${c.file} ${c.name}: ${(c.error ?? "failed").replace(/\s+/g, " ").slice(0, 300)}`),
          ...(failed.length > 12 ? [`- and ${failed.length - 12} more`] : []),
          ...(run.error ? [`Test runner: ${run.error.slice(0, 300)}`] : []),
          "",
          "Fix the code or the tests, so that every test passes on main. Keep the GitHub changes.",
        ].join("\n"),
        priority: "high",
        source: { kind: "webhook", ref: `github:${repo}` },
      },
      { kind: "system", id: "github", name: "GitHub" },
    );
    this.db.setMeta("pullTestTask", intent.id);
    return run;
  }

  /** The conflict task of a repository is done or not needed any more. */
  protected closeConflictTask(repo: string, why: string): void {
    const conflict = this.gh(repo).conflict;
    if (!conflict) return;
    this.setGh(repo, { conflict: undefined });
    const intent = this.intents.get(conflict.intentId);
    if (intent && !["landed", "parked", "merged-into"].includes(intent.status)) {
      this.park(intent.id, why, { kind: "system", id: "github", name: "GitHub" }).catch(() => undefined);
    }
  }
}
