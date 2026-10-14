/**
 * The file tree of the code view, without the DOM.
 * It builds folders from a flat file list, flattens the visible rows (for a virtual list), filters, and has a fuzzy file finder.
 */
import type { FileNode } from "../../../../src/core/types";

export interface DirNode {
  name: string;
  /** "" for the root. */
  path: string;
  dirs: DirNode[];
  files: FileNode[];
  /** Files in this folder and below. */
  count: number;
}

const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
export const compareNames = (a: string, b: string) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** "a/b/c.js" → ["a", "a/b"]. */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  let i = path.indexOf("/");
  while (i !== -1) {
    out.push(path.slice(0, i));
    i = path.indexOf("/", i + 1);
  }
  return out;
}

/** Folders first, then files; both in natural order ("file2" before "file10"). */
export function buildTree(files: readonly FileNode[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [], count: 0 };
  const dirs = new Map<string, DirNode>([["", root]]);
  const dirOf = (path: string): DirNode => {
    let d = dirs.get(path);
    if (d) return d;
    const parent = dirOf(dirName(path));
    d = { name: baseName(path), path, dirs: [], files: [], count: 0 };
    parent.dirs.push(d);
    dirs.set(path, d);
    return d;
  };
  for (const f of files) {
    if (!f.path || f.path.endsWith("/")) continue;
    dirOf(dirName(f.path)).files.push(f);
  }
  const finish = (d: DirNode): number => {
    d.dirs.sort((a, b) => compareNames(a.name, b.name));
    d.files.sort((a, b) => compareNames(baseName(a.path), baseName(b.path)));
    d.count = d.files.length;
    for (const c of d.dirs) d.count += finish(c);
    return d.count;
  };
  finish(root);
  return root;
}

export interface TreeRow {
  kind: "dir" | "file";
  path: string;
  name: string;
  /** 1-based (aria-level). */
  level: number;
  /** Position among its siblings that show (aria-posinset / aria-setsize). */
  posinset: number;
  setsize: number;
  parent: string;
  expanded?: boolean;
  file?: FileNode;
  /** Files below a folder (all of them, also when a filter hides some). */
  count?: number;
  /** Indexes in `name` that match the filter. */
  hits?: number[];
}

export interface FlattenOptions {
  /** Show only these files (and their folders). Folders on the way open. */
  only?: ReadonlySet<string> | null;
  /** Filter text: files whose path matches; their folders open. */
  filter?: string;
}

/**
 * The rows that show, top to bottom. Open folders show their children. With a filter or `only`, the
 * matching files show with all their folders open (the expanded set does not matter then).
 */
export function flattenTree(root: DirNode, expanded: ReadonlySet<string>, opts: FlattenOptions = {}): TreeRow[] {
  const q = (opts.filter ?? "").trim();
  let keep: Set<string> | null = null;
  let hitsByPath: Map<string, number[]> | null = null;
  if (q || opts.only) {
    const kept = new Set<string>();
    const hits = new Map<string, number[]>();
    const visit = (d: DirNode) => {
      for (const f of d.files) {
        if (opts.only && !opts.only.has(f.path)) continue;
        if (q) {
          const m = matchPath(q, f.path);
          if (!m) continue;
          hits.set(f.path, m.nameHits);
        }
        kept.add(f.path);
        for (const a of ancestors(f.path)) kept.add(a);
      }
      for (const c of d.dirs) visit(c);
    };
    visit(root);
    keep = kept;
    hitsByPath = hits;
  }
  const rows: TreeRow[] = [];
  const walk = (d: DirNode, level: number) => {
    const dirs = keep ? d.dirs.filter((x) => keep!.has(x.path)) : d.dirs;
    const files = keep ? d.files.filter((x) => keep!.has(x.path)) : d.files;
    const setsize = dirs.length + files.length;
    let pos = 0;
    for (const c of dirs) {
      const open = keep ? true : expanded.has(c.path);
      rows.push({ kind: "dir", path: c.path, name: c.name, level, posinset: ++pos, setsize, parent: d.path, expanded: open, count: c.count });
      if (open) walk(c, level + 1);
    }
    for (const f of files) {
      rows.push({ kind: "file", path: f.path, name: baseName(f.path), level, posinset: ++pos, setsize, parent: d.path, file: f, hits: hitsByPath?.get(f.path) });
    }
  };
  walk(root, 1);
  return rows;
}

/** Folders to open so that every file in `paths` shows. */
export function foldersToShow(paths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) for (const a of ancestors(p)) out.add(a);
  return [...out];
}

/** Every folder of a tree (for "open all"). */
export function allFolders(root: DirNode): string[] {
  const out: string[] = [];
  const walk = (d: DirNode) => {
    for (const c of d.dirs) {
      out.push(c.path);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/* ───────────── matching ───────────── */

/**
 * Tree filter: a case-insensitive substring of the path, else the letters in order (fuzzy).
 * `nameHits` are the matched indexes inside the file name (for bold letters).
 */
export function matchPath(query: string, path: string): { score: number; nameHits: number[] } | null {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const at = p.indexOf(q);
  if (at !== -1) {
    const hits: number[] = [];
    for (let i = at; i < at + q.length; i++) if (i >= nameStart) hits.push(i - nameStart);
    return { score: 1000 - at + (at >= nameStart ? 200 : 0), nameHits: hits };
  }
  const f = fuzzy(query, path);
  if (!f) return null;
  return { score: f.score, nameHits: f.hits.filter((i) => i >= nameStart).map((i) => i - nameStart) };
}

const SEP = /[/._\-\s]/;

/**
 * Fuzzy match: every letter of `query` in `text`, in order. The score prefers letters in a row, letters
 * at the start of a word or path part, and matches in the file name. null when a letter is missing.
 */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  const nameStart = text.lastIndexOf("/") + 1;
  // Quick reject: all letters must be present in order.
  let k = 0;
  for (let i = 0; i < t.length && k < q.length; i++) if (t[i] === q[k]) k++;
  if (k < q.length) return null;
  // Greedy from the end of the file name backwards gives better name matches; try the name first.
  const tryFrom = (start: number) => {
    const hits: number[] = [];
    let qi = 0;
    for (let i = start; i < t.length && qi < q.length; i++) {
      if (t[i] !== q[qi]) continue;
      hits.push(i);
      qi++;
    }
    return qi === q.length ? hits : null;
  };
  const candidates = [tryFrom(nameStart), tryFrom(0)].filter(Boolean) as number[][];
  // A better spread: prefer word starts when the same letter appears at a word start later.
  const refined = candidates.map((hits) => preferStarts(q, t, hits));
  let best: { score: number; hits: number[] } | null = null;
  for (const hits of refined) {
    let score = 0;
    for (let j = 0; j < hits.length; j++) {
      const i = hits[j];
      score += 1;
      if (j > 0 && hits[j - 1] === i - 1) score += 6;
      if (i === 0 || SEP.test(text[i - 1]) || (text[i] !== text[i].toLowerCase() && text[i - 1] === text[i - 1].toLowerCase())) score += 8;
      if (i >= nameStart) score += 4;
    }
    if (hits[0] === nameStart) score += 10;
    score -= Math.min(20, Math.floor((hits[hits.length - 1] - hits[0]) / 4));
    score -= Math.floor(text.length / 40);
    if (!best || score > best.score) best = { score, hits };
  }
  return best;
}

/** Move each hit to a later word start with the same letter when the order stays valid. */
function preferStarts(q: string, t: string, hits: number[]): number[] {
  const out = hits.slice();
  for (let j = 0; j < out.length; j++) {
    const i = out[j];
    const isStart = i === 0 || SEP.test(t[i - 1]);
    if (isStart) continue;
    // Keep runs of letters in a row together.
    if (j > 0 && out[j - 1] === i - 1) continue;
    const limit = j + 1 < out.length ? out[j + 1] : t.length;
    for (let x = i + 1; x < limit; x++) {
      if (t[x] === q[j] && SEP.test(t[x - 1])) {
        out[j] = x;
        break;
      }
    }
  }
  return out;
}

/** Folders that the file finder leaves out, as GitHub does. */
export const FINDER_SKIP = /(^|\/)(\.git|node_modules|bower_components|vendor|build|dist|out|\.next|\.nuxt|coverage|__pycache__|\.venv|venv)\//;

export interface FinderHit {
  path: string;
  score: number;
  hits: number[];
}

/** The best files for a finder query (at most `limit`). An empty query lists the first files. */
export function findFiles(paths: readonly string[], query: string, limit = 50): FinderHit[] {
  const q = query.trim();
  const out: FinderHit[] = [];
  for (const p of paths) {
    if (FINDER_SKIP.test(p)) continue;
    if (!q) {
      out.push({ path: p, score: 0, hits: [] });
      if (out.length >= limit) break;
      continue;
    }
    const m = fuzzy(q, p);
    if (m) out.push({ path: p, score: m.score, hits: m.hits });
  }
  if (q) out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || compareNames(a.path, b.path));
  return out.slice(0, limit);
}

/** Split text into runs for bold match letters: [{ text, hit }]. */
export function hitRuns(text: string, hits: readonly number[] | undefined, offset = 0): { text: string; hit: boolean }[] {
  if (!hits?.length) return [{ text, hit: false }];
  const set = new Set(hits.map((h) => h - offset));
  const runs: { text: string; hit: boolean }[] = [];
  let cur = "";
  let curHit = set.has(0);
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== curHit && cur) {
      runs.push({ text: cur, hit: curHit });
      cur = "";
    }
    curHit = h;
    cur += text[i];
  }
  if (cur) runs.push({ text: cur, hit: curHit });
  return runs;
}

/** Files that gitring shows as text cannot be these (by extension): images, fonts, archives, media. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|flac|mov|avi|mkv|webm|wasm|exe|dll|so|dylib|bin|class|o|a|pyc|sqlite|db|lockb)$/i;

export function looksBinary(path: string): boolean {
  return BINARY_EXT.test(path);
}
