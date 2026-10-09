/**
 * Line-based 3-way merge (diff3). ours = main, theirs = attempt.
 *
 * - A region that only one side changed takes that side; the same change on both sides is clean.
 * - Changes on both sides in one region (or on adjacent lines) conflict, as in git.
 * - On conflict, `content` holds git-style markers:
 *     <<<<<<< main
 *     (main lines)
 *     =======
 *     (attempt lines)
 *     >>>>>>> attempt
 *   Common leading/trailing lines of a conflict are moved out of it (git "zealous" merge).
 * - The final newline follows the side that changed it. CRLF stays inside lines.
 *
 * Built on node-diff3 (Khanna–Kunal–Pierce diff3 over a Hunt–McIlroy LCS). Pure.
 */
import { diff3Merge } from "node-diff3";
import type { LineRange } from "../types";

export interface Merge3Conflict {
  /** Base lines of the conflict (1-based, inclusive). An insertion point is [n, n]: after base line n (0 = top). */
  baseRange: LineRange;
  ours: string[];
  theirs: string[];
}

export interface Merge3Result {
  clean: boolean;
  content: string;
  conflicts: Merge3Conflict[];
}

export const MARKER_OURS = "<<<<<<< main";
export const MARKER_SEPARATOR = "=======";
export const MARKER_THEIRS = ">>>>>>> attempt";

interface Lines {
  lines: string[];
  eol: boolean;
}

function splitLines(text: string): Lines {
  if (text === "") return { lines: [], eol: false };
  const eol = text.endsWith("\n");
  return { lines: (eol ? text.slice(0, -1) : text).split("\n"), eol };
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** ours = main, theirs = attempt. On conflict, `content` contains git-style markers. */
export function merge3(base: string, ours: string, theirs: string): Merge3Result {
  if (ours === theirs) return { clean: true, content: ours, conflicts: [] };
  if (base === ours) return { clean: true, content: theirs, conflicts: [] };
  if (base === theirs) return { clean: true, content: ours, conflicts: [] };

  const B = splitLines(base);
  const O = splitLines(ours);
  const T = splitLines(theirs);

  // Lines common to all three at the start and the end cannot conflict: keep them out of the LCS.
  let pre = 0;
  const minLen = Math.min(B.lines.length, O.lines.length, T.lines.length);
  while (pre < minLen && B.lines[pre] === O.lines[pre] && B.lines[pre] === T.lines[pre]) pre++;
  let suf = 0;
  while (
    suf < minLen - pre &&
    B.lines[B.lines.length - 1 - suf] === O.lines[O.lines.length - 1 - suf] &&
    B.lines[B.lines.length - 1 - suf] === T.lines[T.lines.length - 1 - suf]
  )
    suf++;
  const mid = (xs: string[]) => xs.slice(pre, xs.length - suf);

  const regions = diff3Merge<string>(mid(O.lines), mid(B.lines), mid(T.lines), { excludeFalseConflicts: true });

  const out: string[] = B.lines.slice(0, pre);
  const conflicts: Merge3Conflict[] = [];
  for (const region of regions) {
    if (region.ok) {
      out.push(...region.ok);
      continue;
    }
    const cf = region.conflict;
    if (!cf) continue;
    let a = cf.a;
    let b = cf.b;
    if (sameLines(a, b)) {
      out.push(...a);
      continue;
    }
    // Zealous refinement: common leading and trailing lines of both sides are not in conflict.
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const lead = a.slice(0, head);
    const trail = a.slice(a.length - tail);
    a = a.slice(head, a.length - tail);
    b = b.slice(head, b.length - tail);
    const oStart = pre + cf.oIndex; // 0-based index in base
    const oLen = cf.o.length;
    const baseRange: LineRange = oLen > 0 ? [oStart + 1, oStart + oLen] : [oStart, oStart];
    out.push(...lead, MARKER_OURS, ...a, MARKER_SEPARATOR, ...b, MARKER_THEIRS, ...trail);
    conflicts.push({ baseRange, ours: a, theirs: b });
  }
  out.push(...B.lines.slice(B.lines.length - suf));

  // Final newline: agree → keep; else the side that changed it from base wins.
  let eol = O.eol === T.eol ? O.eol : B.eol === O.eol ? T.eol : O.eol;
  if (conflicts.length) eol = true;
  const content = out.length ? out.join("\n") + (eol ? "\n" : "") : "";
  return { clean: conflicts.length === 0, content, conflicts };
}
