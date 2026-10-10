/**
 * The draft of a new project. The page that shows the picker keeps it, so a closed panel keeps what the
 * person typed and chose, and a link (?new=…) can open the picker at one source.
 */
import type { GithubRepo, Visibility } from "../../../../src/core/accounts";
import type { GithubSyncMode } from "../../../../src/core/types";
import { githubRepoName } from "../../../../src/core/repo-rules";

export type SourceStep =
  | { kind: "list" }
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
}

export interface NewProjectDraft {
  query: string;
  step: SourceStep;
  /** Values the person changed. A value that is not here comes from gitring's guess. */
  form: Partial<FormValues>;
  /** The folder the person picked (upload). */
  upload: { files: File[]; folder: string } | null;
}

export const EMPTY_DRAFT: NewProjectDraft = { query: "", step: { kind: "list" }, form: {}, upload: null };

/**
 * The draft that a link asks for:
 *   ?new=1 (or github)       the source list (a draft of an earlier opening stays)
 *   ?new=upload|push|empty   that source
 *   ?new=git&url=…           a public git URL
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
    case "upload":
    case "folder":
      return { ...EMPTY_DRAFT, query, step: { kind: "upload" } };
    case "git":
      return url ? { ...EMPTY_DRAFT, query, step: { kind: "git", url } } : { ...EMPTY_DRAFT, query };
    default:
      return q !== null ? { ...prev, query: q, step: { kind: "list" } } : prev;
  }
}

/** The query params that belong to the picker (the page removes them when the picker closes). */
export const LINK_PARAMS = ["new", "q", "repo", "url"] as const;
