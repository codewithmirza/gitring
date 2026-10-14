/**
 * Compares two versions (main, a commit or a work copy) and answers the changed files with their diff.
 * Layer 4 of the chain in README.md. Extends DerivedAnswers (answers.ts).
 * The diff text has a limit for one answer: the last files come with counts and no diff.
 * Read next: ../derived.ts.
 */
import type { TreeEntry } from "../../platform/repo/backend";
import { EMPTY_TREE_SHA } from "../../core/git/objects";
import { lineDiff, unifiedDiff } from "../../core/text/diff";
import { textEligible } from "../../core/repo-rules";
import { compareWords, short, versionWords, type CompareAnswer, type CompareFile } from "../../core/history";
import { COMPARE_CHARS, COMPARE_FILES, TEXT_READS } from "./constants";
import { isBlob, mapLimit, normPath } from "./helpers";
import { diffTrees } from "./tree-diff";
import type { CompareSide, TreeChange } from "./types";
import { DerivedAnswers } from "./answers";

export abstract class DerivedCompare extends DerivedAnswers {
  // ───── Reading the two sides ─────

  /** A commit id from its first characters: a change of main, a merge, or main. */
  protected expand(ref: string): string | null {
    const m = this.src.main();
    const found = new Set<string>();
    for (const r of this.sql.exec<{ sha: string }>("SELECT sha FROM dd_steps WHERE substr(sha, 1, ?) = ?", ref.length, ref).toArray()) found.add(r.sha);
    for (const l of this.src.landings()) for (const sha of [l.mainBefore, l.mainAfter]) if (sha?.startsWith(ref)) found.add(sha);
    if (m?.sha.startsWith(ref)) found.add(m.sha);
    if (found.size > 1) throw new Error(`More than one commit starts with ${ref}. Give more characters of the commit id.`);
    return found.size ? [...found][0] : null;
  }

  /**
   * One side of a compare: a tree, and for a work copy the files that the work changed (text files) or
   * deleted. A work copy has the tree of its base.
   */
  protected async side(raw: string): Promise<CompareSide> {
    const ref = String(raw ?? "").trim();
    if (!ref) throw new Error("Give two versions: main, a commit id or a work copy id.");
    const m = this.src.main();
    if (!m) throw new Error("The project has no main yet. Ask again when the import is done.");
    if (ref === "main" || ref === m.sha) return { label: "main", tree: m.tree };
    if (/^[0-9a-f]{7,40}$/.test(ref)) {
      const sha = ref.length === 40 ? ref : this.expand(ref);
      const commit = sha ? await this.src.commit(sha) : null;
      if (!commit) throw new Error(`Commit ${short(ref)} is not in this project.`);
      return { label: versionWords(commit.hash), tree: commit.treeHash };
    }
    const wc = await this.src.workCopy(ref);
    if (!wc) throw new Error(`Unknown version "${ref}". Use main, a commit id or a work copy id.`);
    // The files of a work copy are the text of its base plus the work: the changed ones differ from the base.
    const base = await this.src.treeText(wc.attempt.baseTree);
    const changed = new Set(wc.deleted);
    for (const [p, t] of wc.files) if (base.text.get(p) !== t) changed.add(p);
    return { label: versionWords(ref, wc.callsign), tree: wc.attempt.baseTree, work: { files: wc.files, changed, deleted: new Set(wc.deleted) } };
  }

  /**
   * The file at `path` of one side: null when the side does not have it, else its id and its text (null
   * for a file without text). `entry`: the tree entry when the caller knows it (null: not in the tree).
   */
  protected async fileOf(s: CompareSide, path: string, entry?: TreeEntry | null): Promise<{ id: string; text: string | null } | null> {
    if (s.work?.changed.has(path)) {
      const t = s.work.deleted.has(path) ? undefined : s.work.files.get(path);
      return t === undefined ? null : { id: `work:${path}`, text: t };
    }
    const e = entry === undefined ? await this.entryAt(s.tree, path) : entry;
    if (!e || e.type === "tree") return null;
    return { id: `${e.hash}:${e.mode}`, text: isBlob(e) && textEligible(path) ? await this.src.text(e.hash) : null };
  }

  /** The changes between two trees under `path` (a folder or a file; "" for all). */
  protected async treeChanges(a: string, b: string, path: string): Promise<{ changes: TreeChange[]; cut: boolean }> {
    if (!path) return diffTrees(this.readTree, a, b, COMPARE_FILES + 1);
    const [ea, eb] = await Promise.all([this.entryAt(a, path), this.entryAt(b, path)]);
    const sub = (e: TreeEntry | null) => (e?.type === "tree" ? e.hash : EMPTY_TREE_SHA);
    const out = await diffTrees(this.readTree, sub(ea), sub(eb), COMPARE_FILES + 1, path);
    // A file at the path itself.
    const fa = ea && ea.type !== "tree" ? ea : undefined;
    const fb = eb && eb.type !== "tree" ? eb : undefined;
    if ((fa || fb) && !(fa && fb && fa.hash === fb.hash && fa.mode === fb.mode)) out.changes.unshift({ path, status: fa && fb ? "M" : fa ? "D" : "A", old: fa, now: fb });
    return out;
  }

  // ───── The comparison ─────

  /**
   * The changes from one version to another: each side is main, a commit id or a work copy id. With
   * `path`: only the files of that folder, or that file. The tree diff never opens a subtree that did not
   * change, and only the changed files are read. When the diff text is too long for one answer, the
   * last files come without their diff.
   */
  async compare(from: string, to: string, rawPath?: string): Promise<CompareAnswer> {
    const path = rawPath ? normPath(rawPath) : "";
    const under = (p: string) => !path || p === path || p.startsWith(`${path}/`);
    const [a, b] = await Promise.all([this.side(from), this.side(to)]);
    const { changes, cut } = await this.treeChanges(a.tree, b.tree, path);
    const inTrees = new Map(changes.map((c) => [c.path, c]));
    const worked = [...(a.work?.changed ?? []), ...(b.work?.changed ?? [])].filter(under);
    const paths = [...new Set([...inTrees.keys(), ...worked])].sort();
    const pairs = await mapLimit(paths, TEXT_READS, async (path) => {
      const c = inTrees.get(path);
      const [fa, fb] = await Promise.all([this.fileOf(a, path, c ? (c.old ?? null) : undefined), this.fileOf(b, path, c ? (c.now ?? null) : undefined)]);
      return { path, fa, fb };
    });
    const files: CompareFile[] = [];
    let additions = 0;
    let deletions = 0;
    let chars = 0;
    let left = 0;
    let more = cut;
    for (const { path: p, fa, fb } of pairs) {
      if (!fa && !fb) continue;
      if (fa && fb && (fa.id === fb.id || (fa.text !== null && fa.text === fb.text))) continue;
      if (files.length >= COMPARE_FILES) {
        more = true;
        break;
      }
      const status = !fa ? "A" : !fb ? "D" : "M";
      // A side that has the file without text: gitring compares only the ids.
      if ((fa && fa.text === null) || (fb && fb.text === null)) {
        files.push({ path: p, status, additions: 0, deletions: 0, diff: "", binary: true });
        continue;
      }
      const ta = fa?.text ?? null;
      const tb = fb?.text ?? null;
      const d = lineDiff(ta ?? "", tb ?? "");
      additions += d.additions;
      deletions += d.deletions;
      const diff = unifiedDiff(p, ta, tb);
      // The diff text has a limit per answer. A file over it keeps its counts, without the diff.
      if (chars + diff.length > COMPARE_CHARS) {
        left++;
        files.push({ path: p, status, additions: d.additions, deletions: d.deletions, diff: "", cut: true });
        continue;
      }
      chars += diff.length;
      files.push({ path: p, status, additions: d.additions, deletions: d.deletions, diff });
    }
    return {
      from: a.label,
      to: b.label,
      ...(path ? { path } : {}),
      files,
      additions,
      deletions,
      more,
      summary: compareWords(a.label, b.label, files.length, additions, deletions, more, left, path || undefined),
    };
  }
}
