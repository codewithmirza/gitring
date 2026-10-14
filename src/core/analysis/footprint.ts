/**
 * Footprint: what an attempt actually touched, computed from real file versions.
 *
 *   files     status (A/M/D), base hunks, additions, deletions        (every changed file)
 *   symbols   defined / modified / removed / signatureChanged / referenced, as `path#name` keys
 *             (analyzable JS/TS files only; binary files get a whole-file touch and no symbols)
 *
 * Pure module: runs in Node and in workerd.
 */
import type { FileTouch, Footprint, LineRange, SymbolKey, SymbolTouches } from "../types";
import { diffHunks, normalizeNewlines, type DiffHunk } from "../text/diff";
import { analyzeModule, isAnalyzable, ownEntry, resolveImport, type DeclInfo, type MemberInfo, type ModuleAnalysis, type PathAliases } from "./symbols";

export interface FileVersions {
  path: string;
  /** Text on the attempt's base; null = the file did not exist. */
  base: string | null;
  /** Text in the attempt's head; null = the file is deleted. */
  head: string | null;
}

/** Signature of one function symbol before (base) and after (head) the change. */
export interface SignatureChange {
  before?: string;
  after?: string;
}

/** Extension: the footprint plus the signatures of the function symbols it touches. */
export interface FootprintAnalysis {
  footprint: Footprint;
  /** `path#name` → base/head signature, for defined, modified, removed and signature-changed functions. */
  signatures: Record<SymbolKey, SignatureChange>;
  /** Import edges [file, imported file] of the changed files in head (a deleted file has none), from the same parse. */
  imports: [string, string][];
}

/** Extension: what the footprint knows about the repository beyond the changed files. */
export interface FootprintOptions {
  /** Path aliases (tsconfig.json or jsconfig.json): aliased imports resolve too. */
  aliases?: PathAliases;
  /**
   * True for a member key of the repository (`src/cart.js#Cart.add`). With it, `Cart.add(…)` on an
   * imported class or object becomes a use of that member.
   */
  knownMember?: (key: SymbolKey) => boolean;
}

/**
 * Footprint of a set of file versions. `allFiles` is every path of the head tree (used to resolve
 * relative imports). Identical versions are skipped. All symbol arrays are sorted and unique.
 *
 * Symbol rules (per analyzable file, `path#name` keys; an exported alias `export { a as b }` or a
 * named default export also adds `path#b` / `path#default`):
 *   defined           declarations in head that are not in base
 *   removed           declarations in base that are not in head
 *   modified          declarations in both whose text changed, or whose BASE range a hunk touches
 *                     (a pure insertion counts only when it lands strictly inside the declaration)
 *   signatureChanged  exported functions (incl. arrow functions) in both whose parameters changed
 *   referenced        what defined/modified declarations use in head, plus what changed top-level
 *                     statements use: imports resolve to `target#imported` (`ns.fn` → `target#fn`),
 *                     local declarations to `path#name`; globals and packages are skipped
 *
 * Members (`path#Class.method`, `path#api.list`): for a top-level class or object in both versions,
 * the same rules apply to each member, with its own lines and parameters. The class or object
 * itself is "modified" only when its text outside the members changes (the class head, for
 * example). A changed constructor signature is a signature change of the class. `this.x` in a
 * member, and `Owner.x` for a local owner, use `path#Owner.x`. Both versions must parse: with the
 * regex scanner, the whole class counts as one symbol, as before.
 */
export function computeFootprint(files: FileVersions[], allFiles: Set<string>, now: number = Date.now(), opts: FootprintOptions = {}): Footprint {
  return analyzeFootprint(files, allFiles, now, opts).footprint;
}

/** `computeFootprint` plus before/after signatures of the touched function symbols (one parse per version). */
export function analyzeFootprint(files: FileVersions[], allFiles: Set<string>, now: number = Date.now(), opts: FootprintOptions = {}): FootprintAnalysis {
  const touches = new Map<string, FileTouch>();
  const signatures = new Map<SymbolKey, SignatureChange>();
  const acc = {
    defined: new Set<SymbolKey>(),
    modified: new Set<SymbolKey>(),
    removed: new Set<SymbolKey>(),
    signatureChanged: new Set<SymbolKey>(),
    referenced: new Set<SymbolKey>(),
  };
  const referencedIn = new Map<SymbolKey, Set<string>>();
  const imports: [string, string][] = [];
  const list = files.filter((f) => f && typeof f.path === "string").sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  for (const f of list) {
    const base = typeof f.base === "string" ? f.base : null;
    const head = typeof f.head === "string" ? f.head : null;
    if (base === head) continue;
    const status: FileTouch["status"] = base === null ? "A" : head === null ? "D" : "M";
    if (looksBinary(base) || looksBinary(head)) {
      const lines = base === null ? 0 : countLines(base);
      touches.set(f.path, { status, hunks: status === "A" ? [[0, 0]] : [[1, Math.max(1, lines)]], additions: 0, deletions: 0 });
      continue;
    }
    // Same numbers as lineDiff (same engine); the per-hunk detail also tells insertions from replacements.
    const hunks = diffHunks(base ?? "", head ?? "");
    const touch: FileTouch = { status, hunks: [], additions: 0, deletions: 0 };
    const changedNewLines: LineRange[] = [];
    for (const h of hunks) {
      touch.hunks.push(h.oldLines > 0 ? [h.oldStart, h.oldStart + h.oldLines - 1] : [h.oldStart, h.oldStart]);
      if (h.newLines > 0) changedNewLines.push([h.newStart, h.newStart + h.newLines - 1]);
      touch.additions += h.newLines;
      touch.deletions += h.oldLines;
    }
    touches.set(f.path, touch);
    if (isAnalyzable(f.path)) {
      const local = new Set<SymbolKey>();
      symbolTouches(f.path, base, head, hunks, changedNewLines, allFiles, acc, signatures, local, opts, imports);
      for (const k of local) {
        const set = referencedIn.get(k) ?? new Set<string>();
        set.add(f.path);
        referencedIn.set(k, set);
      }
    }
  }
  const sorted = (s: Set<string>): SymbolKey[] => [...s].sort();
  const symbols: SymbolTouches = {
    defined: sorted(acc.defined),
    modified: sorted(acc.modified),
    removed: sorted(acc.removed),
    signatureChanged: sorted(acc.signatureChanged),
    referenced: sorted(acc.referenced),
  };
  if (referencedIn.size) {
    symbols.referencedIn = Object.fromEntries([...referencedIn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, [...v].sort()]));
  }
  return {
    footprint: { files: Object.fromEntries(touches), symbols, computedAt: now },
    signatures: Object.fromEntries(signatures),
    imports,
  };
}

/* ───────────────────────────── internals ───────────────────────────── */

type Acc = Record<Exclude<keyof SymbolTouches, "referencedIn">, Set<SymbolKey>>;

/** Text with NUL in the first 8000 characters is binary (git's rule, applied to decoded text). */
function looksBinary(text: string | null): boolean {
  return text !== null && text.slice(0, 8000).includes("\u0000");
}

function countLines(text: string): number {
  if (text === "") return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Does a hunk touch a base declaration range? Pure insertions count only strictly inside it. */
function hunkTouches(h: DiffHunk, [s, e]: LineRange): boolean {
  if (h.oldLines > 0) return h.oldStart <= e && s <= h.oldStart + h.oldLines - 1;
  return h.oldStart >= s && h.oldStart < e;
}

function rangesIntersect(a: LineRange, b: LineRange): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

function sameParams(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

function declText(lines: string[], d: { range: LineRange }): string {
  return lines.slice(Math.max(0, d.range[0] - 1), d.range[1]).join("\n");
}

/** Members of each owner, in source order. */
function membersByOwner(m: ModuleAnalysis | null): Map<string, MemberInfo[]> {
  const out = new Map<string, MemberInfo[]>();
  for (const x of Object.values(m?.members ?? {})) {
    const list = out.get(x.owner);
    if (list) list.push(x);
    else out.set(x.owner, [x]);
  }
  return out;
}

/**
 * The text of a class or object without its members: what a change to the class head (or to code
 * between the members) changes. Spaces, commas and semicolons do not count, so a member that comes
 * or goes leaves it the same.
 */
function skeleton(text: string, d: DeclInfo, members: readonly MemberInfo[]): string {
  /** Offset of the first character of a 1-based line (the text length after the last line). */
  const lineStart = (line: number): number => {
    let at = 0;
    for (let l = 1; l < line; l++) {
      const nl = text.indexOf("\n", at);
      if (nl < 0) return text.length;
      at = nl + 1;
    }
    return at;
  };
  const from = lineStart(d.range[0]);
  const to = lineStart(d.range[1] + 1);
  let out = "";
  let at = from;
  for (const m of [...members].sort((x, y) => x.span[0] - y.span[0])) {
    if (m.span[0] < at || m.span[1] > to) continue;
    out += text.slice(at, m.span[0]);
    at = m.span[1];
  }
  return (out + text.slice(at, to)).replace(/[\s,;]+/g, "");
}

function symbolTouches(
  path: string,
  base: string | null,
  head: string | null,
  hunks: DiffHunk[],
  changedNewLines: LineRange[],
  allFiles: Set<string>,
  acc: Acc,
  signatures: Map<SymbolKey, SignatureChange>,
  usedHere: Set<SymbolKey>,
  opts: FootprintOptions,
  imports: [string, string][],
): void {
  const baseText = base === null ? null : normalizeNewlines(base);
  const headText = head === null ? null : normalizeNewlines(head);
  const baseA = baseText === null ? null : analyzeModule(path, baseText);
  const headA = headText === null ? null : analyzeModule(path, headText);
  const baseLines = baseText === null ? [] : baseText.split("\n");
  const headLines = headText === null ? [] : headText.split("\n");
  const baseDecls: Record<string, DeclInfo> = baseA?.decls ?? {};
  const headDecls: Record<string, DeclInfo> = headA?.decls ?? {};
  const key = (name: string): SymbolKey => `${path}#${name}`;
  // Members count only when both versions parsed: the regex scanner sees top-level declarations only.
  const parsed = !baseA?.parseError && !headA?.parseError;
  const baseOwners = new Set(parsed ? (baseA?.memberOwners ?? []) : []);
  const headOwners = new Set(parsed ? (headA?.memberOwners ?? []) : []);
  const baseMembers = membersByOwner(parsed ? baseA : null);
  const headMembers = membersByOwner(parsed ? headA : null);

  /** The key plus the keys of other exported names of the same local binding. */
  const keysOf = (name: string, ...mods: (ModuleAnalysis | null)[]): SymbolKey[] => {
    const out = [key(name)];
    for (const m of mods) {
      if (!m) continue;
      for (const [exported, local] of Object.entries(m.exports)) if (local === name && exported !== name) out.push(key(exported));
    }
    return out;
  };
  /** Keys of a member: one for each key of its owner (`path#Cart.add`, `path#default.add`). */
  const memberKeys = (member: string, owner: string, ...mods: (ModuleAnalysis | null)[]): SymbolKey[] =>
    keysOf(owner, ...mods).map((k) => `${k}${member.slice(owner.length)}`);
  const add = (set: Set<SymbolKey>, keys: SymbolKey[]): void => {
    for (const k of keys) set.add(k);
  };
  const recordSignature = (name: string, before?: { signature?: string }, after?: { signature?: string }): void => {
    const s: SignatureChange = {};
    if (before?.signature !== undefined) s.before = before.signature;
    if (after?.signature !== undefined) s.after = after.signature;
    if (s.before !== undefined || s.after !== undefined) signatures.set(key(name), s);
  };
  const paramsChanged = (b: { exported: boolean; params?: string[] }, h: { exported: boolean; params?: string[] }): boolean =>
    (b.exported || h.exported) && (b.params !== undefined || h.params !== undefined) && !sameParams(b.params, h.params);

  const usedBy = new Set<string>();
  const usedByMember = new Set<string>();
  /** The members of an owner that is in both versions. */
  const memberTouches = (owner: string): void => {
    const before = new Map((baseMembers.get(owner) ?? []).map((m) => [m.name, m]));
    for (const h of headMembers.get(owner) ?? []) {
      const b = before.get(h.name);
      if (!b) {
        add(acc.defined, memberKeys(h.name, owner, headA));
        usedByMember.add(h.name);
        recordSignature(h.name, undefined, h);
        continue;
      }
      const modified = declText(baseLines, b) !== declText(headLines, h) || hunks.some((x) => hunkTouches(x, b.range));
      const signatureChanged = paramsChanged(b, h);
      if (modified) {
        add(acc.modified, memberKeys(h.name, owner, headA));
        usedByMember.add(h.name);
      }
      if (signatureChanged) {
        add(acc.signatureChanged, memberKeys(h.name, owner, baseA, headA));
        // A new constructor signature changes how code makes the class (`new Cart(a, b)`).
        if (h.name === `${owner}.constructor`) {
          add(acc.signatureChanged, keysOf(owner, baseA, headA));
          recordSignature(owner, { signature: `${owner}(${(b.params ?? []).join(", ")})` }, { signature: `${owner}(${(h.params ?? []).join(", ")})` });
        }
      }
      if (modified || signatureChanged) recordSignature(h.name, b, h);
    }
    const after = new Set((headMembers.get(owner) ?? []).map((m) => m.name));
    for (const b of baseMembers.get(owner) ?? []) {
      if (after.has(b.name)) continue;
      add(acc.removed, memberKeys(b.name, owner, baseA));
      recordSignature(b.name, b, undefined);
    }
  };

  for (const name of Object.keys(headDecls)) {
    const h = headDecls[name];
    const b = ownEntry(baseDecls, name);
    if (!b) {
      add(acc.defined, keysOf(name, headA));
      usedBy.add(name);
      recordSignature(name, undefined, h);
      continue;
    }
    // A class or object with members changes as a whole only outside its members.
    const byMember = baseOwners.has(name) && headOwners.has(name) && baseText !== null && headText !== null;
    const modified = byMember
      ? skeleton(baseText, b, baseMembers.get(name) ?? []) !== skeleton(headText, h, headMembers.get(name) ?? [])
      : declText(baseLines, b) !== declText(headLines, h) || hunks.some((x) => hunkTouches(x, b.range));
    const signatureChanged = paramsChanged(b, h);
    if (modified) {
      add(acc.modified, keysOf(name, headA));
      usedBy.add(name);
    }
    if (signatureChanged) add(acc.signatureChanged, keysOf(name, baseA, headA));
    if (modified || signatureChanged) recordSignature(name, b, h);
    if (byMember) memberTouches(name);
  }
  for (const name of Object.keys(baseDecls)) {
    if (ownEntry(headDecls, name)) continue;
    add(acc.removed, keysOf(name, baseA));
    recordSignature(name, baseDecls[name], undefined);
  }

  if (!headA) return;
  const refs = new Set<string>();
  for (const name of usedBy) for (const r of ownEntry(headA.references, name) ?? []) refs.add(r);
  for (const name of usedByMember) for (const r of ownEntry(headA.memberReferences, name) ?? []) refs.add(r);
  if (changedNewLines.length) {
    for (const st of headA.statements) {
      if (changedNewLines.some((r) => rangesIntersect(r, st.range))) for (const r of st.references) refs.add(r);
    }
  }
  const use = (k: SymbolKey): void => {
    acc.referenced.add(k);
    usedHere.add(k);
  };
  const targets = new Map<string, string | undefined>();
  const target = (spec: string): string | undefined => {
    if (!targets.has(spec)) targets.set(spec, resolveImport(path, spec, allFiles, opts.aliases));
    return targets.get(spec);
  };
  for (const imp of headA.imports) {
    const t = target(imp.from);
    if (t !== undefined && t !== path) imports.push([path, t]);
  }
  for (const r of refs) {
    const dot = r.indexOf(".");
    if (dot >= 0) {
      const binding = ownEntry(headA.bindings, r.slice(0, dot));
      const t = binding ? target(binding.from) : undefined;
      if (binding?.imported === "*") {
        if (t) use(`${t}#${r.slice(dot + 1)}`);
      } else if (binding) {
        // `Cart.add` on an imported class or object: a use of the member, when the repository has it.
        const member = t ? `${t}#${binding.imported}${r.slice(dot)}` : undefined;
        if (member && opts.knownMember?.(member)) use(member);
      } else if (ownEntry(headA.members, r)) use(key(r));
      continue;
    }
    const binding = ownEntry(headA.bindings, r);
    if (binding) {
      if (binding.imported === "*") continue;
      const t = target(binding.from);
      if (t) use(`${t}#${binding.imported}`);
      continue;
    }
    if (ownEntry(headDecls, r)) use(key(r));
  }
}
