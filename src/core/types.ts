/**
 * The front door of the core domain types: it re-exports every type file of `src/core/types/`.
 *
 * Import from here (`../core/types`), not from a file inside the folder. Never add a declaration to this file.
 * The Worker, the Durable Objects and the web app share these types, so none of them has a runtime dependency.
 * Read `src/core/types/README.md` for the file of each domain.
 */

/*
 * gitring is a home for code that many agents change at the same time. Each project has its git
 * repository in Cloudflare Artifacts; GitHub is one optional import source and sync target.
 *
 * Vocabulary (code name → the word that people see):
 *   Intent      a task: a goal plus executable checks. Agents take tasks; a task merges when its work passes.
 *   Attempt     a work copy: one agent's work on one task, in its own Artifacts fork.
 *   Course      the plan that an agent sends BEFORE it writes code: steps, files, symbols.
 *   Footprint   what an agent actually touched (from real diffs).
 *   Course check  the conflict check of a plan against the active plans and main.
 *   Correction  a change request: an amendment to an agent's plan. The agent keeps its work and continues.
 *   Landing     a merge into main, one at a time (fast-forward → 3-way merge → redo on the new main).
 *   Logbook     the history of why: task, plan, change requests, tests, decision (git notes).
 */

export * from "./types/basics";
export * from "./types/projects";
export * from "./types/settings";
export * from "./types/settings-defaults";
export * from "./types/github";
export * from "./types/tasks";
export * from "./types/plans";
export * from "./types/work-copies";
export * from "./types/checks";
export * from "./types/approvals";
export * from "./types/conflict-check";
export * from "./types/change-requests";
export * from "./types/records";
export * from "./types/questions";
export * from "./types/traffic";
export * from "./types/state";
export * from "./types/agent-protocol";
