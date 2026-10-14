/**
 * The words of a project card: the live fact that leads it, the facts under it and the source line at its end.
 * ProjectCard.tsx calls this module. It is pure, so a unit test keeps the words plain (ASD-STE100).
 * It never invents a fact: the live fact comes from the inbox that the browser already holds.
 */
import type { ProjectInfo } from "../../../../src/core/accounts";
import { TEMPLATES } from "../../../../src/core/templates";
import type { InboxItem } from "../../state/inbox";
import { ago } from "../../state/format";

/** The questions that wait, by project id. Null until the inbox has answered once. */
export function waitingByProject(items: InboxItem[] | null): Map<string, InboxItem[]> | null {
  if (!items) return null;
  const byProject = new Map<string, InboxItem[]>();
  for (const item of items) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item]);
  return byProject;
}

/** The live fact of a project with a waiting question: "1 question waits", "2 questions wait". */
export function waitsText(count: number): string {
  return count === 1 ? "1 question waits" : `${count} questions wait`;
}

/** The live fact of a quiet project. Only the person who may answer questions in it can read it. */
export const NOTHING_WAITS = "Nothing waits for you.";

/** True when the inbox would list a question of this project: the person is an owner or a member. */
export function canAnswerHere(p: Pick<ProjectInfo, "role">): boolean {
  return p.role === "owner" || p.role === "member";
}

/**
 * The facts under the live fact, one short phrase each. The page shows them as separate words, not as one string.
 * An owner sees no role: the heading "Your projects" says it already, and a lock says "Private".
 */
export function cardFacts(p: ProjectInfo, isOpen: boolean, now: number = Date.now()): string[] {
  const facts: string[] = [];
  if (isOpen) facts.push("Open now");
  if (p.visibility === "public") facts.push("Public");
  if (p.role === "member") facts.push("You are a member");
  else if (p.role !== "owner") facts.push("You can view it");
  if (p.role !== "owner" && p.ownerName) facts.push(`Owner: ${p.ownerName}`);
  if (p.createdAt) facts.push(`Created ${ago(p.createdAt, now)}`);
  return facts;
}

/** Where the project came from, as one plain phrase. It goes last on the card. */
export function sourceLine(p: ProjectInfo): string {
  const s = p.source;
  switch (s.kind) {
    case "github":
      return s.branch ? `${s.repo}, branch ${s.branch}` : s.repo;
    case "git":
      return `Imported from ${s.url.replace(/^https:\/\//, "")}${s.branch ? `, branch ${s.branch}` : ""}`;
    case "empty":
      return "Started empty";
    case "upload":
      return `Uploaded folder with ${s.files} ${s.files === 1 ? "file" : "files"}`;
    case "push":
      return "Pushed with git";
    case "template":
      return `From the ${TEMPLATES.find((t) => t.id === s.template)?.title ?? s.template} template`;
    default:
      return "Project";
  }
}
