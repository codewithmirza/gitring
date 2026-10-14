/**
 * The pull request tools of the GitHub-compatible set: ask for a merge, read, list, wait, update the branch.
 *
 * merge_pull_request never merges by itself and never skips the tests. gitring merges when the tests pass and a person said yes.
 */
import { z } from "zod";
import type * as T from "../../core/types";
import { ADDS, CHANGES, READS, callOf, defineTool, fail, plain, withNews, type ToolDef } from "../mcp-kit";
import { answerNote, answerPlace, askInChat, takeAnswer } from "../mcp-approval";
import { data, github, newsOf, owner, page, page_, perPage, repo } from "./answers";
import { DONE, MAIN, cleanBranch, myBranches, open, workBranch } from "./branches";
import { MERGE_WAIT, myPulls, pullAt, pullInfo, pullJson, pullReply, sleep } from "./pulls";

const readMethods = z.enum(["get", "get_diff", "get_status", "get_files", "get_commits", "get_review_comments", "get_reviews", "get_comments", "get_check_runs"]);

export const pullTools: readonly ToolDef[] = [
  defineTool({
    name: "create_pull_request",
    title: "Ask for a merge",
    description:
      "GitHub-compatible: ask for a merge of your branch into main. base must be main. gitring runs the tests first. " +
      "The answer says: queued, merged, waits for a person, or the tests failed. " +
      "Sometimes a person must say yes first. Then gitring asks the person. It asks in this chat if the client can show a question and the person allows it. If not, the answer has a link to the gitring app. " +
      "Wait for the person. Do not change the branch. Call merge_pull_request to see the answer. " +
      "After a failure, fix the files and call this tool again. gitring has no draft pull requests and no reviewers.",
    inputSchema: {
      owner,
      repo,
      title: z.string(),
      head: z.string().describe("Your branch."),
      base: z.string().describe("Main."),
      body: z.string().optional(),
      draft: z.boolean().optional(),
      maintainer_can_modify: z.boolean().optional(),
      reviewers: z.array(z.string()).optional(),
    },
    // A merge adds a commit to main and keeps the history. It can also send the merge to GitHub.
    annotations: { ...ADDS, openWorldHint: true },
    async run(ctx, a, req) {
      try {
        if (cleanBranch(a.base) !== MAIN) throw new Error("gitring merges into main only. Set base to main.");
        // GitHub can name the head as owner:branch. gitring has no owners.
        const head = workBranch(String(a.head ?? "").replace(/^[^:/]+:/, ""));
        const h = await open(ctx, a.repo, "member");
        const viewer = ctx.who.user ? { id: ctx.who.user.id, role: h.role } : undefined;
        const at = myBranches(await h.stub.state(), ctx.who).get(head);
        if (!at) throw new Error(`The branch "${head}" does not exist. Write to it with push_files first.`);
        // The second call of a question in chat: the person answered, so pass the answer on.
        const taken = await takeAnswer(ctx, req, h, at.id);
        if (taken) return pullReply(ctx, h, at.id, taken.status, { asked: !taken.result, before: answerNote(taken.result), app: taken.app });
        if (a.draft) return plain(`gitring has no draft pull requests. The branch "${head}" stays a work copy. Call create_pull_request again without draft when it is ready.`);
        if (DONE.has(at.status)) {
          throw new Error(
            at.status === "landed"
              ? `The branch "${head}" is merged already. Write to it to start new work. Then call create_pull_request again.`
              : `The work copy of the branch "${head}" is closed. Write to the branch to start a new work copy. Then call create_pull_request again.`,
          );
        }
        if (!(await h.stub.attemptDiff(at.id)).files.length) throw new Error(`The branch "${head}" has no changes. Write files to it first.`);
        const res = await h.stub.submit(at.id, [a.title, a.body].filter(Boolean).join("\n\n"), { origin: ctx.origin, viewer });
        if (res.next === "awaiting-approval") {
          // A person must say yes. Submit delivered its change requests already: the next answer holds them again.
          const again = res.clearance.corrections.map((c) => c.id);
          const st = await h.stub.status(at.id, { origin: ctx.origin, viewer, again });
          // Ask in this chat when the client can show a question and the person allows it. Else the answer holds the link.
          const place = await answerPlace(ctx, st);
          return (
            (await askInChat(ctx, req, h, st, { place, again })) ??
            (await pullReply(ctx, h, at.id, st, { extra: { checks: res.checks ? { passed: res.checks.passed, failed: res.checks.failed } : undefined }, app: place === "app" }))
          );
        }
        const state = await h.stub.state();
        const mine = myPulls(state, ctx.who).find((x) => x.attempt.id === at.id);
        const number = mine?.number;
        const words: Record<string, string> = {
          "landing-queue": "queued",
          landed: "merged",
          "fix-checks": "tests failed",
        };
        return data(
          { number, state: "open", head: { ref: head }, base: { ref: MAIN }, merge: words[res.next] ?? res.next, checks: res.checks ? { passed: res.checks.passed, failed: res.checks.failed } : undefined, message: res.message },
          `Pull request ${number ?? "?"}: ${words[res.next] ?? res.next}. ${res.message}`,
          res.clearance,
        );
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "pull_request_read",
    title: "Read a pull request",
    description:
      "GitHub-compatible: read one of your pull requests. Methods: get, get_status, get_files and get_diff. " +
      "gitring has no commits, reviews or comments on a pull request. gitring shows only your own pull requests.",
    inputSchema: { method: readMethods, owner, repo, pullNumber: z.number().int(), page, perPage, after: z.string().optional() },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "member");
        const state = await h.stub.state();
        const p = pullAt(state, ctx.who, a.pullNumber);
        const info = pullInfo(p, state, ctx.origin);
        const clr = a.method.startsWith("get") ? await newsOf(ctx, h, p.attempt.id) : undefined;
        switch (a.method) {
          case "get":
            return data(pullJson(p, state, ctx.origin), `Pull request ${p.number}: ${info.status}. ${info.message}`, clr);
          case "get_status": {
            const runs = [
              { context: "tests of the branch", run: p.attempt.checks },
              { context: "tests with main", run: p.attempt.composedChecks },
            ].filter((x): x is { context: string; run: T.CheckRun } => Boolean(x.run));
            const statuses = runs.map((x) => ({ context: x.context, state: x.run.ok ? "success" : "failure", description: `${x.run.passed}/${x.run.passed + x.run.failed} tests pass.${x.run.error ? ` ${x.run.error}` : ""}` }));
            const overall = statuses.length === 0 ? "pending" : statuses.every((s) => s.state === "success") ? "success" : "failure";
            return data({ state: overall, sha: p.attempt.headSha ?? p.attempt.baseSha, total_count: statuses.length, statuses }, `Pull request ${p.number}: tests ${overall}.`, clr);
          }
          case "get_files": {
            const diff = await h.stub.attemptDiff(p.attempt.id);
            const files = diff.files.map((f) => ({ filename: f.path, status: f.status === "A" ? "added" : f.status === "D" ? "removed" : "modified", additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions, patch: f.diff }));
            return data(page_(files, a.page, a.perPage), `${files.length} files changed in pull request ${p.number}.`, clr);
          }
          case "get_diff": {
            const diff = await h.stub.attemptDiff(p.attempt.id);
            return withNews(plain(diff.files.map((f) => f.diff).join("\n") || "No file changed."), clr, github);
          }
          default:
            throw new Error(`gitring has no ${a.method.replace(/^get_/, "").replace(/_/g, " ")} on a pull request. Use get, get_status, get_files or get_diff.`);
        }
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "list_pull_requests",
    title: "List pull requests",
    description:
      "GitHub-compatible: list your pull requests. A pull request is a branch that you sent with create_pull_request. " +
      "gitring shows only your own pull requests. It ignores head, base, sort and direction.",
    inputSchema: { owner, repo, state: z.enum(["open", "closed", "all"]).optional(), head: z.string().optional(), base: z.string().optional(), sort: z.string().optional(), direction: z.string().optional(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "member");
        const state = await h.stub.state();
        const want = a.state ?? "open";
        const all = myPulls(state, ctx.who).filter((p) => want === "all" || pullInfo(p, state, ctx.origin).state === want);
        const items = page_(all, a.page, a.perPage).map((p) => {
          const j = pullJson(p, state, ctx.origin);
          return { number: j.number, title: j.title, state: j.state, merged: j.merged, head: j.head, base: j.base, gitring: j.gitring };
        });
        return data(items, `${all.length} pull requests.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "merge_pull_request",
    title: "Wait for the merge",
    description:
      "GitHub-compatible: report the merge of one of your pull requests, and wait for it for a short time. " +
      "This tool never merges by itself and never skips the tests. gitring merges when the tests pass. " +
      "The answer says: merged, queued, waits for a person, tests failed, or not merged. gitring ignores the merge method.",
    inputSchema: { owner, repo, pullNumber: z.number().int(), commit_title: z.string().optional(), commit_message: z.string().optional(), merge_method: z.enum(["merge", "squash", "rebase"]).optional() },
    // It changes nothing: it reads the state, and it waits.
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "member");
        const until = Date.now() + MERGE_WAIT.ms;
        for (;;) {
          const state = await h.stub.state();
          const p = pullAt(state, ctx.who, a.pullNumber);
          const info = pullInfo(p, state, ctx.origin);
          if (info.final || Date.now() >= until) {
            return data(
              { number: p.number, merged: info.merged, state: info.state, status: info.status, message: info.message },
              `Pull request ${p.number}: ${info.status}. ${info.message}${info.final ? "" : " It is not done yet. Call this tool again."}`,
              await newsOf(ctx, h, p.attempt.id),
            );
          }
          await sleep(MERGE_WAIT.stepMs);
        }
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "update_pull_request_branch",
    title: "Update a branch from main",
    description:
      "GitHub-compatible: move your branch onto the new main. gitring does it and names the files to read again. " +
      "Where your change and main touch the same lines, gitring keeps the main text. Write your change again. " +
      "gitring ignores expectedHeadSha.",
    inputSchema: { owner, repo, pullNumber: z.number().int(), expectedHeadSha: z.string().optional() },
    annotations: CHANGES,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "member");
        const p = pullAt(await h.stub.state(), ctx.who, a.pullNumber);
        const res = await h.stub.update(p.attempt.id, callOf(ctx, h));
        return data(res, res.message, await newsOf(ctx, h, p.attempt.id));
      } catch (e) {
        return fail(e);
      }
    },
  }),
];
