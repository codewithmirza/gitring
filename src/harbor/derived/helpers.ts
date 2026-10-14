/**
 * Small pure helpers of the derived data: line counts, paths, limits and a parallel map with a bound.
 * Imported by the other files of this folder. Never read the database from here.
 */
import type { TreeEntry } from "../../platform/repo/backend";

/** Lines of a text: "a\nb\n" and "a\nb" have 2, "" has 0 (the line model of src/core/text/diff.ts). */
export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}

export function linesOf(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function normPath(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

export const clamp = (n: number | undefined, lo: number, hi: number, dflt: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n!))) : dflt);
export const firstLine = (message: string): string => (message ?? "").split("\n")[0].trim() || "no message";
export const isBlob = (e: TreeEntry | undefined): e is TreeEntry => !!e && (e.type === "blob" || e.type === "exec");

/** Run `fn` over `items` with at most `limit` calls in flight. Results keep the order of `items`. */
export async function mapLimit<X, Y>(items: readonly X[], limit: number, fn: (x: X) => Promise<Y>): Promise<Y[]> {
  const out = new Array<Y>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}
