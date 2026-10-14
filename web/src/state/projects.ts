/**
 * Creates a project from any source, and clones one with plain git.
 * The sources are a template, a description, an upload, a push, any git URL or a GitHub repository.
 */
import type { ProjectInfo, Visibility } from "../../../src/core/accounts";
import type { ProjectSettings, ProjectSource } from "../../../src/core/types";
import type { UploadFile } from "./account";
import { RequestError, send } from "./github";

export interface NewProjectInput {
  name: string;
  visibility: Visibility;
  source: ProjectSource;
  settings?: Partial<ProjectSettings>;
  files?: UploadFile[];
  /** The first task (a goal; the server makes the title from it when the title is empty). */
  firstTask?: { title?: string; goal: string };
  /** Built-in agents that start on the first task (0–4). */
  launch?: number;
}

/**
 * Create a project; the answer is the new project. The caller opens it with a full page load, which reads
 * the project list again, so no list request goes out here (it would race the page change).
 */
export async function createProjectFrom(input: NewProjectInput): Promise<ProjectInfo> {
  const res = await send<{ project: ProjectInfo }>("POST", "/api/projects", input);
  if (!res?.project?.id) throw new RequestError(0, "gitring did not send the new project. Open your projects and look for it.");
  return res.project;
}

/** A git clone command for a member: a read token for 6 hours, sent in a header (never in the URL). */
export interface CloneCommand {
  remote: string;
  branch: string;
  token: string;
  expiresAt: string;
  header: string;
  clone: string;
  pull: string;
}

export function cloneCommand(project: string): Promise<CloneCommand> {
  return send<CloneCommand>("POST", `/api/projects/${encodeURIComponent(project)}/clone-token`, {});
}
