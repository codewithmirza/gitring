/**
 * MCP tools for projects: an agent creates a project with one call, lists the starter templates, and
 * clones a project with plain git. gitring is the home of the code: GitHub is not needed for any of it.
 *
 *   gitring_create_project  a new project of the caller (OAuth token with the scope mcp, or a key; the
 *                           operator key makes a project that no person owns), seeded, tests guessed,
 *                           an optional first task and built-in agents
 *   gitring_templates       the starter templates (read-only)
 *   gitring_clone           a git clone command with a 6-hour read token (members)
 *
 * The creation is the same code as POST /api/projects (src/worker/projects.ts, contract C5).
 */
import { z } from "zod";
import type { HarborMaster } from "../harbor/harbor";
import { TEMPLATES, type TemplateId } from "../core/templates";
import { ADDS, READS, defineTool, fail, text, type ToolContext, type ToolDef } from "./mcp-kit";
import { cloneHelp, createProjectFor, type CloneHelp } from "./projects";

const TEMPLATE_IDS = TEMPLATES.map((t) => t.id) as [TemplateId, ...TemplateId[]];

/** The clone access of a project object (the stub of ctx.access has only the tool methods). */
type Cloner = Pick<HarborMaster, "cloneAccess">;

async function cloneOf(stub: unknown, project: string): Promise<CloneHelp> {
  return cloneHelp(await (stub as Cloner).cloneAccess(), project);
}

function appUrl(ctx: ToolContext, project: string): string {
  return `${ctx.origin}/overview?project=${encodeURIComponent(project)}`;
}

export const PROJECT_TOOLS: readonly ToolDef[] = [
  defineTool({
    name: "gitring_create_project",
    title: "Create a project",
    description:
      "Create a new gitring project that you own. Start it from a template, empty, from files, or from a public git URL. " +
      "gitring makes the git repository and guesses the test commands. " +
      "Give firstTask to open the first task, and launch to start built-in agents on it. " +
      "The answer has the project id, the app link, a git clone command and the next steps.",
    inputSchema: {
      name: z.string().describe("The project name, for example Robin's shop."),
      description: z.string().optional().describe("What the project is for. With launch and no firstTask, it becomes the goal of the first task."),
      visibility: z.enum(["private", "public"]).optional().describe("Default private: only you and the people you add can see it."),
      start: z
        .object({
          kind: z.enum(["empty", "template", "files", "git"]).describe("empty: a README. template: a starter template. files: the files you send. git: an import of a public https git URL."),
          template: z.enum(TEMPLATE_IDS).optional().describe("The template id (kind template). Call gitring_templates to see them."),
          files: z.array(z.object({ path: z.string(), content: z.string() })).optional().describe("The files of the first commit (kind files). Text only, at most 20 MB."),
          url: z.string().optional().describe("An https URL of a public git repository on any host (kind git)."),
          branch: z.string().optional().describe("The branch to import (kind git). Default: the default branch."),
        })
        .describe("Where the code comes from."),
      tests: z
        .object({
          runner: z.enum(["worker", "container"]).optional().describe("worker: the gitring test runner runs tests/*.test.js. container: the install and test commands run in a Linux container."),
          install: z.string().optional().describe("The install command (container)."),
          test: z.string().optional().describe("The test command (container)."),
        })
        .optional()
        .describe("How the tests run. Leave it out: a template uses the gitring test runner, and gitring guesses the commands for other code."),
      firstTask: z.object({ title: z.string().optional(), goal: z.string().optional() }).optional().describe("The first task: a goal, and a short title. Without a goal, the description is the goal."),
      launch: z.number().int().min(0).max(4).optional().describe("How many built-in agents start on the first task (0 to 4). Default 0: you do the work."),
    },
    // An import reads a git host outside gitring.
    annotations: { ...ADDS, openWorldHint: true },
    async run(ctx, args) {
      try {
        const start = args.start;
        if (start.kind === "template" && !start.template) throw new Error(`Give start.template: one of ${TEMPLATE_IDS.join(", ")}.`);
        if (start.kind === "git" && !start.url) throw new Error("Give start.url: the https URL of a public git repository.");
        if (start.kind === "files" && !start.files?.length) throw new Error("Give start.files: the path and the content of each file.");
        const source =
          start.kind === "files" ? { kind: "upload" } : start.kind === "git" ? { kind: "git", url: start.url, ...(start.branch ? { branch: start.branch } : {}) } : start.kind === "template" ? { kind: "template", template: start.template } : { kind: "empty" };
        const t = args.tests;
        const checks = t && (t.runner || t.install || t.test) ? { runner: t.runner ?? (t.install || t.test ? "container" : "worker"), ...(t.install ? { install: t.install } : {}), ...(t.test ? { test: t.test } : {}) } : undefined;
        // The first task: firstTask, or the description when built-in agents must start on something.
        const task = args.firstTask ?? (args.launch && args.description ? { goal: args.description } : undefined);
        const made = await createProjectFor(ctx.env, ctx.who, {
          name: args.name,
          visibility: args.visibility ?? "private",
          source,
          files: start.kind === "files" ? (start.files ?? []).map((f) => ({ path: f.path, text: f.content })) : undefined,
          settings: checks ? { checks: checks as { runner: "worker" | "container"; install?: string; test?: string } } : undefined,
          firstTask: task ? { title: task.title, goal: task.goal || args.description || "" } : undefined,
          launch: task ? args.launch : 0,
        });
        const id = made.project.id;
        const importing = made.state.project.importing;
        const clone = importing ? null : await cloneOf(ctx.env.HARBOR.get(ctx.env.HARBOR.idFromName(id)), id).catch(() => null);
        const next = [
          made.task
            ? made.launched.length
              ? `${made.launched.length} built-in ${made.launched.length === 1 ? "agent works" : "agents work"} on the task "${made.task.title}". Call gitring_intents with project "${id}" to see the work.`
              : made.launchAfterImport
                ? `The built-in agents start on the task "${made.task.title}" when the import is done.`
                : `Call gitring_declare with project "${id}", intentId "${made.task.id}" and your plan. Then write the work.`
            : `Call gitring_declare with project "${id}" and newIntent to send the first task and your plan.`,
          clone
            ? "To work on your computer, run the command in clone.clone. The read token works for 6 hours. Keep it private."
            : importing
              ? "When the import is done, call gitring_clone to get a git clone command."
              : "Call gitring_clone to get a git clone command.",
          `Open the project in the gitring app: ${appUrl(ctx, id)}`,
        ];
        const what = importing ? `gitring imports ${importing.url}. The import takes some minutes.` : `Main has the first commit (${made.state.project.mainSha.slice(0, 7)}).`;
        return text(
          {
            project: id,
            name: made.project.name,
            visibility: made.project.visibility,
            url: appUrl(ctx, id),
            source: made.project.source,
            tests: made.state.project.settings.checks ?? { runner: "worker" },
            ...(made.task ? { task: { id: made.task.id, title: made.task.title } } : {}),
            ...(made.launched.length ? { launched: made.launched } : {}),
            ...(clone ? { clone } : {}),
            next,
          },
          `Project "${id}" is ready. ${what} ${next[0]}`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  }),

  defineTool({
    name: "gitring_templates",
    title: "List templates",
    description: "List the starter templates of gitring_create_project. The templates with code have tests that run in the gitring test runner.",
    inputSchema: {},
    annotations: READS,
    async run() {
      return text(
        TEMPLATES.map((t) => ({ id: t.id, title: t.title, summary: t.summary })),
        `${TEMPLATES.length} templates. Give one id in start.template of gitring_create_project.`,
      );
    },
  }),

  defineTool({
    name: "gitring_clone",
    title: "Clone a project",
    description:
      "Get a git command that clones a project: the remote of main and a read token for 6 hours. " +
      "The token goes in an HTTP header, not in the URL. Members only.",
    inputSchema: { project: z.string().describe("Project id (gitring_intents without a project lists your projects).") },
    // It makes a read token: it changes no code.
    annotations: ADDS,
    async run(ctx, args) {
      try {
        const h = await ctx.access(args.project, "member");
        const clone = await cloneOf(h.stub, h.id);
        return text(clone, `Run the clone command below to clone ${h.id}. Later, the pull command gets the new commits of main. The token works for 6 hours. Keep it private.`);
      } catch (e) {
        return fail(e);
      }
    },
  }),
];
