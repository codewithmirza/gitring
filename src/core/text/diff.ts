/**
 * Line diffs for footprints (base hunks) and for display (git-style unified diffs).
 *
 * Pure module (jsdiff only): runs in Node and in workerd.
 *
 * Line model, shared by every function here:
 *   - CRLF is normalized to LF first, so a file that only switches line endings is not a whole-file
 *     change. A lone CR is an ordinary character (as in git).
 *   - Lines are split on "\n". A final line without "\n" is still a line. "a\n" and "a" differ only
 *     by that final-newline flag, so only the last line is reported as changed (like git: -1 +1).
 *   - Line numbers are 1-based. `LineRange` is inclusive.
 */
import { diffLines } from "diff";
import type { LineRange } from "../types";

export interface LineDiff {
  /**
   * BASE line ranges (1-based, inclusive) that the change replaces or deletes, in order.
   *
   * Pure insertion convention: text inserted between base lines n and n+1 is reported as `[n, n]`,
   * where n is the base line AFTER which the text goes. `[0, 0]` means "inserted at the top of the
   * file" (also used for any non-empty added file, whose base is empty). So `[n, n]` is either
   * "line n replaced" or "insertion after line n"; both touch line n's edges, which is what a
   * collision check needs. Use `diffHunks` when the difference matters.
   */
  hunks: LineRange[];
  /** Added lines (git numstat semantics). */
  additions: number;
  /** Deleted lines (git numstat semantics). */
  deletions: number;
  /** NEW-text line ranges (1-based, inclusive) that were added or changed. Empty for pure deletions. */
  changedNewLines: LineRange[];
}

/**
 * One change block (unified-diff numbering, context 0): `oldLines` base lines starting at
 * `oldStart` are replaced by `newLines` new lines starting at `newStart`.
 * When `oldLines` is 0 (pure insertion), `oldStart` is the base line after which the text goes
 * (0 = top). When `newLines` is 0 (pure deletion), `newStart` is the new line after which the
 * base lines were removed (0 = top).
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** Internal change block with 0-based indices: old[o, o+oc) is replaced by new[n, n+nc). */
interface Change {
  o: number;
  oc: number;
  n: number;
  nc: number;
}

/**
 * Myers work budget. jsdiff costs about O((N + M) · D) for D edits; above the budget the middle
 * region (after trimming the common prefix and suffix) is reported as one replacement block.
 * Deterministic (no timeouts), so the same input always gives the same hunks.
 */
const WORK_BUDGET = 30_000_000;
const MIN_EDIT_BUDGET = 256;

/** CRLF → LF. */
export function normalizeNewlines(text: string): string {
  return text.indexOf("\r\n") === -1 ? text : text.replace(/\r\n/g, "\n");
}

/** Split normalized text into lines that keep their "\n" (the last one may lack it). "" → []. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts[i] + "\n");
  const last = parts[parts.length - 1];
  if (last !== "") out.push(last);
  return out;
}

function computeChanges(a: string[], b: string[]): Change[] {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const oldMid = a.length - p - s;
  const newMid = b.length - p - s;
  if (oldMid === 0 && newMid === 0) return [];
  if (oldMid === 0 || newMid === 0) return [{ o: p, oc: oldMid, n: p, nc: newMid }];

  const budget = Math.max(MIN_EDIT_BUDGET, Math.floor(WORK_BUDGET / (oldMid + newMid)));
  const parts = diffLines(a.slice(p, a.length - s).join(""), b.slice(p, b.length - s).join(""), {
    maxEditLength: budget,
  });
  if (!parts) return [{ o: p, oc: oldMid, n: p, nc: newMid }];

  const out: Change[] = [];
  let o = p;
  let n = p;
  let cur: Change | null = null;
  for (const part of parts) {
    const count = part.count;
    if (!part.added && !part.removed) {
      if (cur) {
        out.push(cur);
        cur = null;
      }
      o += count;
      n += count;
      continue;
    }
    if (!cur) cur = { o, oc: 0, n, nc: 0 };
    if (part.removed) {
      cur.oc += count;
      o += count;
    } else {
      cur.nc += count;
      n += count;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function changesOf(oldText: string, newText: string): { a: string[]; b: string[]; changes: Change[] } {
  const oldN = normalizeNewlines(oldText);
  const newN = normalizeNewlines(newText);
  const a = splitLines(oldN);
  const b = splitLines(newN);
  return { a, b, changes: oldN === newN ? [] : computeChanges(a, b) };
}

/** Change blocks between two texts (context 0), in order. See `DiffHunk` for the numbering. */
export function diffHunks(oldText: string, newText: string): DiffHunk[] {
  return changesOf(oldText, newText).changes.map((c) => ({
    oldStart: c.oc > 0 ? c.o + 1 : c.o,
    oldLines: c.oc,
    newStart: c.nc > 0 ? c.n + 1 : c.n,
    newLines: c.nc,
  }));
}

/**
 * Line diff of two texts: base hunks, added/deleted line counts, and the changed lines of the new
 * text. Identical texts (after CRLF normalization) give empty hunks and zero counts.
 *
 * @example lineDiff("a\nb\nc\n", "a\nB\nc\n")  // hunks [[2, 2]], changedNewLines [[2, 2]], +1 -1
 * @example lineDiff("a\nb\n", "a\nx\nb\n")      // pure insertion after line 1: hunks [[1, 1]], +1 -0
 * @example lineDiff("a\n", "x\na\n")            // insertion at the top: hunks [[0, 0]]
 */
export function lineDiff(oldText: string, newText: string): LineDiff {
  const { changes } = changesOf(oldText, newText);
  const hunks: LineRange[] = [];
  const changedNewLines: LineRange[] = [];
  let additions = 0;
  let deletions = 0;
  for (const c of changes) {
    hunks.push(c.oc > 0 ? [c.o + 1, c.o + c.oc] : [c.o, c.o]);
    if (c.nc > 0) changedNewLines.push([c.n + 1, c.n + c.nc]);
    additions += c.nc;
    deletions += c.oc;
  }
  return { hunks, additions, deletions, changedNewLines };
}

/** "start,count" for a unified hunk header (git style: ",1" omitted; count 0 → start is the line before). */
function hunkSpan(start0: number, count: number): string {
  const start = count === 0 ? start0 : start0 + 1;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function pushLine(out: string[], prefix: string, line: string): void {
  if (line.endsWith("\n")) out.push(prefix + line.slice(0, -1));
  else {
    out.push(prefix + line);
    out.push("\\ No newline at end of file");
  }
}

/**
 * Git-style unified diff of one file:
 *
 *     --- a/src/products.js        (--- /dev/null when the file is added)
 *     +++ b/src/products.js        (+++ /dev/null when the file is deleted)
 *     @@ -7,3 +7,3 @@
 *
 * Hunk headers follow git (",1" omitted, "-0,0" for an empty side). Hunks closer than
 * 2 × `context` lines are joined. Returns "" when nothing changed (both sides equal, or both null).
 * An added or deleted empty file gives the two header lines only. Line endings are normalized
 * (see the module comment), so the output always uses LF.
 */
export function unifiedDiff(path: string, oldText: string | null, newText: string | null, context = 3): string {
  if (oldText === null && newText === null) return "";
  const { a, b, changes } = changesOf(oldText ?? "", newText ?? "");
  const header = [oldText === null ? "--- /dev/null" : `--- a/${path}`, newText === null ? "+++ /dev/null" : `+++ b/${path}`];
  if (changes.length === 0) return oldText !== null && newText !== null ? "" : header.join("\n") + "\n";

  const ctx = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : 3;
  const out = header;
  let i = 0;
  while (i < changes.length) {
    let j = i;
    while (j + 1 < changes.length && changes[j + 1].o - (changes[j].o + changes[j].oc) <= 2 * ctx) j++;
    const first = changes[i];
    const last = changes[j];
    const oStart = Math.max(0, first.o - ctx);
    const oEnd = Math.min(a.length, last.o + last.oc + ctx);
    const nStart = oStart + (first.n - first.o);
    const nEnd = oEnd + (last.n + last.nc - (last.o + last.oc));
    out.push(`@@ -${hunkSpan(oStart, oEnd - oStart)} +${hunkSpan(nStart, nEnd - nStart)} @@`);
    let o = oStart;
    for (let k = i; k <= j; k++) {
      const c = changes[k];
      for (; o < c.o; o++) pushLine(out, " ", a[o]);
      for (let x = 0; x < c.oc; x++) pushLine(out, "-", a[c.o + x]);
      for (let x = 0; x < c.nc; x++) pushLine(out, "+", b[c.n + x]);
      o = c.o + c.oc;
    }
    for (; o < oEnd; o++) pushLine(out, " ", a[o]);
    i = j + 1;
  }
  return out.join("\n") + "\n";
}

/**
 * Inclusive range overlap with `slack` lines of tolerance: [1, 3] and [5, 6] overlap with slack ≥ 2.
 * Reversed ranges are normalized first.
 */
export function rangesOverlap(a: LineRange, b: LineRange, slack = 0): boolean {
  const a0 = Math.min(a[0], a[1]);
  const a1 = Math.max(a[0], a[1]);
  const b0 = Math.min(b[0], b[1]);
  const b1 = Math.max(b[0], b[1]);
  return a0 <= b1 + slack && b0 <= a1 + slack;
}

/** Bytes inspected by `isProbablyText` (git uses the same window for its NUL check). */
const TEXT_SNIFF_BYTES = 8000;

/**
 * Heuristic text check: no NUL byte in the first 8000 bytes, and at most 10% of those bytes are
 * suspicious (invalid UTF-8 sequences or C0 control characters other than tab, LF, VT, FF, CR,
 * backspace and ESC). Latin-1 text with a few accents still counts as text. Empty input is text.
 */
export function isProbablyText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, TEXT_SNIFF_BYTES);
  let bad = 0;
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (c === 0) return false;
    if (c < 0x80) {
      if (c < 0x20 && !(c >= 8 && c <= 13) && c !== 27) bad++;
      i++;
      continue;
    }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c === 0xe0) {
      need = 2;
      lo = 0xa0;
    } else if (c >= 0xe1 && c <= 0xec) need = 2;
    else if (c === 0xed) {
      need = 2;
      hi = 0x9f;
    } else if (c === 0xee || c === 0xef) need = 2;
    else if (c === 0xf0) {
      need = 3;
      lo = 0x90;
    } else if (c >= 0xf1 && c <= 0xf3) need = 3;
    else if (c === 0xf4) {
      need = 3;
      hi = 0x8f;
    } else {
      bad++;
      i++;
      continue;
    }
    let ok = true;
    for (let k = 1; k <= need; k++) {
      if (i + k >= n) {
        // Cut by the sniff window: fine. Cut by the end of the data: a truncated sequence.
        if (i + k >= bytes.length) ok = false;
        break;
      }
      const d = bytes[i + k];
      if (d < (k === 1 ? lo : 0x80) || d > (k === 1 ? hi : 0xbf)) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      bad++;
      i++;
      continue;
    }
    i += need + 1;
  }
  return bad * 10 <= n;
}
