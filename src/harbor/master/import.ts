/**
 * Starts a project from a source (empty, files, template, git URL or GitHub) and finishes the import.
 * Layer 7 of the chain in master/README.md. Extends HarborTasks (tasks.ts).
 * A long import continues from the alarm (see alarm in harbor.ts) and survives a restart of the object.
 * Read next: clearance.ts.
 */
import type * as T from "../../core/types";
import { DEFAULT_SETTINGS, withDefaults } from "../../core/types";
import { type FileChange } from "../../platform/repo/backend";
import { hashObject, utf8 } from "../../core/git/objects";
import { normalizeGitUrl } from "../../core/repo-rules";
import { guessModel } from "../../platform/ai/guess";
import { guessTree } from "../../core/guess";
import { isTemplateId, templateFiles, TEMPLATES } from "../../core/templates";
import { githubSnapshot, SNAPSHOT_LIMITS, SnapshotTooLarge } from "../../platform/github/tarball";
import { repoSafe } from "../ids";
import { GITRING_AUTHOR } from "../support/constants";
import { HUMAN, errorLine } from "../support/helpers";
import { seedChanges } from "../support/seed";
import type { SeedFile } from "../support/seed";
import { HarborTasks } from "./tasks";

export abstract class HarborImport extends HarborTasks {
  // ───── Start a project ─────

  /**
   * Create the canonical repo in Artifacts from a source:
   *   empty   a README in one commit
   *   git     Artifacts imports a public https remote (history kept); main = the remote's default branch
   *   push    an empty repo; the owner pushes to it with plain git (gitring adopts the pushed branch)
   *   upload  the files of a folder from the owner's computer, in one commit
   *   template  the files of a starter template (core/templates.ts), in one commit; its tests run in
   *           the gitring test runner (fast: no container, no test budget)
   * Imports run in the background: the project shows "importing" until Artifacts is done. After an
   * import, a push or an upload, gitring guesses the test commands (see guessTests).
   */
  async init(opts: { projectId: string; name?: string; source?: T.ProjectSource; ownerId?: string; files?: SeedFile[] }): Promise<T.ProjectState> {
    const generation = (this.db.getMeta<number>("generation") ?? 0) + 1;
    const source: T.ProjectSource = opts.source ?? { kind: "empty" };
    if (source.kind === "sample") throw new Error("The sample left gitring. Import a repository, upload a folder, push with git, or start empty.");
    if (source.kind === "template" && !isTemplateId(source.template)) throw new Error(`Unknown template "${source.template}". Use one of: ${TEMPLATES.map((t) => t.id).join(", ")}.`);
    const namespace = this.env.ARTIFACTS_NAMESPACE ?? "gitring";
    this.project = undefined;
    this.backendCache = undefined;
    const repoName = repoSafe(`${opts.projectId}-g${generation}-${Date.now().toString(36)}`);
    const draft: T.Project = {
      id: opts.projectId,
      name: opts.name ?? opts.projectId,
      repo: { backend: "artifacts", namespace, name: repoName, defaultBranch: "main" },
      mainSha: "",
      mainTree: "",
      createdAt: Date.now(),
      source,
      ownerId: opts.ownerId,
      settings: {
        ...DEFAULT_SETTINGS,
        decisionModel: "clef-flash",
        agentModels: this.operatorModels(),
        // Task files in the repository are a choice of the owner (Settings → Merging).
        intentsInRepo: false,
        // Repositories run their own tests in a container. Templates have tests for the gitring test runner.
        checks: source.kind === "template" ? { runner: "worker" as const } : { runner: "container" as const },
      },
    };
    this.project = draft;
    this.db.setMeta("generation", generation);
    // A project id that comes back (a project that was not made, then made again) starts clean: the
    // choice of the tests, the agents that wait for an import and the fix task belong to the old project.
    for (const key of ["checksSet", "launchAfterImport", "pullTestTask"]) this.db.setMeta(key, undefined);

    // A public repository (any git host, or GitHub): Artifacts imports it with its history.
    if (source.kind === "git" || (source.kind === "github" && !source.private)) {
      const url = source.kind === "git" ? normalizeGitUrl(source.url) : `https://github.com/${source.repo}`;
      const branch = source.branch;
      const res = await this.env.ARTIFACTS.import({
        source: { url, ...(branch ? { branch } : {}), depth: 200 },
        target: { name: repoName, opts: { description: `gitring project ${opts.projectId} (import of ${url})` } },
      });
      draft.repo.remote = res.remote;
      draft.repo.defaultBranch = branch || res.defaultBranch || "main";
      draft.importing = { url, startedAt: Date.now(), ...(source.kind === "github" ? { github: { repo: source.repo, branch: branch ?? "", snapshot: false } } : {}) };
      this.db.setMeta("project", draft);
      this.addLog({ kind: "system", message: `Import starts: ${url} into Cloudflare Artifacts (${repoName}).` });
      await this.ctx.storage.setAlarm(Date.now() + 2000);
      const state = await this.state();
      this.emit({ type: "snapshot", state });
      return state;
    }

    // A private GitHub repository: gitring reads one commit through the GitHub App (Artifacts imports
    // public remotes only), in the background.
    if (source.kind === "github") {
      const handle = await this.backend.ensureRepo(repoName, { description: `gitring project ${opts.projectId} (import of github.com/${source.repo})` });
      draft.repo.remote = handle.remote;
      draft.repo.defaultBranch = source.branch || "main";
      draft.importing = { url: `https://github.com/${source.repo}`, startedAt: Date.now(), github: { repo: source.repo, branch: source.branch ?? "", snapshot: true } };
      // Private code: the project stays private, whatever happens to the link later.
      draft.privateCode = { repo: source.repo, at: Date.now() };
      this.db.setMeta("project", draft);
      this.addLog({ kind: "system", message: `Import starts: github.com/${source.repo} (private) through the gitring GitHub App.` });
      await this.ctx.storage.setAlarm(Date.now() + 200);
      const state = await this.state();
      this.emit({ type: "snapshot", state });
      return state;
    }

    const handle = await this.backend.ensureRepo(repoName, { description: `gitring project ${opts.projectId}` });
    draft.repo.remote = handle.remote;

    if (source.kind === "push") {
      // An empty repo: the owner pushes an existing repository with plain git. gitring adopts the push.
      draft.importing = { url: "git push", startedAt: Date.now(), push: true, tokenIds: [] };
      this.db.setMeta("project", draft);
      this.addLog({ kind: "system", message: `Repository ready in Cloudflare Artifacts (${repoName}). gitring waits for the first git push.` });
      await this.ctx.storage.setAlarm(Date.now() + 15_000);
      const state = await this.state();
      this.emit({ type: "snapshot", state });
      return state;
    }

    const uploaded = source.kind === "upload" ? seedChanges(opts.files ?? []) : [];
    if (source.kind === "upload" && !uploaded.length) throw new Error("The folder has no files to upload.");
    const changes =
      source.kind === "upload"
        ? uploaded
        : source.kind === "template" && isTemplateId(source.template)
          ? templateFiles(source.template, { name: draft.name })
          : [{ path: "README.md", content: `# ${draft.name}\n\nThis repository lives in gitring. Agents send a plan before they change it.\n` }];
    const seed = await this.backend.commit({
      repo: repoName,
      branch: "main",
      parent: "",
      changes,
      message:
        source.kind === "upload"
          ? `Upload ${draft.name}\n\n${changes.length} files from a folder.\n\nGitring-Seed: upload`
          : source.kind === "template"
            ? `Start ${draft.name} from the ${TEMPLATES.find((t) => t.id === source.template)?.title ?? source.template} template\n\n${changes.length} files.\n\nGitring-Seed: template ${source.template}`
            : `Start ${draft.name}\n\nGitring-Seed: ${source.kind}`,
      author: GITRING_AUTHOR,
    });
    draft.mainSha = seed.sha;
    draft.mainTree = seed.tree;
    this.db.setMeta("project", draft);
    this.resetMainSeq(seed.sha);
    this.addLog({ kind: "system", message: `Project ready. Main is ${seed.sha.slice(0, 7)} in Cloudflare Artifacts (${repoName}).` });
    await this.loadMain();
    this.persistStats();
    // An uploaded folder brings its own tests: gitring guesses the commands (in the background).
    if (source.kind === "upload") this.ctx.waitUntil(this.guessTests().catch((e) => console.warn("guess failed", errorLine(e))));
    const state = await this.state();
    this.emit({ type: "snapshot", state });
    return state;
  }

  // ───── Finish an import ─────

  /** Alarm step for an import: wait until Artifacts has the repo (or the owner's push), then read main. */
  protected async continueImport(): Promise<void> {
    const p = this.project;
    if (!p?.importing || p.importing.error) return;
    if (p.importing.github?.snapshot) {
      // One snapshot import at a time ("Check now" and the alarm can both ask).
      this.snapshotRun ??= this.importGithubSnapshot().finally(() => (this.snapshotRun = undefined));
      return this.snapshotRun;
    }
    const elapsed = Date.now() - p.importing.startedAt;
    if (p.importing.push) {
      const pushed = await this.pushedBranch();
      if (!pushed) {
        if (elapsed > 3 * 24 * 3600_000) {
          p.importing = { ...p.importing, error: "No git push arrived in 3 days. Make a new project to try again." };
          this.db.setMeta("project", p);
          this.emit({ type: "snapshot", state: await this.state() });
          return;
        }
        // Check often at first, then every 5 minutes. "Check now" in the UI does not wait.
        await this.ctx.storage.setAlarm(Date.now() + Math.min(300_000, 15_000 + elapsed / 20));
        return;
      }
      await this.adoptMain(pushed.branch, pushed.sha);
      return;
    }
    let ready = false;
    let remoteDefault = "";
    try {
      // get() throws IMPORT_IN_PROGRESS until Artifacts has the whole repository.
      using repo = await this.env.ARTIFACTS.get(p.repo.name);
      const info = await repo.info();
      ready = !("status" in info) || (info as { status?: string }).status !== "importing";
      remoteDefault = info.defaultBranch ?? "";
    } catch {
      ready = false;
    }
    if (!ready) {
      if (elapsed > 20 * 60_000) {
        p.importing = { ...p.importing, error: "The import took more than 20 minutes. Try a smaller repository or a shallower branch." };
        this.db.setMeta("project", p);
        this.addLog({ kind: "system", message: `Import failed: ${p.importing.error}` });
        this.emit({ type: "snapshot", state: await this.state() });
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + Math.min(15_000, 2000 + elapsed / 10));
      return;
    }
    // Main is the branch the owner asked for, else the remote's default branch.
    const asked = p.source?.kind === "git" || p.source?.kind === "github" ? p.source.branch : undefined;
    const candidates = asked ? [asked] : [...new Set([remoteDefault, p.repo.defaultBranch, "main", "master", "trunk", "develop"].filter(Boolean))];
    let sha: string | null = null;
    for (const branch of candidates) {
      sha = await this.backend.resolve(p.repo.name, branch);
      if (sha) {
        p.repo.defaultBranch = branch;
        p.repo.forkAllBranches = remoteDefault !== branch;
        break;
      }
    }
    if (!sha) {
      p.importing = { ...p.importing, error: asked ? `The repository has no branch "${asked}".` : "gitring did not find the default branch of the repository. Import it again and name the branch." };
      this.db.setMeta("project", p);
      this.addLog({ kind: "system", message: `Import failed: ${p.importing.error}` });
      this.emit({ type: "snapshot", state: await this.state() });
      return;
    }
    await this.adoptMain(p.repo.defaultBranch, sha);
  }

  /** Main becomes `branch` at `sha` (after an import or the owner's first push). */
  protected async adoptMain(branch: string, sha: string): Promise<void> {
    const p = this.requireProject();
    const commit = await this.backend.readCommit(p.repo.name, sha);
    if (!commit) throw new Error("The imported head commit cannot be read.");
    p.repo.defaultBranch = branch;
    p.mainSha = sha;
    p.mainTree = commit.treeHash;
    const url = p.importing?.url ?? "";
    // Push tokens open the canonical repo; after the adoption only gitring writes to it.
    for (const id of p.importing?.tokenIds ?? []) await this.backend.revokeToken(p.repo.name, id).catch(() => false);
    // A public GitHub import keeps GitHub's commit ids: GitHub has this commit.
    if (p.importing?.github && !p.importing.github.snapshot) this.setGh(p.importing.github.repo, { last: sha, private: false });
    p.importing = undefined;
    this.db.setMeta("project", p);
    this.resetMainSeq(sha);
    this.mainView = undefined;
    const main = await this.loadMain();
    this.addLog({ kind: "system", message: `${url === "git push" ? "Push received" : `Import done: ${url}`} at ${sha.slice(0, 7)} on ${branch} (${main.files.length} files). Write tasks for agents.` });
    this.persistStats();
    this.emit({ type: "snapshot", state: await this.state() });
    // The code is in main now: gitring guesses how it installs and tests itself (in the background).
    const guessed = this.guessTests().catch((e) => console.warn("guess failed", errorLine(e)));
    this.ctx.waitUntil(guessed);
    // Built-in agents that the creator asked for start now (see launchWhenReady), after the guess: their
    // first test run uses the guessed commands.
    const later = this.db.getMeta<{ intentId: string; fanout: number; by: T.Actor }>("launchAfterImport");
    if (later) {
      this.db.setMeta("launchAfterImport", undefined);
      this.ctx.waitUntil(
        guessed
          .then(() => this.launch(later.intentId, { fanout: later.fanout }, later.by))
          .then(() => undefined)
          .catch((e) => this.addLog({ kind: "system", intentId: later.intentId, message: `The built-in agents did not start after the import: ${String((e as Error)?.message ?? e).slice(0, 200)}` })),
      );
    }
  }

  /**
   * Start built-in agents on a task now, or when the import is done (a new project can have its first
   * task before its code is in main). Answers the work copies that started now.
   */
  async launchWhenReady(intentId: string, fanout: number, by: T.Actor = HUMAN): Promise<{ attempts: string[]; afterImport: boolean }> {
    const p = this.requireProject();
    if (p.importing && !p.importing.error) {
      this.db.setMeta("launchAfterImport", { intentId, fanout, by });
      return { attempts: [], afterImport: true };
    }
    const res = await this.launch(intentId, { fanout }, by);
    return { attempts: res.attempts.map((a) => a.id), afterImport: false };
  }

  // ───── Guess the test command ─────

  /**
   * Guess the test commands from the files of main (after an import, a push or an upload), unless someone
   * already set the tests (meta "checksSet"). The rules read the manifests; when they find no test
   * command, a model reads the README and the file list. A guess with no test command changes nothing.
   */
  async guessTests(): Promise<T.CheckSettings | null> {
    if (this.db.getMeta<boolean>("checksSet")) return null;
    const p = this.requireProject();
    if (p.importing) return null;
    // Tests with commands, or the gitring test runner, are a choice (also on a project from before
    // "checksSet"): only the bare default (a container, no commands) gets a guess.
    const cur = p.settings.checks;
    if (cur && (cur.runner === "worker" || cur.install || cur.test)) return null;
    const main = await this.loadMain();
    const g = await guessTree({ label: p.name, paths: [...main.snapshot.keys()], read: async (path) => main.text.get(path) ?? null, ask: guessModel(this.env.AI) });
    // A person (or an agent) set the tests while the model answered: their choice stays.
    if (this.db.getMeta<boolean>("checksSet") || this.project !== p) return null;
    const checks: T.CheckSettings | null = g.runner === "worker" ? { runner: "worker" } : g.test ? { runner: "container", ...(g.install ? { install: g.install } : {}), test: g.test } : null;
    if (!checks) {
      this.addLog({ kind: "system", message: "gitring found no test command in the files of main. An owner sets it in Settings → Tests." });
      return null;
    }
    p.settings = withDefaults({ ...p.settings, checks });
    this.db.setMeta("project", p);
    this.addLog({
      kind: "system",
      message:
        checks.runner === "worker"
          ? "Tests: the gitring test runner runs tests/*.test.js. An owner can change it in Settings → Tests."
          : `Tests: gitring runs "${checks.test}"${checks.install ? ` after "${checks.install}"` : ""}.${g.guessed ? " A model guessed these commands." : ""} An owner can change them in Settings → Tests.`,
    });
    this.emit({ type: "snapshot", state: await this.state() });
    return checks;
  }

  // ───── Import from GitHub ─────

  /** The GitHub snapshot import that runs now. One import runs at a time. */
  protected snapshotRun?: Promise<void>;

  /**
   * Import a private GitHub repository: the commit at the branch tip, as files, in one gitring commit.
   * gitring remembers that this commit is the GitHub commit, so GitHub sync and pulls continue GitHub's
   * history.
   */
  protected async importGithubSnapshot(): Promise<void> {
    const p = this.requireProject();
    const g = p.importing?.github;
    if (!g || !p.importing) return;
    const fail = async (error: string) => {
      if (!p.importing) return;
      p.importing = { ...p.importing, error };
      this.db.setMeta("project", p);
      this.addLog({ kind: "system", message: `Import failed: ${error}` });
      this.emit({ type: "snapshot", state: await this.state() });
    };
    const tries = (g.tries ?? 0) + 1;
    if (tries > 3) return fail(`gitring tried three times to read ${g.repo} and stopped. Try again with a new project, or push the repository with git.`);
    p.importing = { ...p.importing, github: { ...g, tries } };
    this.db.setMeta("project", p);
    // A watchdog: if this run dies (memory), the alarm tries again, at most three times.
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
    const retryLater = async (why: string) => {
      this.addLog({ kind: "system", message: `Import of ${g.repo}: ${why} gitring tries again soon.` });
      await this.ctx.storage.setAlarm(Date.now() + 30_000 * tries);
    };
    try {
      const access = await this.directory().githubRepoAccess(g.repo);
      if (!access.ok) {
        if (access.state === "error") return retryLater(access.message);
        return fail(access.installUrl ? `${access.message} Install the app: ${access.installUrl}` : access.message);
      }
      const headers = { "User-Agent": "gitring", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${access.token}` };
      let branch = g.branch;
      if (!branch) {
        const info = await fetch(`https://api.github.com/repos/${g.repo}`, { headers });
        if (info.status >= 500) return retryLater(`GitHub answered ${info.status}.`);
        branch = info.ok ? ((await info.json<{ default_branch?: string }>()).default_branch ?? "main") : "main";
      }
      const res = await fetch(`https://api.github.com/repos/${g.repo}/commits/${encodeURIComponent(branch)}`, { headers: { ...headers, Accept: "application/vnd.github.sha" } });
      if (res.status >= 500) return retryLater(`GitHub answered ${res.status}.`);
      const githubSha = (await res.text()).trim();
      if (!res.ok || !/^[0-9a-f]{40}$/.test(githubSha)) return fail(`GitHub has no branch "${branch}" in ${g.repo}.`);
      p.repo.defaultBranch = branch;
      // An earlier run may have made the commit and then stopped: adopt it.
      const existing = await this.backend.resolve(p.repo.name, branch).catch(() => null);
      if (existing) {
        const meta = await this.backend.readCommit(p.repo.name, existing);
        const m = /Gitring-GitHub: (\S+)@([0-9a-f]{40})/.exec(meta?.message ?? "");
        if (!m || m[1].toLowerCase() !== g.repo.toLowerCase()) return fail("The project's repository already has commits that are not this import.");
        this.setGh(g.repo, { known: { ...this.gh(g.repo).known, [existing]: m[2] }, last: m[2], private: true });
        return this.adoptMain(branch, existing);
      }
      const snap = await githubSnapshot({ repo: g.repo, sha: githubSha, token: access.token });
      if (!snap.files.length) return fail(`${g.repo} has no files on ${branch}.`);
      const files = await this.matchGitTree(g.repo, githubSha, snap.files, access.token);
      this.holdPrivate(g.repo);
      const seed = await this.backend.commit({
        repo: p.repo.name,
        branch,
        parent: "",
        changes: files,
        message: `Import ${g.repo}\n\nThe files of ${branch} at ${githubSha} on GitHub (${files.length} files).\n\nGitring-Seed: github\nGitring-GitHub: ${g.repo}@${githubSha}`,
        author: GITRING_AUTHOR,
      });
      this.setGh(g.repo, { known: { ...this.gh(g.repo).known, [seed.sha]: githubSha }, last: githubSha, private: true });
      await this.adoptMain(branch, seed.sha);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      // Network trouble is worth another try; a repository that is too large is not.
      if (e instanceof SnapshotTooLarge || /larger than|more than|has no/.test(msg)) return fail(msg);
      return retryLater(msg);
    }
  }

  /**
   * GitHub makes tarballs with `git archive`: files marked export-ignore are missing, and line endings or
   * $Id$ can change. gitring compares each file with the commit's tree (git blob ids) and takes the
   * missing or different files from the Git Data API, so that main has exactly GitHub's files.
   * Without the tree (GitHub did not answer three times, or the tree is too large to list) the import
   * attempt fails: a snapshot that gitring could not check is never recorded as GitHub's commit.
   * One byte budget (the snapshot limits) covers the tarball's files and the files read one by one.
   */
  protected async matchGitTree(repo: string, sha: string, files: FileChange[], token: string, limits = SNAPSHOT_LIMITS): Promise<FileChange[]> {
    const headers = { "User-Agent": "gitring", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}` };
    const tree = await this.githubTree(repo, sha, headers);
    const want = new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e]));
    const out: FileChange[] = [];
    const fix: { path: string; sha: string; mode: string; size: number }[] = [];
    const tooLarge = () => new SnapshotTooLarge(`${repo} is larger than ${Math.round(limits.maxBytes / 1e6)} MB. Push it with git instead (history and all files).`);
    let bytes = 0;
    for (const f of files) {
      const e = want.get(f.path);
      if (!e) continue; // not in the commit (cannot happen for git archive, but stay exact)
      const data = typeof f.content === "string" ? utf8.encode(f.content) : (f.content ?? new Uint8Array());
      if ((await hashObject("blob", data)) === e.sha) {
        out.push({ ...f, mode: e.mode === "100755" ? "100755" : e.mode === "120000" ? "120000" : "100644" });
        bytes += data.length;
      } else fix.push({ path: f.path, sha: e.sha, mode: e.mode, size: e.size ?? 0 });
      want.delete(f.path);
    }
    for (const [path, e] of want) fix.push({ path, sha: e.sha, mode: e.mode, size: e.size ?? 0 });
    if (fix.length > 500) throw new Error(`${fix.length} files of ${repo} differ from its tarball. Push the repository with git instead.`);
    if (out.length + fix.length > limits.maxFiles) throw new SnapshotTooLarge(`${repo} has more than ${limits.maxFiles} files. Push it with git instead.`);
    // The sizes in the tree say what the files read one by one add, before gitring reads any of them.
    if (bytes + fix.reduce((n, x) => n + x.size, 0) > limits.maxBytes) throw tooLarge();
    for (const x of fix) {
      if (x.size > 15_000_000) throw new Error(`${x.path} is larger than 15 MB. Push the repository with git instead.`);
      const blob = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${x.sha}`, { headers: { ...headers, Accept: "application/vnd.github.raw" } });
      if (!blob.ok) throw new Error(`GitHub did not send ${x.path} (${blob.status}).`);
      const content = new Uint8Array(await blob.arrayBuffer());
      bytes += content.length;
      if (bytes > limits.maxBytes) throw tooLarge();
      out.push({ path: x.path, content, mode: x.mode === "100755" ? "100755" : x.mode === "120000" ? "120000" : "100644" });
    }
    return out;
  }

  /** The file list of a commit (GET /git/trees/{sha}?recursive=1), with two more tries after a GitHub error. */
  protected async githubTree(repo: string, sha: string, headers: Record<string, string>): Promise<{ path: string; mode: string; type: string; sha: string; size?: number }[]> {
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 400 * 3 ** (attempt - 2)));
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, { headers: { ...headers, Accept: "application/vnd.github+json" } });
        if (res.ok) {
          const tree = await res.json<{ truncated?: boolean; tree?: { path: string; mode: string; type: string; sha: string; size?: number }[] }>();
          if (tree.truncated) throw new SnapshotTooLarge(`GitHub does not list all files of ${repo}: it has more than the API shows. Push it with git instead.`);
          if (Array.isArray(tree.tree)) return tree.tree;
          last = "GitHub sent no file list";
        } else {
          last = `GitHub answered ${res.status}`;
          // The commit is gone or the token may not read it: another try does not help now.
          if (res.status === 404 || res.status === 401) break;
        }
      } catch (e) {
        if (e instanceof SnapshotTooLarge) throw e;
        last = String((e as Error)?.message ?? e).slice(0, 120);
      }
    }
    throw new Error(`gitring could not read the file list of ${repo} (${last}).`);
  }

  /** The branch the owner pushed: main, master, or the repo's default branch. */
  protected async pushedBranch(): Promise<{ branch: string; sha: string } | null> {
    const p = this.requireProject();
    let fallback = "";
    try {
      using repo = await this.env.ARTIFACTS.get(p.repo.name);
      fallback = (await repo.info()).defaultBranch ?? "";
    } catch {
      return null;
    }
    for (const branch of [...new Set(["main", "master", fallback, "trunk", "develop"].filter(Boolean))]) {
      const sha = await this.backend.resolve(p.repo.name, branch).catch(() => null);
      if (sha) return { branch, sha };
    }
    return null;
  }

  // ───── Access for git push and clone ─────

  /**
   * A push project: a write token for the owner's first `git push` (24 hours). gitring revokes it when
   * it adopts the push.
   */
  async pushAccess(): Promise<{ remote: string; token: string; expiresAt: string }> {
    const p = this.requireProject();
    if (!p.importing?.push || p.importing.error) throw new Error("This project does not wait for a push.");
    const t = await this.backend.createToken(p.repo.name, "write", 24 * 3600);
    if (!t) throw new Error("Artifacts did not make a token. Try again.");
    if (t.id) {
      p.importing = { ...p.importing, tokenIds: [...(p.importing.tokenIds ?? []), t.id].slice(-10) };
      this.db.setMeta("project", p);
    }
    const remote = p.repo.remote ?? (await this.backend.remoteUrl(p.repo.name)) ?? "";
    this.addLog({ kind: "system", message: "The owner took a push token (24 hours)." });
    return { remote, token: t.token, expiresAt: t.expiresAt };
  }

  /**
   * A member clones the project with plain git: the remote of main and a read token for 6 hours. The
   * Worker builds the git command (the token goes in a header, not in the URL).
   */
  async cloneAccess(): Promise<{ remote: string; token: string; expiresAt: string; branch: string }> {
    const p = this.requireProject();
    if (p.importing?.error) throw new Error(`The import did not finish: ${p.importing.error}`);
    if (p.importing) throw new Error(p.importing.push ? "This project waits for its first git push. Clone it after the push." : "The repository import is not done. Try again in a minute.");
    const tok = await this.backend.createToken(p.repo.name, "read", 6 * 3600);
    const remote = p.repo.remote ?? (await this.backend.remoteUrl(p.repo.name));
    if (!tok || !remote) throw new Error("gitring cannot give a clone remote now. Try again.");
    return { remote, token: tok.token, expiresAt: tok.expiresAt, branch: this.branch };
  }

  /** "Check now": look for the owner's push without waiting for the alarm. */
  async checkImport(): Promise<T.ProjectState> {
    await this.continueImport();
    return this.state();
  }
}
