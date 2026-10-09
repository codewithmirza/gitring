/**
 * Patch kit for the mock harbor: parse the demo patches, apply them to a working tree,
 * and compute real line diffs, unified diffs and footprints. Pure functions; no DOM.
 *
 * Patch format (one file per attempt):
 *   ### path          modify a file; then blocks:  <<<  find  ===  replace  >>>
 *                     an empty find appends the replacement at the end of the file
 *   ### +path         create a file; the content runs to the next "### " line
 */
import type { FileTouch, Footprint, LineRange, SymbolKey } from "../../../src/core/types";

export interface FileEdit {
  find: string;
  replace: string;
}

export interface PatchFile {
  path: string;
  create?: string;
  edits: FileEdit[];
}

export type Tree = Map<string, string>;

export function parsePatch(text: string): PatchFile[] {
  const out: PatchFile[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cur: PatchFile | null = null;
  let mode: "none" | "find" | "replace" | "create" = "none";
  let find: string[] = [];
  let repl: string[] = [];
  let create: string[] = [];
  const flushCreate = () => {
    if (cur && mode === "create") {
      while (create.length && create[create.length - 1] === "") create.pop();
      cur.create = create.join("\n") + "\n";
    }
  };
  for (const line of lines) {
    if (line.startsWith("### ")) {
      flushCreate();
      const spec = line.slice(4).trim();
      const isCreate = spec.startsWith("+");
      cur = { path: isCreate ? spec.slice(1) : spec, edits: [] };
      out.push(cur);
      mode = isCreate ? "create" : "none";
      create = [];
      continue;
    }
    if (!cur) continue;
    if (mode === "create") {
      create.push(line);
      continue;
    }
    if (line === "<<<") {
      mode = "find";
      find = [];
      repl = [];
      continue;
    }
    if (line === "===" && mode === "find") {
      mode = "replace";
      continue;
    }
    if (line === ">>>" && mode === "replace") {
      cur.edits.push({ find: find.join("\n"), replace: repl.join("\n") });
      mode = "none";
      continue;
    }
    if (mode === "find") find.push(line);
    else if (mode === "replace") repl.push(line);
  }
  flushCreate();
  return out;
}

export interface ApplyResult {
  ok: boolean;
  content: string;
  /** Edits whose find text is not in the file (a conflict on the new base). */
  conflicts: FileEdit[];
}

export function applyEdits(content: string, edits: FileEdit[]): ApplyResult {
  let next = content;
  const conflicts: FileEdit[] = [];
  for (const e of edits) {
    if (e.find === "") {
      next = next.replace(/\n*$/, "") + "\n" + e.replace + "\n";
      continue;
    }
    const i = next.indexOf(e.find);
    if (i === -1) {
      conflicts.push(e);
      continue;
    }
    next = next.slice(0, i) + e.replace + next.slice(i + e.find.length);
  }
  return { ok: conflicts.length === 0, content: next, conflicts };
}

/** Apply one patch file to a tree (in place). Returns false on conflict. */
export function applyPatchFile(tree: Tree, pf: PatchFile): ApplyResult {
  if (pf.create !== undefined) {
    tree.set(pf.path, pf.create);
    return { ok: true, content: pf.create, conflicts: [] };
  }
  const base = tree.get(pf.path) ?? "";
  const r = applyEdits(base, pf.edits);
  if (r.ok) tree.set(pf.path, r.content);
  return r;
}

/* ───────────── line diff ───────────── */

type Op = { t: "=" | "-" | "+"; line: string; a: number; b: number };

function splitLines(s: string): string[] {
  if (s === "") return [];
  const l = s.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

export function diffLines(oldText: string, newText: string): Op[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  // LCS table (files here are small).
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "=", line: a[i], a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", line: a[i], a: i + 1, b: j });
      i++;
    } else {
      ops.push({ t: "+", line: b[j], a: i, b: j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i], a: ++i, b: j });
  while (j < m) ops.push({ t: "+", line: b[j], a: i, b: ++j });
  return ops;
}

export interface LineStats {
  additions: number;
  deletions: number;
  /** Base line ranges replaced or deleted; [n, n] for a pure insertion after base line n. */
  hunks: LineRange[];
}

export function lineStats(oldText: string, newText: string): LineStats {
  const ops = diffLines(oldText, newText);
  let additions = 0;
  let deletions = 0;
  const hunks: LineRange[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === "=") {
      k++;
      continue;
    }
    let start = Infinity;
    let end = -Infinity;
    let anchor = ops[k].a;
    while (k < ops.length && ops[k].t !== "=") {
      const o = ops[k];
      if (o.t === "-") {
        deletions++;
        start = Math.min(start, o.a);
        end = Math.max(end, o.a);
      } else {
        additions++;
        anchor = o.a;
      }
      k++;
    }
    hunks.push(Number.isFinite(start) ? [start, end] : [anchor, anchor]);
  }
  return { additions, deletions, hunks };
}

export function unifiedDiff(path: string, oldText: string | null, newText: string | null, context = 3): string {
  const ops = diffLines(oldText ?? "", newText ?? "");
  const head = [
    `diff --git a/${path} b/${path}`,
    oldText === null ? "new file mode 100644" : newText === null ? "deleted file mode 100644" : null,
    `--- ${oldText === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${newText === null ? "/dev/null" : `b/${path}`}`,
  ].filter(Boolean) as string[];
  const changed = ops.map((o, i) => (o.t !== "=" ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return head.join("\n") + "\n";
  // Group changes into hunks with context.
  const groups: [number, number][] = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(ops.length - 1, i + context);
    const last = groups[groups.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else groups.push([lo, hi]);
  }
  const body: string[] = [];
  for (const [lo, hi] of groups) {
    const slice = ops.slice(lo, hi + 1);
    const aLines = slice.filter((o) => o.t !== "+").length;
    const bLines = slice.filter((o) => o.t !== "-").length;
    const firstA = slice.find((o) => o.t !== "+");
    const firstB = slice.find((o) => o.t !== "-");
    const aStart = aLines ? firstA!.a : Math.max(0, slice[0].a);
    const bStart = bLines ? firstB!.b : Math.max(0, slice[0].b);
    const fn = enclosing(ops, lo);
    body.push(`@@ -${aStart},${aLines} +${bStart},${bLines} @@${fn ? " " + fn : ""}`);
    for (const o of slice) body.push((o.t === "=" ? " " : o.t) + o.line);
  }
  return [...head, ...body].join("\n") + "\n";
}

function enclosing(ops: Op[], idx: number): string | null {
  for (let i = idx - 1; i >= 0; i--) {
    const m = /^(export\s+)?(async\s+)?(function\s+\w+|const\s+\w+\s*=|class\s+\w+)/.exec(ops[i].line);
    if (m && ops[i].t !== "+") return ops[i].line.replace(/\s*\{\s*$/, "").slice(0, 60);
  }
  return null;
}

/* ───────────── symbols + footprint (heuristic, good enough for the mock) ───────────── */

const DECL = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)\s*\(([^)]*)\)|(?:const|let)\s+(\w+)\s*=)/;

interface Decl {
  name: string;
  params?: string;
  line: number;
}

function decls(text: string): Decl[] {
  return splitLines(text)
    .map((l, i) => {
      const m = DECL.exec(l);
      if (!m) return null;
      return { name: m[1] ?? m[3], params: m[2], line: i + 1 };
    })
    .filter(Boolean) as Decl[];
}

function ownerOf(list: Decl[], line: number): string | null {
  let owner: string | null = null;
  for (const d of list) if (d.line <= line) owner = d.name;
  return owner;
}

export function computeFootprint(base: Tree, head: Tree, paths: string[], now: number): Footprint {
  const files: Record<string, FileTouch> = {};
  const defined = new Set<SymbolKey>();
  const modified = new Set<SymbolKey>();
  const removed = new Set<SymbolKey>();
  const signatureChanged = new Set<SymbolKey>();
  const referenced = new Set<SymbolKey>();
  for (const path of paths) {
    const b = base.get(path) ?? null;
    const h = head.get(path) ?? null;
    if (b === h) continue;
    const st = lineStats(b ?? "", h ?? "");
    files[path] = {
      status: b === null ? "A" : h === null ? "D" : "M",
      hunks: st.hunks,
      additions: st.additions,
      deletions: st.deletions,
    };
    if (!/\.(m?js|ts)$/.test(path)) continue;
    const bd = decls(b ?? "");
    const hd = decls(h ?? "");
    const bn = new Map(bd.map((d) => [d.name, d]));
    const hn = new Map(hd.map((d) => [d.name, d]));
    for (const d of hd) if (!bn.has(d.name)) defined.add(`${path}#${d.name}`);
    for (const d of bd) if (!hn.has(d.name)) removed.add(`${path}#${d.name}`);
    for (const d of hd) {
      const old = bn.get(d.name);
      if (old && old.params !== undefined && d.params !== undefined && old.params !== d.params) {
        signatureChanged.add(`${path}#${d.name}`);
      }
    }
    for (const [lo] of st.hunks) {
      const o = ownerOf(bd, lo);
      if (o && hn.has(o)) modified.add(`${path}#${o}`);
    }
    // References: imported names used in the head text.
    for (const m of (h ?? "").matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/g)) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        referenced.add(`${dir}${m[2]}#${name}`);
      }
    }
  }
  return {
    files,
    symbols: {
      defined: [...defined],
      modified: [...modified],
      removed: [...removed],
      signatureChanged: [...signatureChanged],
      referenced: [...referenced],
    },
    computedAt: now,
  };
}

/* ───────────── repo facts ───────────── */

export function langOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    { js: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript", md: "markdown", json: "json", css: "css", html: "html" } as Record<
      string,
      string
    >
  )[ext] ?? "text";
}

export function byteSize(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function importsOf(tree: Tree): [string, string][] {
  const edges: [string, string][] = [];
  for (const [path, text] of tree) {
    if (!/\.(m?js|ts)$/.test(path)) continue;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    for (const m of text.matchAll(/(?:from\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const parts = dir ? dir.split("/") : [];
      for (const seg of m[1].split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      const target = parts.join("/");
      if (tree.has(target) && !edges.some(([a, b]) => a === path && b === target)) edges.push([path, target]);
    }
  }
  return edges;
}

/** Line range of a top-level declaration (1-based, inclusive), for correction texts. */
export function declRange(text: string, name: string): LineRange | null {
  const lines = splitLines(text);
  const start = lines.findIndex((l) => new RegExp(`^(export\\s+)?(async\\s+)?function\\s+${name}\\b`).test(l));
  if (start === -1) return null;
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      end = i;
      break;
    }
  }
  return [start + 1, end + 1];
}

/** Deterministic fake object id (40 hex). */
export function fakeSha(seed: string): string {
  let out = "";
  let h = 2166136261;
  for (let round = 0; out.length < 40; round++) {
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + round * 31;
      h = Math.imul(h, 16777619) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}
