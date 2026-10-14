/**
 * The words of the first view of a new project (StartList and the describe step). Pure, so a unit test
 * keeps them plain (ASD-STE100) and GitHub in its place: one import among others, never the first.
 */
import type { IconName } from "../../design/icons";

export type StartKind = "template" | "empty" | "upload" | "push" | "git";

/** The sources in their order on the page. "Your GitHub repositories" follows them. */
export const SOURCES: { kind: StartKind; icon: IconName; title: string; text: string }[] = [
  { kind: "template", icon: "grid", title: "Template", text: "Starter code with tests: a library, a Worker API or a static site." },
  { kind: "empty", icon: "plus", title: "Empty project", text: "A README and an AGENTS.md. Agents write the first files." },
  { kind: "upload", icon: "launch", title: "Upload a folder", text: "Files from your computer, without the git history. At most 20 MB." },
  { kind: "push", icon: "fork", title: "Push with git", text: "Any repository from any host, with its history. Private ones too." },
  { kind: "git", icon: "external", title: "Import from a git URL", text: "A public repository on any host: GitLab, Codeberg, GitHub and others." },
];

export const DESCRIBE_LABEL = "Describe what you want to build";
export const DESCRIBE_HINT = "gitring picks a template, writes the first task and starts an agent. You can change each choice.";
export const NEW_PROJECT_LEDE = "Describe it, start from a template, or bring your code. Agents start at once.";
export const CONNECT_GITHUB_NOTE = "to import your repositories. It is optional.";

/** What the agent count of the describe step does. */
export function agentsHint(n: number): string {
  if (n === 0) return "No agent starts. You or your own agents take the first task.";
  return n === 1 ? "1 built-in agent starts on the first task at once." : `${n} built-in agents start on the first task at once. A person chooses the best work.`;
}
