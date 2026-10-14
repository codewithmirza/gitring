/**
 * Rules by folder: who says yes to a change in a folder, and which agents may change it at all.
 *
 * Pure functions. The rule type `FolderRule` is in `types/settings.ts`. Owners set the rules in Settings.
 */

/*
 * Rules by folder: who says yes to a change in a folder (ProjectSettings.folderRules).
 *
 *   owner-yes  a change there needs the yes of an owner
 *   no-yes     a change there needs no yes (a person still chooses between competing work copies)
 *   members    only the agents of these people may change it; another agent's plan is refused, and
 *              work that changed it anyway needs the yes of an owner
 *
 * A pattern is a path pattern: `**` matches any folders, `*` one name part, `?` one character. A pattern
 * with no "/" matches a name at any depth (`*.sql`, `migrations`); a pattern with a "/" matches the whole
 * path from the root (`migrations/**`, `docs/*.md`). A pattern that ends in "/" means the folder and all
 * that is in it.
 *
 * These functions are pure: the project object checks the files of a plan (declare) and the changed files
 * of the work (submit) with them, and the web app shows the same words. Words are plain (ASD-STE100).
 */

import type { FolderRule, Person } from "../types";

export const MAX_FOLDER_RULES = 50;
export const MAX_PATTERN = 200;
export const MAX_RULE_MEMBERS = 50;

/** One piece of a compiled pattern. */
type Token = { t: "lit"; c: string } | { t: "one" } | { t: "star" } | { t: "any" } | { t: "dirs" };

interface Compiled {
  tokens: Token[];
  /** A name pattern (no "/") matches at any depth. */
  anyDepth: boolean;
}

const cache = new Map<string, Compiled | null>();

/** The pieces of a pattern (cached), or null for an empty pattern. */
function compile(pattern: string): Compiled | null {
  const hit = cache.get(pattern);
  if (hit !== undefined) return hit;
  let p = pattern.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
  if (p.endsWith("/")) p += "**";
  let out: Compiled | null = null;
  if (p) {
    const tokens: Token[] = [];
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*") {
        if (p[i + 1] === "*") {
          // `**/` matches zero or more folders; `**` at the end matches the rest.
          const slash = p[i + 2] === "/";
          const last = tokens[tokens.length - 1];
          // Two of the same kind in a row match the same paths as one.
          if (!(last && last.t === (slash ? "dirs" : "any"))) tokens.push({ t: slash ? "dirs" : "any" });
          i += slash ? 2 : 1;
        } else if (tokens[tokens.length - 1]?.t !== "star") tokens.push({ t: "star" });
      } else if (c === "?") tokens.push({ t: "one" });
      else tokens.push({ t: "lit", c });
    }
    // A name pattern (no "/") matches at any depth; a folder name also matches all that is in it.
    out = { tokens, anyDepth: !p.includes("/") };
  }
  if (cache.size > 500) cache.clear();
  cache.set(pattern, out);
  return out;
}

/**
 * Match without backtracking: for each piece, the set of places in the path where the match can be. The
 * work is (pieces x path length), so a hostile pattern with many `**` cannot make it slow.
 */
function run(m: Compiled, path: string): boolean {
  const n = path.length;
  let cur = new Uint8Array(n + 1);
  for (let i = 0; i <= n; i++) cur[i] = !m.anyDepth ? (i === 0 ? 1 : 0) : i === 0 || path[i - 1] === "/" ? 1 : 0;
  for (const tok of m.tokens) {
    const next = new Uint8Array(n + 1);
    let live = false; // a place in the set at or before this one
    let liveInName = false; // the same, with no "/" between it and this place
    let any = false;
    for (let j = 0; j <= n; j++) {
      const ch = j > 0 ? path[j - 1] : "";
      if (tok.t === "lit") {
        if (j > 0 && cur[j - 1] && ch === tok.c) next[j] = 1;
      } else if (tok.t === "one") {
        if (j > 0 && cur[j - 1] && ch !== "/") next[j] = 1;
      } else if (tok.t === "star") {
        if (j > 0 && ch === "/") liveInName = false;
        if (cur[j]) liveInName = true;
        if (liveInName) next[j] = 1;
      } else if (tok.t === "any") {
        if (cur[j]) live = true;
        if (live) next[j] = 1;
      } else {
        // `**/`: nothing, or any text that ends in "/".
        if (cur[j]) next[j] = 1;
        if (j > 0 && ch === "/" && any) next[j] = 1;
        if (cur[j]) any = true;
      }
    }
    cur = next;
  }
  if (!m.anyDepth) return cur[n] === 1;
  for (let j = 0; j <= n; j++) if (cur[j] && (j === n || path[j] === "/")) return true;
  return false;
}

/** Does the pattern match the path? */
export function matchesPattern(pattern: string, path: string): boolean {
  const m = compile(pattern);
  return m ? run(m, path.replace(/\\/g, "/").replace(/^\.?\/+/, "")) : false;
}

/** The rules that a path falls under, in their order. */
export function rulesFor(rules: readonly FolderRule[], path: string): FolderRule[] {
  return rules.filter((r) => matchesPattern(r.pattern, path));
}

/** Keep a list of rules inside safe bounds (any owner or client can send a settings patch). */
export function sanitizeFolderRules(raw: unknown): FolderRule[] {
  if (!Array.isArray(raw)) return [];
  const out: FolderRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const pattern = typeof r.pattern === "string" ? r.pattern.trim().replace(/\s+/g, "").slice(0, MAX_PATTERN) : "";
    if (!pattern || !compile(pattern)) continue;
    if (r.rule === "owner-yes" || r.rule === "no-yes") out.push({ pattern, rule: r.rule });
    else if (r.rule === "members") {
      const members: Person[] = [];
      const seen = new Set<string>();
      for (const m of Array.isArray(r.members) ? r.members : []) {
        const id = typeof m?.id === "string" ? m.id.trim().slice(0, 80) : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        members.push({ id, name: (typeof m.name === "string" && m.name.trim() ? m.name.trim() : id).slice(0, 80) });
      }
      out.push({ pattern, rule: "members", members: members.slice(0, MAX_RULE_MEMBERS) });
    }
    if (out.length >= MAX_FOLDER_RULES) break;
  }
  return out;
}

/** "a, b, c" for up to three names, then "and N more". */
function listOf(items: string[], max = 3): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** "Robin", "Robin and Sam", "Robin, Sam and Kim". */
function namesOf(people: Person[]): string {
  const names = people.map((p) => p.name);
  if (names.length <= 1) return names[0] ?? "nobody";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What the rules say about a set of paths. */
export interface RuleVerdict {
  /** Rules that need the yes of an owner, with the paths they match. */
  ownerYes: { pattern: string; paths: string[] }[];
  /** Rules that name who may change the paths, and the sender is not one of them. */
  notAllowed: { pattern: string; paths: string[]; members: Person[] }[];
  /** Every path is under a "no yes needed" rule, and no other rule holds one of them. */
  noYes: boolean;
  /** The rules apply to nothing: no path falls under a rule. */
  none: boolean;
}

/**
 * Check the paths of a plan or of the work against the rules. `senderId` is the person who sent the agent
 * (absent: no person did, so a "members" rule does not allow the change).
 */
export function checkFolderRules(rules: readonly FolderRule[], paths: readonly string[], senderId?: string): RuleVerdict {
  const ownerYes = new Map<string, string[]>();
  const notAllowed = new Map<string, { paths: string[]; members: Person[] }>();
  const held = new Set<string>();
  let covered = 0;
  for (const path of new Set(paths)) {
    let noYes = false;
    for (const r of rulesFor(rules, path)) {
      if (r.rule === "owner-yes") {
        held.add(path);
        (ownerYes.get(r.pattern) ?? ownerYes.set(r.pattern, []).get(r.pattern)!).push(path);
      } else if (r.rule === "members") {
        if (senderId && r.members.some((m) => m.id === senderId)) continue;
        held.add(path);
        const slot = notAllowed.get(r.pattern) ?? notAllowed.set(r.pattern, { paths: [], members: r.members }).get(r.pattern)!;
        slot.paths.push(path);
      } else noYes = true;
    }
    if (noYes) covered += 1;
  }
  const unique = new Set(paths).size;
  return {
    ownerYes: [...ownerYes].map(([pattern, p]) => ({ pattern, paths: p })),
    notAllowed: [...notAllowed].map(([pattern, v]) => ({ pattern, ...v })),
    noYes: unique > 0 && covered === unique && held.size === 0,
    none: ownerYes.size === 0 && notAllowed.size === 0 && covered === 0,
  };
}

/** Plain sentences about the rules that hold the work, for the reasons of an approval. */
export function ruleReasons(v: RuleVerdict): string[] {
  const out: string[] = [];
  for (const r of v.ownerYes) out.push(`A rule by folder: a change in ${r.pattern} needs the yes of an owner. Files: ${listOf(r.paths)}.`);
  for (const r of v.notAllowed) out.push(`A rule by folder: only the agents of ${namesOf(r.members)} may change ${r.pattern}. An owner must say yes to this work. Files: ${listOf(r.paths)}.`);
  return out;
}

/** Plain sentences for the agent that sends a plan: what the rules say about the files of the plan. */
export function planNotes(v: RuleVerdict): string[] {
  const out: string[] = [];
  for (const r of v.ownerYes) out.push(`This plan touches ${r.pattern}: a change there needs the yes of an owner.`);
  if (v.noYes) out.push("Every file of this plan is under a rule that needs no yes of a person.");
  return out;
}

/** The plain reason why a plan is refused: the sender may not change these files. Null when the plan may go on. */
export function planRefusal(v: RuleVerdict): string | null {
  if (!v.notAllowed.length) return null;
  const r = v.notAllowed[0];
  return `This plan touches ${r.pattern}. Only the agents of ${namesOf(r.members)} may change it. Change the plan, or ask an owner of the project.`;
}
