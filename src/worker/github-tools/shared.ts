/**
 * Shared parts of the GitHub-compatible tools: argument schemas, answer helpers, paging and small formatters.
 *
 * No tool is defined here. Read next: src/worker/github-tools/README.md (how the tools map onto gitring).
 */
import { z } from "zod";
import type * as T from "../../core/types";
import { newsFor, text, type ToolContext, type ToolResult } from "../mcp-kit";
import type { Project } from "./branches";

// ───── Argument schemas ─────

export const owner = z.string().optional().describe("gitring ignores owner.");
export const repo = z.string().describe("The gitring project id. get_me lists your projects.");
export const page = z.number().int().optional().describe("Page number, from 1.");
export const perPage = z.number().int().optional().describe("Items per page (30 if you leave it out, 100 at most).");

// ───── Answers ─────

export const github = { github: true } as const;
export const data = (obj: unknown, headline: string, clr?: T.Clearance): ToolResult => text(obj, headline, clr, github);

/** The new change requests of a branch of the caller, for the answer of a read (none for main or a commit). */
export async function newsOf(ctx: ToolContext, h: Project, attemptId: string | undefined): Promise<T.Clearance | undefined> {
  if (!attemptId) return undefined;
  return (await newsFor(ctx, h, attemptId)) ?? undefined;
}

// ───── Small helpers ─────

export const byAge = <A extends { createdAt: number }>(xs: readonly A[]): A[] => [...xs].sort((a, b) => a.createdAt - b.createdAt);

export const sha7 = (s: string | undefined): string => String(s ?? "").slice(0, 7);

export const iso = (ms: number): string => new Date(ms).toISOString();

export function page_<A>(items: A[], pageNo?: number, size?: number): A[] {
  const n = Math.min(100, Math.max(1, Math.floor(size ?? 30)));
  const p = Math.max(1, Math.floor(pageNo ?? 1));
  return items.slice((p - 1) * n, p * n);
}

/** The entries of one folder, from the flat list of files. */
export function entriesOf(files: T.FileNode[], dir: string): { type: "file" | "dir"; name: string; path: string; size: number }[] {
  const prefix = dir ? `${dir}/` : "";
  const out = new Map<string, { type: "file" | "dir"; name: string; path: string; size: number }>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) out.set(rest, { type: "file", name: rest, path: f.path, size: f.size });
    else if (!out.has(rest.slice(0, slash))) out.set(rest.slice(0, slash), { type: "dir", name: rest.slice(0, slash), path: prefix + rest.slice(0, slash), size: 0 });
  }
  return [...out.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}
