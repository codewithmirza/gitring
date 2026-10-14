/**
 * The draft of a new project, kept by the page that shows the picker.
 * A closed panel keeps what the person typed and chose, and a link (?new=…) can open the picker at one source.
 */
import type { GithubRepo, Visibility } from "../../../../src/core/accounts";
import type { GithubSyncMode } from "../../../../src/core/types";
import { githubRepoName } from "../../../../src/core/repo-rules";

export type SourceStep =
  | { kind: "list" }
  /** A description: gitring picks a template, writes the first task and starts built-in agents. */
  | { kind: "describe"; text: string }
  | { kind: "template" }
  | { kind: "github"; repo: string; known?: GithubRepo }
  | { kind: "git"; url: string; note?: string }
  | { kind: "upload" }
  | { kind: "push" }
  | { kind: "empty" };

export interface FormValues {
  name: string;
  branch: string;
  install: string;
  test: string;
  sync: GithubSyncMode;
  visibility: Visibility;
  url: string;
  /** The template of a new project (the describe and template steps). */
  template: string;
  /** Built-in agents that start on the first task (the describe step). */
  agents: number;
  /** The text of the describe step. */
  description: string;
}

export interface NewProjectDraft {
  /** The text of the GitHub repository search. */
  query: string;
  /** The text of "Describe what you want to build". */
  description: string;
  step: SourceStep;
  /** Values the person changed. A value that is not here comes from gitring's guess. */
  form: Partial<FormValues>;
  /** The folder the person picked (upload). */
  upload: { files: File[]; folder: string } | null;
}

export const EMPTY_DRAFT: NewProjectDraft = { query: "", description: "", step: { kind: "list" }, form: {}, upload: null };

/**
 * The draft that a link asks for:
 *   ?new=1 (or github)       the source list (a draft of an earlier opening stays)
 *   ?new=upload|push|empty   that source
 *   ?new=template            the template list
 *   ?new=describe&text=…     the describe step with that text
 *   ?new=git&url=…           a public git URL (without url: the URL step, empty)
 *   &repo=owner/name         the guesses for that GitHub repository
 *   &q=…                     text in the search field (it comes back after "Connect GitHub")
 */
export function draftFromLink(params: URLSearchParams, prev: NewProjectDraft): NewProjectDraft {
  const kind = params.get("new");
  const q = params.get("q");
  const repo = githubRepoName(params.get("repo") ?? "");
  const url = params.get("url");
  const query = q ?? prev.query;
  if (repo) return { ...EMPTY_DRAFT, query, step: { kind: "github", repo } };
  switch (kind) {
    case "push":
      return { ...EMPTY_DRAFT, query, step: { kind: "push" } };
    case "empty":
      return { ...EMPTY_DRAFT, query, step: { kind: "empty" } };
    case "template":
      return { ...EMPTY_DRAFT, query, step: { kind: "template" } };
    case "describe": {
      const text = (params.get("text") ?? "").trim();
      return text ? { ...EMPTY_DRAFT, query, description: text, step: { kind: "describe", text } } : { ...EMPTY_DRAFT, query };
    }
    case "upload":
    case "folder":
      return { ...EMPTY_DRAFT, query, step: { kind: "upload" } };
    case "git":
      // Without a URL: the URL step with an empty field ("Import from a git URL").
      return { ...EMPTY_DRAFT, query, step: { kind: "git", url: url ?? "" } };
    default:
      return q !== null ? { ...prev, query: q, step: { kind: "list" } } : prev;
  }
}

/** The query params that belong to the picker (the page removes them when the picker closes). */
export const LINK_PARAMS = ["new", "q", "repo", "url", "text"] as const;

/** At most this much of a description goes into a link (the sign-in carries the link). */
const LINK_TEXT_MAX = 1000;

/**
 * The link of a step, for the way back after a sign-in: draftFromLink opens the picker at the same step.
 * The step replaces a "new" of `returnTo` ("/projects?new=1"): a second "new" would not count. A
 * description goes with it (at most LINK_TEXT_MAX characters). A folder does not: the person picks it again.
 */
export function linkOfStep(step: SourceStep, returnTo: string, form: Partial<FormValues> = {}): string {
  if (step.kind === "list") return returnTo;
  const u = new URL(returnTo, "https://gitring.invalid");
  if (step.kind === "github") {
    u.searchParams.set("repo", step.repo);
  } else {
    u.searchParams.set("new", step.kind);
    if (step.kind === "git") u.searchParams.set("url", step.url);
    if (step.kind === "describe") u.searchParams.set("text", (form.description ?? step.text).slice(0, LINK_TEXT_MAX));
  }
  return `${u.pathname}${u.search}${u.hash}`;
}
