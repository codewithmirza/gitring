/**
 * The read tools of the GitHub-compatible set: who am I, find projects, files, branches, commits and code search.
 *
 * A read of one of your branches also brings its change requests. Read next: src/worker/github-tools/README.md.
 */
import { z } from "zod";
import type * as T from "../../core/types";
import { directory } from "../auth";
import { READS, callOf, defineTool, fail, plain, text, withNews, type ToolDef } from "../mcp-kit";
import { data, entriesOf, github, iso, newsOf, owner, page, page_, perPage, repo, sha7 } from "./answers";
import { DONE, MAIN, cleanBranch, myBranches, open, resolve } from "./branches";

/** A commit that gitring merged into main: the landing is the record of it. */
function commitJson(l: T.Landing, state: T.ProjectState) {
  const agent = state.agents.find((x) => x.id === l.agentId)?.callsign ?? "agent";
  const task = state.intents.find((i) => i.id === l.intentId)?.title;
  return {
    sha: l.mainAfter,
    commit: { message: l.message, author: { name: agent, date: iso(l.at) }, committer: { name: "gitring", date: iso(l.at) } },
    gitring: { method: l.method, task: task ?? l.intentId },
  };
}

/** Search limits: gitring reads the files itself, so the scan has a size. */
const SCAN = { files: 400, bytes: 200_000 };

/** The qualifiers of GitHub code search. A word with another prefix, such as http:, is a plain word. */
const QUALIFIERS = new Set(["repo", "org", "user", "language", "path", "filename", "extension", "size", "fork", "in", "symbol", "content", "is", "enterprise", "license"]);

/** The query of search_code: words (or "phrases") that must be in the file, and the qualifiers that gitring uses. */
function parseSearch(query: string): { terms: string[]; path: string; ext: string; repo: string } {
  const out = { terms: [] as string[], path: "", ext: "", repo: "" };
  for (const m of String(query ?? "").matchAll(/"([^"]+)"|(\S+)/g)) {
    const word = m[1] ?? m[2];
    const qual = m[2] ? /^([A-Za-z]+):(.*)$/.exec(m[2]) : null;
    if (!qual || !QUALIFIERS.has(qual[1].toLowerCase())) out.terms.push(word.toLowerCase());
    else if (qual[1].toLowerCase() === "path") out.path = qual[2].toLowerCase();
    else if (qual[1].toLowerCase() === "extension") out.ext = `.${qual[2].replace(/^\./, "").toLowerCase()}`;
    else if (qual[1].toLowerCase() === "repo") out.repo = qual[2].split("/").pop() ?? "";
  }
  return out;
}

export const readTools: readonly ToolDef[] = [
  defineTool({
    name: "get_me",
    title: "Show who I am",
    description:
      "GitHub-compatible: show who you are. gitring has no profile page. " +
      "The answer has your name, your id and the projects that you can use. Use a project id as repo in the other tools.",
    inputSchema: {},
    annotations: READS,
    async run(ctx) {
      try {
        const list = await directory(ctx.env).listProjects(ctx.who.user?.id ?? null);
        const me = { login: ctx.who.user?.name ?? "operator", id: ctx.who.user?.id ?? null, projects: list.map((x) => ({ repo: x.id, name: x.name, role: x.role })) };
        return data(me, `You are ${me.login}. You can use ${list.length} projects. Use a project id as repo.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "search_repositories",
    title: "Find projects",
    description:
      "GitHub-compatible: find projects by name. A repository here is a gitring project. " +
      "gitring searches only the projects that you can see. It ignores search qualifiers such as org: and language:.",
    inputSchema: { query: z.string(), page, perPage, sort: z.string().optional(), order: z.string().optional(), minimal_output: z.boolean().optional() },
    annotations: READS,
    async run(ctx, a) {
      try {
        const words = String(a.query ?? "").toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
        const all = await directory(ctx.env).listProjects(ctx.who.user?.id ?? null);
        const hits = all.filter((p) => words.every((w) => p.id.includes(w) || p.name.toLowerCase().includes(w)));
        const items = page_(hits, a.page, a.perPage).map((p) => ({ id: p.id, name: p.id, full_name: p.id, description: p.name, private: p.visibility !== "public", default_branch: MAIN, role: p.role }));
        return data({ total_count: hits.length, incomplete_results: false, items }, `${hits.length} projects match.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "get_file_contents",
    title: "Read a file or folder",
    description:
      "GitHub-compatible: read one file, or list one folder. Set ref to main, to one of your branches, or to a full commit id. " +
      "repo is the project id. gitring ignores owner. Only text files work.",
    inputSchema: { owner, repo, path: z.string().optional().describe('The path. "/" is the top folder.'), ref: z.string().optional(), sha: z.string().optional() },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "viewer");
        const t = await resolve(h, ctx.who, a.ref, a.sha);
        const path = String(a.path ?? "/").replace(/^\/+/, "").replace(/\/+$/, "");
        if (path) {
          const body = t.attemptId ? (await h.stub.read(t.attemptId, path, callOf(ctx, h))).content : await h.stub.file(t.ref, path);
          if (body !== null) return withNews(plain(body), await newsOf(ctx, h, t.attemptId), github);
        }
        const entries = entriesOf((await h.stub.tree(t.ref)).files, path);
        if (!entries.length) throw new Error(`There is no text file or folder "${path}" on ${t.name}.`);
        return data(entries, `${entries.length} entries in ${path || "the top folder"} on ${t.name}.`, await newsOf(ctx, h, t.attemptId));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "get_repository_tree",
    title: "List files of a ref",
    description:
      "GitHub-compatible: list the files of main, of one of your branches, or of a full commit id. Set tree_sha to the ref. " +
      "Set path_filter to one folder. Set recursive to true to list all files below it. gitring ignores owner.",
    inputSchema: { owner, repo, tree_sha: z.string().optional(), recursive: z.boolean().optional(), path_filter: z.string().optional() },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "viewer");
        const t = await resolve(h, ctx.who, a.tree_sha);
        const res = await h.stub.tree(t.ref);
        const dir = String(a.path_filter ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
        const tree = a.recursive
          ? res.files.filter((f) => !dir || f.path === dir || f.path.startsWith(`${dir}/`)).map((f) => ({ path: f.path, type: "blob", size: f.size }))
          : entriesOf(res.files, dir).map((e) => ({ path: e.path, type: e.type === "dir" ? "tree" : "blob", size: e.size }));
        return data({ sha: res.sha, truncated: false, tree }, `${tree.length} entries on ${t.name}.`, await newsOf(ctx, h, t.attemptId));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "list_branches",
    title: "List branches",
    description:
      "GitHub-compatible: list main and your own branches. A branch is a work copy of gitring. " +
      "gitring does not show the branches of other agents. gitring ignores owner.",
    inputSchema: { owner, repo, page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const h = await open(ctx, a.repo, "viewer");
        const state = await h.stub.state();
        const mine = [...myBranches(state, ctx.who)].map(([name, at]) => ({ name, commit: { sha: at.headSha ?? at.baseSha }, protected: false, status: DONE.has(at.status) ? at.status : "open" }));
        const all = [{ name: MAIN, commit: { sha: state.project.mainSha }, protected: true, status: "open" }, ...mine];
        return data(page_(all, a.page, a.perPage), `${all.length} branches. Main and ${mine.length} of yours.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "list_commits",
    title: "List merged commits",
    description:
      "GitHub-compatible: list the commits that gitring merged into main, newest first. gitring has no other commit history here. " +
      "It ignores path and author. Set sha to main or leave it out. Use since and until to limit the dates.",
    inputSchema: { owner, repo, sha: z.string().optional(), path: z.string().optional(), author: z.string().optional(), since: z.string().optional(), until: z.string().optional(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        if (a.sha && cleanBranch(a.sha) !== MAIN) throw new Error("gitring lists the commits of main only. Set sha to main, or leave it out.");
        const from = a.since ? Date.parse(a.since) : -Infinity;
        const to = a.until ? Date.parse(a.until) : Infinity;
        if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("Give since and until as dates, for example 2026-01-31T00:00:00Z.");
        const h = await open(ctx, a.repo, "viewer");
        const state = await h.stub.state();
        const all = state.landings.filter((l) => l.at >= from && l.at <= to).sort((x, y) => y.at - x.at);
        const items = page_(all, a.page, a.perPage).map((l) => commitJson(l, state));
        return data(items, `${all.length} commits that gitring merged into main.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "get_commit",
    title: "Read a merged commit",
    description:
      "GitHub-compatible: read one commit that gitring merged into main. Give its id in sha. The answer has the message and the changed files. " +
      "gitring has details only for commits that it merged. Set include_diff to false to leave out the patches.",
    inputSchema: { owner, repo, sha: z.string(), include_diff: z.boolean().optional(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const want = String(a.sha ?? "").trim().toLowerCase();
        if (!/^[0-9a-f]{7,40}$/.test(want)) throw new Error("Give the commit id: 7 to 40 hex digits.");
        const h = await open(ctx, a.repo, "viewer");
        const state = await h.stub.state();
        const landing = state.landings.find((l) => l.mainAfter.startsWith(want));
        if (!landing) throw new Error(`gitring has no details for the commit ${want.slice(0, 7)}. It has details only for commits that it merged into main.`);
        const diff = await h.stub.attemptDiff(landing.attemptId);
        const files = page_(diff.files, a.page, a.perPage).map((f) => ({
          filename: f.path,
          status: f.status === "A" ? "added" : f.status === "D" ? "removed" : "modified",
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
          ...(a.include_diff === false ? {} : { patch: f.diff }),
        }));
        return data({ ...commitJson(landing, state), stats: { additions: diff.files.reduce((n, f) => n + f.additions, 0), deletions: diff.files.reduce((n, f) => n + f.deletions, 0) }, files }, `Commit ${sha7(landing.mainAfter)}: ${diff.files.length} files changed.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "search_code",
    title: "Search code",
    description:
      "GitHub-compatible: search the text files of main in one project. Give the project id in repo, or as repo:name in the query. " +
      "Every word of the query must be in the file. gitring ignores case. It ignores other qualifiers, except path: and extension:. " +
      "It reads 400 files at most, and no file above 200 KB.",
    inputSchema: { query: z.string(), repo: z.string().optional().describe("The gitring project id. You can give repo:name in the query instead."), sort: z.string().optional(), order: z.string().optional(), page, perPage },
    annotations: READS,
    async run(ctx, a) {
      try {
        const q = parseSearch(a.query);
        const raw = a.repo ?? q.repo;
        if (!raw) throw new Error("Give repo (the project id), or repo:name in the query.");
        if (!q.terms.length) throw new Error("Give at least one word to search for.");
        const h = await open(ctx, raw, "viewer");
        const files = (await h.stub.tree(MAIN)).files.filter((f) => f.size <= SCAN.bytes && (!q.path || f.path.toLowerCase().includes(q.path)) && (!q.ext || f.path.toLowerCase().endsWith(q.ext)));
        const hits: { name: string; path: string; repository: { full_name: string }; text_matches: { fragment: string }[] }[] = [];
        for (const f of files.slice(0, SCAN.files)) {
          const body = await h.stub.file(MAIN, f.path);
          if (body === null) continue;
          const low = body.toLowerCase();
          if (!q.terms.every((t) => low.includes(t))) continue;
          const at = low.indexOf(q.terms[0]);
          hits.push({ name: f.path.split("/").pop() ?? f.path, path: f.path, repository: { full_name: h.id }, text_matches: [{ fragment: body.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, " ").trim() }] });
        }
        const partial = files.length > SCAN.files;
        return data({ total_count: hits.length, incomplete_results: partial, items: page_(hits, a.page, a.perPage) }, `${hits.length} files match.${partial ? ` gitring read the first ${SCAN.files} files only.` : ""}`);
      } catch (e) {
        return fail(e);
      }
    },
  }),
];
