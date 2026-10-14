/**
 * The file tree of the code view: the rows, the open folders, the filter, and the marks on rows and folders.
 * The open folders stay in memory for each project and ref while the page lives, so back and forward keep them.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { FileNode } from "../../../../../src/core/types";
import { folderMarks as foldersOf, type FolderMarks } from "../annotations";
import { rowMarksOf, type RowMarks } from "../CodeTree";
import { allFolders, ancestors, buildTree, flattenTree, foldersToShow } from "../tree";
import { NO_FILES } from "./empty";
import type { CodeSource } from "./useCodeSource";

/** Expanded folders, kept per project and ref while the page lives (back and forward keep them). */
const expandedMemory = new Map<string, Set<string>>();

export function useFileTree(source: CodeSource) {
  const { diffMode, diffFiles, treeData, projectId, info, path, marks, commitChanged } = source;
  const isWork = info.kind === "work";
  /* ── tree rows ── */
  const files: FileNode[] = useMemo(() => {
    if (diffMode) return (diffFiles ?? []).map((f) => ({ path: f.path, size: 0, lang: "" }));
    return treeData?.files ?? NO_FILES;
  }, [diffMode, diffFiles, treeData]);
  const root = useMemo(() => buildTree(files), [files]);
  const memKey = `${projectId}|${info.kind === "work" ? info.ref : info.kind}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => expandedMemory.get(memKey) ?? new Set());
  const seeded = useRef<string | null>(null);

  // First open of a ref: open the folders of the file in the address and of the files where agents work.
  useEffect(() => {
    if (!files.length || seeded.current === memKey) return;
    seeded.current = memKey;
    const remembered = expandedMemory.get(memKey);
    if (remembered) {
      setExpanded(new Set([...remembered, ...(path ? ancestors(path) : [])]));
      return;
    }
    const open = new Set<string>(files.length <= 80 ? allFolders(root) : []);
    for (const a of path ? ancestors(path) : []) open.add(a);
    if (info.kind === "main") for (const d of foldersToShow(marks.keys())) open.add(d);
    if (isWork) for (const d of foldersToShow(Object.keys(info.wc.changed))) open.add(d);
    if (commitChanged) for (const d of foldersToShow(Object.keys(commitChanged))) open.add(d);
    setExpanded(open);
  }, [files.length, memKey, root, path, info, marks, isWork, commitChanged]);

  // A new file in the address opens its folders.
  useEffect(() => {
    if (!path) return;
    const need = ancestors(path).filter((a) => !expanded.has(a));
    if (need.length) setExpanded((s) => new Set([...s, ...need]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Remember the open folders of this ref, once they belong to it (after the first seeding).
  useEffect(() => {
    if (seeded.current === memKey) expandedMemory.set(memKey, expanded);
  }, [memKey, expanded]);

  const [filter, setFilter] = useState("");
  const dFilter = useDeferredValue(filter);
  // The diff lists only changed files: all their folders show open.
  const diffOnly = useMemo(() => (diffMode ? new Set(files.map((f) => f.path)) : null), [diffMode, files]);
  const rows = useMemo(() => flattenTree(root, expanded, { filter: dFilter, only: diffOnly }), [root, expanded, dFilter, diffOnly]);

  const onToggle = useCallback((dir: string, open?: boolean) => {
    setExpanded((s) => {
      const next = new Set(s);
      const want = open ?? !next.has(dir);
      if (want) next.add(dir);
      else next.delete(dir);
      return next;
    });
  }, []);

  /* ── marks in the tree ── */
  const rowMarks = useMemo(() => {
    const m = new Map<string, RowMarks>();
    if (info.kind === "main") {
      for (const [p, fm] of marks) {
        const r = rowMarksOf(fm);
        if (r) m.set(p, r);
      }
    } else if (isWork) {
      for (const f of diffFiles ?? []) {
        const keep = marks.get(f.path)?.keepOut.filter((k) => k.to?.id === info.wc.id).length ?? 0;
        m.set(f.path, { changed: [], planned: [], keepOut: keep, own: f.status, ownStat: { additions: f.additions, deletions: f.deletions } });
      }
      if (!diffFiles) for (const [p, t] of Object.entries(info.wc.changed)) m.set(p, { changed: [], planned: [], keepOut: 0, own: t.status });
    } else if (commitChanged) {
      for (const [p, t] of Object.entries(commitChanged)) m.set(p, { changed: [], planned: [], keepOut: 0, own: t.status, ownStat: { additions: t.additions, deletions: t.deletions } });
    }
    return m;
  }, [info, isWork, marks, diffFiles, commitChanged]);
  const fileMarks = useCallback((p: string) => rowMarks.get(p) ?? null, [rowMarks]);
  const folders = useMemo<Map<string, FolderMarks>>(() => {
    if (info.kind === "main") return foldersOf(marks);
    const color = isWork ? info.wc.color : 0;
    const out = new Map<string, FolderMarks>();
    for (const [p, r] of rowMarks) {
      if (!r.own) continue;
      for (const a of ancestors(p)) {
        const f = out.get(a) ?? { work: 1, colors: isWork ? [color] : [], keepOut: 0 };
        f.keepOut += r.keepOut;
        out.set(a, f);
      }
    }
    return out;
  }, [info, isWork, marks, rowMarks]);

  return { files, setExpanded, filter, setFilter, dFilter, rows, onToggle, rowMarks, fileMarks, folders };
}

export type FileTreeState = ReturnType<typeof useFileTree>;
