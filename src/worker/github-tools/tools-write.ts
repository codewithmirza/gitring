/**
 * The write tools of the GitHub-compatible set: make a branch, write files, delete a file.
 *
 * Nothing writes to main. A write goes to the work copy of the caller, and the conflict check runs after it.
 */
import { z } from "zod";
import { ADDS, CHANGES, defineTool, fail, text, VERDICT_WORD, type ToolDef } from "../mcp-kit";
import { data, owner, repo, sha7 } from "./answers";
import { MAIN, branchCopy, cleanBranch, open, workBranch, writeToBranch } from "./branches";

export const writeTools: readonly ToolDef[] = [
  defineTool({
    name: "create_branch",
    title: "Make a branch",
    description:
      "GitHub-compatible: make a branch for your work. gitring makes a work copy from main, and a task for it. " +
      "from_branch must be main. Then call push_files or create_or_update_file. " +
      "A real plan from gitring_declare gives better coordination. That tool is on the full endpoint.",
    inputSchema: { owner, repo, branch: z.string(), from_branch: z.string().optional().describe("Main, or leave it out.") },
    annotations: ADDS,
    async run(ctx, a) {
      try {
        const branch = workBranch(a.branch);
        if (a.from_branch && cleanBranch(a.from_branch) !== MAIN) throw new Error("gitring makes branches from main only. Set from_branch to main, or leave it out.");
        const h = await open(ctx, a.repo, "member");
        const made = await branchCopy(ctx, h, branch, { title: `Branch ${branch}`, paths: [] });
        if (made.existed || !made.declared) throw new Error(`The branch "${branch}" exists already. Write to it with push_files.`);
        const d = made.declared;
        return data(
          { ref: `refs/heads/${branch}`, object: { sha: d.workspace.baseSha } },
          `The branch "${branch}" is ready. It starts from main at ${sha7(d.workspace.baseSha)}. Conflict check: ${VERDICT_WORD[d.clearance.verdict] ?? d.clearance.verdict}. ${d.clearance.advice}`,
          d.clearance,
        );
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "push_files",
    title: "Write many files",
    description:
      "GitHub-compatible: write many files to one branch in one call. gitring writes to your work copy, never to main. " +
      "A new branch name makes a new work copy. gitring checks your work against the 20 nearest active plans after each write. " +
      "The answer can hold change requests. Apply them in your next edits.",
    inputSchema: { owner, repo, branch: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })), message: z.string() },
    // A write replaces the whole text of a file in the work copy.
    annotations: CHANGES,
    async run(ctx, a) {
      try {
        return await writeToBranch(ctx, a, (a.files ?? []).map((f) => ({ path: f.path, content: f.content })));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "create_or_update_file",
    title: "Write one file",
    description:
      "GitHub-compatible: write one whole file to a branch. gitring writes to your work copy, never to main. " +
      "gitring ignores sha and owner. It checks the change against the 20 nearest active plans instead. " +
      "The answer can hold change requests. Apply them in your next edits.",
    inputSchema: { owner, repo, path: z.string(), content: z.string(), message: z.string(), branch: z.string(), sha: z.string().optional() },
    annotations: CHANGES,
    async run(ctx, a) {
      try {
        return await writeToBranch(ctx, a, [{ path: a.path, content: a.content }]);
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "delete_file",
    title: "Delete a file",
    description:
      "GitHub-compatible: delete one file from a branch. gitring deletes it in your work copy, never on main. " +
      "gitring checks the change against the 20 nearest active plans. The answer can hold change requests. Apply them in your next edits.",
    inputSchema: { owner, repo, path: z.string(), message: z.string(), branch: z.string() },
    annotations: CHANGES,
    async run(ctx, a) {
      try {
        return await writeToBranch(ctx, a, [{ path: a.path, delete: true }]);
      } catch (e) {
        return fail(e);
      }
    },
  }),
];
