/**
 * Compares the two versions of one changed file and names the symbols it defines, changes, removes and uses.
 *
 * Called by `footprint.ts` for each changed JavaScript or TypeScript file. The rules are in the comment of `analyzeFootprint`.
 * Pure module: runs in Node and in workerd.
 */

import type { LineRange, SymbolKey, SymbolTouches } from "../types";
import { normalizeNewlines } from "../text/diff";
import type { DiffHunk } from "../text/diff";
import type { FootprintOptions, SignatureChange } from "./footprint";
import { analyzeModule, ownEntry, resolveImport } from "./symbols";
import type { DeclInfo, MemberInfo, ModuleAnalysis } from "./symbols";

export type Acc = Record<Exclude<keyof SymbolTouches, "referencedIn">, Set<SymbolKey>>;

// ───── Helpers ─────

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

// ───── The comparison ─────

export function symbolTouches(
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
  new SymbolTouchReader(path, base, head, hunks, changedNewLines, allFiles, acc, signatures, usedHere, opts, imports).read();
}

/**
 * The state of the comparison of one file: its two versions, their analyses and the sets that collect the result.
 * `read` is the entry point.
 */
class SymbolTouchReader {
  private readonly baseText: string | null;
  private readonly headText: string | null;
  private readonly baseA: ModuleAnalysis | null;
  private readonly headA: ModuleAnalysis | null;
  private readonly baseLines: string[];
  private readonly headLines: string[];
  private readonly baseDecls: Record<string, DeclInfo>;
  private readonly headDecls: Record<string, DeclInfo>;
  private readonly baseOwners: Set<string>;
  private readonly headOwners: Set<string>;
  private readonly baseMembers: Map<string, MemberInfo[]>;
  private readonly headMembers: Map<string, MemberInfo[]>;
  private readonly usedBy: Set<string>;
  private readonly usedByMember: Set<string>;
  private readonly targets: Map<string, string | undefined>;

  constructor(
    private readonly path: string,
    base: string | null,
    head: string | null,
    private readonly hunks: DiffHunk[],
    private readonly changedNewLines: LineRange[],
    private readonly allFiles: Set<string>,
    private readonly acc: Acc,
    private readonly signatures: Map<SymbolKey, SignatureChange>,
    private readonly usedHere: Set<SymbolKey>,
    private readonly opts: FootprintOptions,
    private readonly imports: [string, string][],
  ) {
    this.baseText = base === null ? null : normalizeNewlines(base);
    this.headText = head === null ? null : normalizeNewlines(head);
    this.baseA = this.baseText === null ? null : analyzeModule(this.path, this.baseText);
    this.headA = this.headText === null ? null : analyzeModule(this.path, this.headText);
    this.baseLines = this.baseText === null ? [] : this.baseText.split("\n");
    this.headLines = this.headText === null ? [] : this.headText.split("\n");
    this.baseDecls = this.baseA?.decls ?? {};
    this.headDecls = this.headA?.decls ?? {};
    // Members count only when both versions parsed: the regex scanner sees top-level declarations only.
    const parsed = !this.baseA?.parseError && !this.headA?.parseError;
    this.baseOwners = new Set(parsed ? (this.baseA?.memberOwners ?? []) : []);
    this.headOwners = new Set(parsed ? (this.headA?.memberOwners ?? []) : []);
    this.baseMembers = membersByOwner(parsed ? this.baseA : null);
    this.headMembers = membersByOwner(parsed ? this.headA : null);
    this.usedBy = new Set<string>();
    this.usedByMember = new Set<string>();
    this.targets = new Map();
  }

  /** Fills the shared sets with the symbols that this file defines, changes, removes and uses. */
  read(): void {
    this.touchDeclarations();
    if (!this.headA) return;
    this.collectReferences(this.headA);
  }

  /** Compares the declarations of the two versions, and the members of the classes and objects that are in both. */
  private touchDeclarations(): void {
    for (const name of Object.keys(this.headDecls)) {
      const h = this.headDecls[name];
      const b = ownEntry(this.baseDecls, name);
      if (!b) {
        this.add(this.acc.defined, this.keysOf(name, this.headA));
        this.usedBy.add(name);
        this.recordSignature(name, undefined, h);
        continue;
      }
      // A class or object with members changes as a whole only outside its members.
      const byMember = this.baseOwners.has(name) && this.headOwners.has(name) && this.baseText !== null && this.headText !== null;
      const modified = byMember
        ? skeleton(this.baseText, b, this.baseMembers.get(name) ?? []) !== skeleton(this.headText, h, this.headMembers.get(name) ?? [])
        : declText(this.baseLines, b) !== declText(this.headLines, h) || this.hunks.some((x) => hunkTouches(x, b.range));
      const signatureChanged = this.paramsChanged(b, h);
      if (modified) {
        this.add(this.acc.modified, this.keysOf(name, this.headA));
        this.usedBy.add(name);
      }
      if (signatureChanged) this.add(this.acc.signatureChanged, this.keysOf(name, this.baseA, this.headA));
      if (modified || signatureChanged) this.recordSignature(name, b, h);
      if (byMember) this.memberTouches(name);
    }
    for (const name of Object.keys(this.baseDecls)) {
      if (ownEntry(this.headDecls, name)) continue;
      this.add(this.acc.removed, this.keysOf(name, this.baseA));
      this.recordSignature(name, this.baseDecls[name], undefined);
    }
  }

  /** What the changed code of the head uses: the names that defined or changed symbols use, and the changed top-level statements. */
  private collectReferences(headA: ModuleAnalysis): void {
    const refs = new Set<string>();
    for (const name of this.usedBy) for (const r of ownEntry(headA.references, name) ?? []) refs.add(r);
    for (const name of this.usedByMember) for (const r of ownEntry(headA.memberReferences, name) ?? []) refs.add(r);
    if (this.changedNewLines.length) {
      for (const st of headA.statements) {
        if (this.changedNewLines.some((r) => rangesIntersect(r, st.range))) for (const r of st.references) refs.add(r);
      }
    }
    for (const imp of headA.imports) {
      const t = this.target(imp.from);
      if (t !== undefined && t !== this.path) this.imports.push([this.path, t]);
    }
    for (const r of refs) {
      const dot = r.indexOf(".");
      if (dot >= 0) {
        const binding = ownEntry(headA.bindings, r.slice(0, dot));
        const t = binding ? this.target(binding.from) : undefined;
        if (binding?.imported === "*") {
          if (t) this.use(`${t}#${r.slice(dot + 1)}`);
        } else if (binding) {
          // `Cart.add` on an imported class or object: a use of the member, when the repository has it.
          const member = t ? `${t}#${binding.imported}${r.slice(dot)}` : undefined;
          if (member && this.opts.knownMember?.(member)) this.use(member);
        } else if (ownEntry(headA.members, r)) this.use(this.key(r));
        continue;
      }
      const binding = ownEntry(headA.bindings, r);
      if (binding) {
        if (binding.imported === "*") continue;
        const t = this.target(binding.from);
        if (t) this.use(`${t}#${binding.imported}`);
        continue;
      }
      if (ownEntry(this.headDecls, r)) this.use(this.key(r));
    }
  }

  /** The key of a symbol of this file: `path#name`. */
  private key(name: string): SymbolKey {
    return `${this.path}#${name}`;
  }

  /** The key plus the keys of other exported names of the same local binding. */
  private keysOf(name: string, ...mods: (ModuleAnalysis | null)[]): SymbolKey[] {
    const out = [this.key(name)];
    for (const m of mods) {
      if (!m) continue;
      for (const [exported, local] of Object.entries(m.exports)) if (local === name && exported !== name) out.push(this.key(exported));
    }
    return out;
  }

  /** Keys of a member: one for each key of its owner (`path#Cart.add`, `path#default.add`). */
  private memberKeys(member: string, owner: string, ...mods: (ModuleAnalysis | null)[]): SymbolKey[] {
    return this.keysOf(owner, ...mods).map((k) => `${k}${member.slice(owner.length)}`);
  }

  /** Adds every key to a set. */
  private add(set: Set<SymbolKey>, keys: SymbolKey[]): void {
    for (const k of keys) set.add(k);
  }

  /** Keeps the signature of a symbol before and after the change, when either is known. */
  private recordSignature(name: string, before?: { signature?: string }, after?: { signature?: string }): void {
    const s: SignatureChange = {};
    if (before?.signature !== undefined) s.before = before.signature;
    if (after?.signature !== undefined) s.after = after.signature;
    if (s.before !== undefined || s.after !== undefined) this.signatures.set(this.key(name), s);
  }

  /** True when an exported function or member has other parameters in the head. */
  private paramsChanged(b: { exported: boolean; params?: string[] }, h: { exported: boolean; params?: string[] }): boolean {
    return (b.exported || h.exported) && (b.params !== undefined || h.params !== undefined) && !sameParams(b.params, h.params);
  }

  /** The members of an owner that is in both versions. */
  private memberTouches(owner: string): void {
    const before = new Map((this.baseMembers.get(owner) ?? []).map((m) => [m.name, m]));
    for (const h of this.headMembers.get(owner) ?? []) {
      const b = before.get(h.name);
      if (!b) {
        this.add(this.acc.defined, this.memberKeys(h.name, owner, this.headA));
        this.usedByMember.add(h.name);
        this.recordSignature(h.name, undefined, h);
        continue;
      }
      const modified = declText(this.baseLines, b) !== declText(this.headLines, h) || this.hunks.some((x) => hunkTouches(x, b.range));
      const signatureChanged = this.paramsChanged(b, h);
      if (modified) {
        this.add(this.acc.modified, this.memberKeys(h.name, owner, this.headA));
        this.usedByMember.add(h.name);
      }
      if (signatureChanged) {
        this.add(this.acc.signatureChanged, this.memberKeys(h.name, owner, this.baseA, this.headA));
        // A new constructor signature changes how code makes the class (`new Cart(a, b)`).
        if (h.name === `${owner}.constructor`) {
          this.add(this.acc.signatureChanged, this.keysOf(owner, this.baseA, this.headA));
          this.recordSignature(owner, { signature: `${owner}(${(b.params ?? []).join(", ")})` }, { signature: `${owner}(${(h.params ?? []).join(", ")})` });
        }
      }
      if (modified || signatureChanged) this.recordSignature(h.name, b, h);
    }
    const after = new Set((this.headMembers.get(owner) ?? []).map((m) => m.name));
    for (const b of this.baseMembers.get(owner) ?? []) {
      if (after.has(b.name)) continue;
      this.add(this.acc.removed, this.memberKeys(b.name, owner, this.baseA));
      this.recordSignature(b.name, b, undefined);
    }
  }

  /** A use of a symbol of the repository by the changed code of this file. */
  private use(k: SymbolKey): void {
    this.acc.referenced.add(k);
    this.usedHere.add(k);
  }

  /** The file that a module specifier points to (looked up once for each specifier). */
  private target(spec: string): string | undefined {
    if (!this.targets.has(spec)) this.targets.set(spec, resolveImport(this.path, spec, this.allFiles, this.opts.aliases));
    return this.targets.get(spec);
  }
}
