/**
 * Range: the distance between two pieces of work in the code graph.
 *
 *   0  same lines (overlapping hunks on a shared file) or a symbol that both change
 *      (a class or object and one of its members count as one symbol: `Cart` and `Cart.add`)
 *   1  one side changes a symbol (or its signature) that the other side uses
 *   2  a shared file, different lines and symbols (two methods of one class, for example)
 *   3  two files one import apart
 *   4  two files two imports apart
 *   5  unrelated (open water)
 *
 * A WorkShape is the comparable outline of one vessel's work. The course (declared before
 * any code exists) gives files, the symbols it changes and the symbols it uses; the footprint
 * (real diffs) adds hunks, signature changes and references. `unionShapes(course, footprint)`
 * is what the course check compares.
 *
 * Pure module: no platform APIs.
 */
import type { Course, FileTouch, Footprint, LineRange, Range, SymbolKey } from "../types";
import type { ImportGraph } from "./graph";

/** Known signatures of one symbol (gitring extension; optional everywhere). */
export interface SignatureInfo {
  /** Signature on the base, for example "formatPrice(cents)". */
  before?: string;
  /** Signature after the change, for example "formatPrice(cents, currency)". */
  after?: string;
}

export interface WorkShape {
  files: string[];
  hunks: Record<string, LineRange[]>;
  /** defined ∪ modified ∪ removed (course symbols count as changed). */
  changed: SymbolKey[];
  signatureChanged: SymbolKey[];
  referenced: SymbolKey[];
  /** Extension (optional): the files where this work uses each referenced symbol. */
  referencedIn?: Record<SymbolKey, string[]>;
  /**
   * Extension (optional, contract-compatible): known signatures of symbols this shape changes.
   * Corrections quote them ("formatPrice(cents) to formatPrice(cents, currency)").
   */
  signatures?: Record<SymbolKey, SignatureInfo>;
}

/** Lines of tolerance when two hunks are compared (edits 2 lines apart still collide as text). */
export const HUNK_SLACK = 2;
/** Import hops that still count as "near" (range 3 = 1 hop, range 4 = 2 hops). */
export const GRAPH_HOPS = 2;

export function emptyShape(): WorkShape {
  return { files: [], hunks: {}, changed: [], signatureChanged: [], referenced: [] };
}

/* ───────────────────────────── paths and symbol keys ───────────────────────────── */

/** Repo-relative path without "./" or a leading "/". */
export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

/** Path part of a symbol key (`src/a.js#f` → `src/a.js`). Empty for a bare name. */
export function symbolPath(key: SymbolKey): string {
  const i = key.indexOf("#");
  return i < 0 ? "" : key.slice(0, i);
}

/** A symbol key with a normalized path part (`./src/a.js#f` → `src/a.js#f`). */
export function normalizeSymbolKey(key: SymbolKey): SymbolKey {
  const i = key.indexOf("#");
  return i < 0 ? key.trim() : `${normalizePath(key.slice(0, i))}#${key.slice(i + 1).trim()}`;
}

/** Name part of a symbol key (`src/a.js#f` → `f`). */
export function symbolName(key: SymbolKey): string {
  const i = key.indexOf("#");
  return i < 0 ? key : key.slice(i + 1);
}

export interface SymbolRef {
  key: SymbolKey;
  path: string;
  name: string;
  /** Present when the reference carried a parameter list, e.g. "formatPrice(cents, currency)". */
  signature?: string;
}

/**
 * Parse a symbol reference as agents write it in a course:
 * `src/products.js#formatPrice`, `./src/products.js:formatPrice`, `formatPrice`,
 * or with a parameter list: `src/products.js#formatPrice(cents, currency)`.
 */
export function parseSymbolRef(raw: string): SymbolRef {
  let s = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
  const paren = s.indexOf("(");
  const head = paren < 0 ? s : s.slice(0, paren);
  let sep = head.indexOf("#");
  if (sep < 0) {
    const colon = head.lastIndexOf(":");
    if (colon > 0 && /[./]/.test(head.slice(0, colon))) sep = colon;
  }
  const path = sep < 0 ? "" : normalizePath(s.slice(0, sep));
  s = sep < 0 ? s : s.slice(sep + 1).trim();
  let name = s;
  let signature: string | undefined;
  const open = s.indexOf("(");
  if (open >= 0) {
    name = s.slice(0, open).trim();
    const close = matchingParen(s, open);
    const params = s.slice(open + 1, close < 0 ? s.length : close);
    // "renderHeader (adds a button)" is a note, not a parameter list.
    if (looksLikeParams(params)) {
      signature = `${leadingName(name)}(${splitTopLevel(params).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join(", ")})`;
    }
  }
  name = leadingName(name);
  const key = path ? `${path}#${name}` : name;
  return signature ? { key, path, name, signature } : { key, path, name };
}

/** The identifier at the start of a symbol reference ("renderHeader — adds a button" → "renderHeader"). */
function leadingName(raw: string): string {
  const m = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(raw);
  return m ? m[1] : raw.replace(/\s+/g, "");
}

const PARAM_NAME = /^(?:\.\.\.)?[A-Za-z_$][\w$]*\??$/;

/** True when the text between parentheses reads as a parameter list ("cents, currency = 'USD'", "{ a, b }"). */
function looksLikeParams(inner: string): boolean {
  return splitTopLevel(inner)
    .map((p) => p.trim())
    .filter(Boolean)
    .every((p) => {
      if (p.startsWith("{") || p.startsWith("[")) return true; // destructuring
      let depth = 0;
      let left = "";
      for (const c of p) {
        if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
        else if (c === ")" || c === "]" || c === "}" || c === ">") depth = Math.max(0, depth - 1);
        if (depth === 0 && (c === "=" || c === ":")) break;
        left += c;
      }
      return PARAM_NAME.test(left.trim());
    });
}

function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas that are not inside (), [], {} or <>. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Parameter names of a signature string ("f(a, b = 1, ...rest)" → ["a", "b", "...rest"]). */
export function paramNames(signature: string): string[] | undefined {
  const open = signature.indexOf("(");
  if (open < 0) return undefined;
  const close = matchingParen(signature, open);
  const inner = signature.slice(open + 1, close < 0 ? signature.length : close);
  return splitTopLevel(inner)
    .map((p) => {
      let depth = 0;
      let name = "";
      for (const c of p) {
        if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
        else if (c === ")" || c === "]" || c === "}" || c === ">") depth = Math.max(0, depth - 1);
        if (depth === 0 && (c === "=" || c === ":")) break;
        name += c;
      }
      return name.replace(/\?$/, "").replace(/\s+/g, "");
    })
    .filter(Boolean);
}

/** The call shape of a signature: parameter names only ("f(a, b = 1)" → "f(a, b)"). */
export function callForm(signature: string): string {
  const open = signature.indexOf("(");
  const params = paramNames(signature);
  if (open < 0 || !params) return signature.trim();
  return `${signature.slice(0, open).trim()}(${params.join(", ")})`;
}

/** Two signatures are the same when the names and parameter names match (types and defaults ignored). */
export function sameSignature(a: string, b: string): boolean {
  const na = a.slice(0, Math.max(0, a.indexOf("("))).trim();
  const nb = b.slice(0, Math.max(0, b.indexOf("("))).trim();
  const pa = paramNames(a);
  const pb = paramNames(b);
  if (!pa || !pb) return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
  return na === nb && pa.length === pb.length && pa.every((x, i) => x === pb[i]);
}

function byName(keys: readonly SymbolKey[]): Map<string, SymbolKey[]> {
  const out = new Map<string, SymbolKey[]>();
  for (const k of keys) {
    const n = symbolName(k);
    const list = out.get(n);
    if (list) list.push(k);
    else out.set(n, [k]);
  }
  return out;
}

/** Name of the class or object that a member key belongs to (`src/a.js#Cart.add` → `Cart`). Empty for a plain name. */
export function ownerName(key: SymbolKey): string {
  const name = symbolName(key);
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : "";
}

/**
 * Symbols present on both sides. A bare name (no path) matches any key with that name.
 * Returns the qualified key when one side has it. Sorted, unique.
 * With `members`, a class or object also matches each of its members (`Cart` and `Cart.add`), in the
 * same file; the member key is returned.
 */
export function intersectSymbols(as: readonly SymbolKey[], bs: readonly SymbolKey[], opts: { members?: boolean } = {}): SymbolKey[] {
  if (!as.length || !bs.length) return [];
  const bSet = new Set(bs);
  const bByName = byName(bs);
  const out = new Set<SymbolKey>();
  for (const k of as) {
    if (bSet.has(k)) {
      out.add(k);
      continue;
    }
    const sameName = bByName.get(symbolName(k)) ?? [];
    if (!symbolPath(k)) {
      for (const b of sameName) out.add(b);
    } else if (sameName.some((b) => !symbolPath(b))) {
      out.add(k);
    }
  }
  if (opts.members) {
    const aByName = byName(as);
    const memberOf = (member: SymbolKey, owners: Map<string, SymbolKey[]>): void => {
      const owner = ownerName(member);
      if (!owner) return;
      const path = symbolPath(member);
      for (const o of owners.get(owner) ?? []) {
        const op = symbolPath(o);
        if (path && op && path !== op) continue;
        out.add(path || !op ? member : `${op}#${symbolName(member)}`);
      }
    };
    for (const k of as) memberOf(k, bByName);
    for (const k of bs) memberOf(k, aByName);
  }
  return [...out].sort();
}

export function isCodePath(path: string): boolean {
  return /\.(m?[jt]sx?|c[jt]s|m[jt]s)$/i.test(path);
}

/* ───────────────────────────── hunks ───────────────────────────── */

/** True when two inclusive line ranges overlap, with `slack` lines of tolerance. */
export function hunksOverlap(a: LineRange, b: LineRange, slack = HUNK_SLACK): boolean {
  return a[0] <= b[1] + slack && b[0] <= a[1] + slack;
}

/** Sort and merge ranges that overlap or touch. Never mutates the input. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = ranges
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]))
    .map((r): LineRange => [Math.min(r[0], r[1]), Math.max(r[0], r[1])])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Hunks of one file touch. An added file with no hunks collides at its top; a deleted file covers all its lines. */
function touchHunks(touch: FileTouch): LineRange[] {
  const hunks = mergeRanges(touch.hunks ?? []);
  if (hunks.length) return hunks;
  if (touch.status === "A") return [[0, 0]];
  if (touch.status === "D") return [[1, Math.max(1, touch.deletions || 1)]];
  return [];
}

/* ───────────────────────────── shapes ───────────────────────────── */

const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].filter(Boolean).sort();

/**
 * Where each name is defined on main: name → paths (`formatPrice` → ["src/products.js"]). Members of
 * classes and objects count by their full name (`Cart.add`).
 */
export type NameIndex = Readonly<Record<string, readonly string[]>>;

/**
 * Keys for a symbol that a plan names without a path.
 *
 * Without an index of main, the bare name stays, and it then matches any key with that name. With the index:
 *   changed  the plan's own code files (only the ones that define the name on main, when some do); a plan
 *            with no code files gets the one main file that defines the name
 *   used     the one main file that defines the name; with more files, the plan's own files among them;
 *            a name that main does not define stays bare (another plan can add it)
 * A name that matches no file gives no key: it cannot match a symbol in an unrelated file.
 */
export function qualifyBareName(name: string, planFiles: readonly string[], role: "changed" | "used", definedIn?: NameIndex): SymbolKey[] {
  if (!definedIn) return [name];
  const homes = Object.hasOwn(definedIn, name) ? (definedIn[name] ?? []) : [];
  const code = planFiles.filter(isCodePath);
  if (role === "changed") {
    if (code.length) {
      const known = code.filter((f) => homes.includes(f));
      return (known.length ? known : code).map((f) => `${f}#${name}`);
    }
    return homes.length === 1 ? [`${homes[0]}#${name}`] : [];
  }
  if (!homes.length) return [name];
  if (homes.length === 1) return [`${homes[0]}#${name}`];
  return code.filter((f) => homes.includes(f)).map((f) => `${f}#${name}`);
}

/**
 * Shape of a declared course. Course symbols count as "changed"; their files count as touched. The
 * symbols the course uses (`course.uses`) count as "referenced", so a plan that calls a function and a
 * plan that changes it are at range 1 before any code exists.
 * Extension: when `baseSignatures` (symbol key → signature on main) is given and a course symbol
 * carries a different parameter list (`src/products.js#formatPrice(cents, currency)`), the symbol
 * is also a declared signature change. With `definedIn` (the names on main), a symbol without a path
 * becomes the keys of `qualifyBareName`.
 */
export function shapeFromCourse(course: Course, baseSignatures?: Record<SymbolKey, string>, definedIn?: NameIndex): WorkShape {
  const planFiles = (course.files ?? []).map(normalizePath);
  const files = new Set(planFiles);
  const changed = new Set<SymbolKey>();
  const signatureChanged = new Set<SymbolKey>();
  const referenced = new Set<SymbolKey>();
  const signatures: Record<SymbolKey, SignatureInfo> = {};
  const refs = (raw: unknown): SymbolRef[] => {
    if (typeof raw !== "string" || !raw.trim()) return [];
    const ref = parseSymbolRef(raw);
    return ref.name ? [ref] : [];
  };
  for (const ref of (course.symbols ?? []).flatMap(refs)) {
    for (const key of ref.path ? [ref.key] : qualifyBareName(ref.name, planFiles, "changed", definedIn)) {
      changed.add(key);
      const path = symbolPath(key);
      if (path) files.add(path);
      if (ref.signature) {
        const before = baseSignatures?.[key];
        signatures[key] = before ? { before, after: ref.signature } : { after: ref.signature };
        if (before && !sameSignature(before, ref.signature)) signatureChanged.add(key);
      }
    }
  }
  for (const ref of (course.uses ?? []).flatMap(refs)) {
    for (const key of ref.path ? [ref.key] : qualifyBareName(ref.name, planFiles, "used", definedIn)) referenced.add(key);
  }
  const shape: WorkShape = {
    files: uniqSorted(files),
    hunks: {},
    changed: uniqSorted(changed),
    signatureChanged: uniqSorted(signatureChanged),
    referenced: uniqSorted(referenced),
  };
  if (Object.keys(signatures).length) shape.signatures = signatures;
  return shape;
}

/**
 * Shape of a real footprint. Extension: `signatures` carries known before/after signatures
 * (for example from the symbol tables of base and head).
 */
export function shapeFromFootprint(fp: Footprint, signatures?: Record<SymbolKey, SignatureInfo>): WorkShape {
  const hunks: Record<string, LineRange[]> = {};
  const files: string[] = [];
  for (const [rawPath, touch] of Object.entries(fp.files ?? {})) {
    const path = normalizePath(rawPath);
    files.push(path);
    const h = touch ? touchHunks(touch) : [];
    if (h.length) hunks[path] = mergeRanges([...(hunks[path] ?? []), ...h]);
  }
  const s = fp.symbols ?? { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [] };
  const keys = (xs: readonly SymbolKey[] | undefined) => (xs ?? []).filter((k) => typeof k === "string").map(normalizeSymbolKey);
  const shape: WorkShape = {
    files: uniqSorted(files),
    hunks,
    changed: uniqSorted([...keys(s.defined), ...keys(s.modified), ...keys(s.removed)]),
    signatureChanged: uniqSorted(keys(s.signatureChanged)),
    referenced: uniqSorted(keys(s.referenced)),
  };
  if (s.referencedIn && Object.keys(s.referencedIn).length) {
    const at: Record<SymbolKey, string[]> = {};
    for (const [k, paths] of Object.entries(s.referencedIn)) at[normalizeSymbolKey(k)] = uniqSorted((paths ?? []).map(normalizePath));
    shape.referencedIn = at;
  }
  if (signatures && Object.keys(signatures).length) shape.signatures = { ...signatures };
  return shape;
}

/** Union of two shapes. For signature info, known fields of `b` win (pass the footprint as `b`). */
export function unionShapes(a: WorkShape, b: WorkShape): WorkShape {
  const hunks: Record<string, LineRange[]> = {};
  for (const src of [a.hunks, b.hunks]) {
    for (const [path, rs] of Object.entries(src ?? {})) {
      hunks[path] = mergeRanges([...(hunks[path] ?? []), ...rs]);
    }
  }
  const shape: WorkShape = {
    files: uniqSorted([...a.files, ...b.files]),
    hunks,
    changed: uniqSorted([...a.changed, ...b.changed]),
    signatureChanged: uniqSorted([...a.signatureChanged, ...b.signatureChanged]),
    referenced: uniqSorted([...a.referenced, ...b.referenced]),
  };
  if (a.referencedIn || b.referencedIn) {
    const at: Record<SymbolKey, string[]> = {};
    for (const src of [a.referencedIn, b.referencedIn]) {
      for (const [k, paths] of Object.entries(src ?? {})) at[k] = uniqSorted([...(at[k] ?? []), ...paths]);
    }
    shape.referencedIn = at;
  }
  if (a.signatures || b.signatures) {
    const sig: Record<SymbolKey, SignatureInfo> = {};
    for (const [k, v] of Object.entries(a.signatures ?? {})) sig[k] = { ...v };
    for (const [k, v] of Object.entries(b.signatures ?? {})) {
      const prev = sig[k] ?? {};
      sig[k] = { before: v.before ?? prev.before, after: v.after ?? prev.after };
      if (sig[k].before === undefined) delete sig[k].before;
      if (sig[k].after === undefined) delete sig[k].after;
    }
    shape.signatures = sig;
  }
  return shape;
}

/* ───────────────────────────── range ───────────────────────────── */

export function sharedFiles(a: WorkShape, b: WorkShape): string[] {
  const bs = new Set(b.files);
  return uniqSorted(a.files.filter((f) => bs.has(f)));
}

/** Overlapping hunk pairs on shared files (slack HUNK_SLACK). */
export function overlappingHunks(a: WorkShape, b: WorkShape, slack = HUNK_SLACK): { path: string; a: LineRange; b: LineRange }[] {
  const out: { path: string; a: LineRange; b: LineRange }[] = [];
  for (const path of sharedFiles(a, b)) {
    for (const ha of a.hunks[path] ?? []) {
      for (const hb of b.hunks[path] ?? []) {
        if (hunksOverlap(ha, hb, slack)) out.push({ path, a: [ha[0], ha[1]], b: [hb[0], hb[1]] });
      }
    }
  }
  return out;
}

/** Symbols that both sides change. A class and one of its members count as one symbol. */
export function sharedChanges(a: WorkShape, b: WorkShape): SymbolKey[] {
  return intersectSymbols(a.changed, b.changed, { members: true });
}

/** Symbols one side changes (or re-signs) that the other side uses. A class and one of its members count as one symbol. */
export function usedChanges(producer: WorkShape, consumer: WorkShape): SymbolKey[] {
  return intersectSymbols(uniqSorted([...producer.changed, ...producer.signatureChanged]), consumer.referenced, { members: true });
}

/**
 * Import distances are memoized per graph object (graphs are rebuilt when main moves, so an
 * entry never goes stale). Bounded: the memo of one graph is cleared at DISTANCE_MEMO_MAX entries.
 */
const distanceMemo = new WeakMap<ImportGraph, Map<string, number>>();
const DISTANCE_MEMO_MAX = 50_000;

function safeDistance(graph: ImportGraph, a: string, b: string, max: number): number {
  let memo = distanceMemo.get(graph);
  if (!memo) distanceMemo.set(graph, (memo = new Map()));
  const key = `${max}\u0000${a < b ? a : b}\u0000${a < b ? b : a}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let d: number;
  try {
    const raw = graph.distance(a, b, max);
    d = typeof raw === "number" && !Number.isNaN(raw) && raw <= max ? raw : Infinity;
  } catch {
    d = Infinity;
  }
  if (memo.size >= DISTANCE_MEMO_MAX) memo.clear();
  memo.set(key, d);
  return d;
}

/** Smallest import distance between any file of `a` and any file of `b` (Infinity above `max`). */
export function minImportDistance(a: readonly string[], b: readonly string[], graph: ImportGraph, max = GRAPH_HOPS): number {
  let best = Infinity;
  for (const fa of a) {
    for (const fb of b) {
      if (fa === fb) return 0;
      const d = safeDistance(graph, fa, fb, max);
      if (d < best) best = d;
      if (best <= 1) return best;
    }
  }
  return best;
}

export function computeRange(a: WorkShape, b: WorkShape, graph: ImportGraph): Range {
  if (overlappingHunks(a, b).length > 0) return 0;
  if (sharedChanges(a, b).length > 0) return 0;
  if (usedChanges(a, b).length > 0 || usedChanges(b, a).length > 0) return 1;
  if (sharedFiles(a, b).length > 0) return 2;
  const d = minImportDistance(a.files, b.files, graph, GRAPH_HOPS);
  if (d <= 1) return 3;
  if (d === 2) return 4;
  return 5;
}
