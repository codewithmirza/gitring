/**
 * The open file: its text, its line count, the README of a ref, the loading flags and the marks in the gutter.
 */
import { useMemo } from "react";
import { annoList, headChanges, lanesFor, marksByLine, type Lane } from "../annotations";
import { splitLines, type GutterLane } from "../CodeLines";
import { useDelayedFlag, useFileText } from "../data";
import { looksBinary } from "../tree";
import type { CodeSource } from "./useCodeSource";
import type { FileTreeState } from "./useFileTree";

export function useOpenFile(source: CodeSource, treeRows: FileTreeState) {
  const { info, path, tree, treeData, diffMode, client, retry, ownByPath, marks, mainSha, diffFiles, diff } = source;
  const { files } = treeRows;
  const isWork = info.kind === "work";
  /* ── the open file ── */
  const fileRef = info.kind === "main" || info.kind === "commit" ? info.fileRef : isWork ? info.ref : null;
  const fileVersion = info.kind === "main" || info.kind === "commit" ? info.version : isWork ? `${info.ref}@${info.wc.updatedAt}` : "";
  const inTree = path ? files.some((f) => f.path === path) : false;
  const treeReady = tree.status === "ready" || Boolean(treeData);
  const binary = Boolean(path && looksBinary(path));
  const wantText = Boolean(path) && !diffMode && !binary && (!treeReady || inTree);
  const text = useFileText(client, wantText ? fileRef : null, wantText ? path : null, fileVersion, retry);
  const readmePath = useMemo(() => (!path && info.kind === "main" ? files.find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f.path))?.path ?? null : null), [path, info.kind, files]);
  const readme = useFileText(client, readmePath ? fileRef : null, readmePath, fileVersion, retry);

  const lineCount = useMemo(() => (text?.status === "ready" ? splitLines(text.data).length : 0), [text]);
  const own = path ? ownByPath.get(path) : undefined;

  /* ── gutter marks ── */
  const lanes = useMemo<Lane[]>(() => (path && info.kind === "main" ? lanesFor(marks.get(path), mainSha) : []), [path, info.kind, marks, mainSha]);
  const head = useMemo(() => (own && isWork && !diffMode ? headChanges(own.diff) : null), [own, isWork, diffMode]);
  const gutterLanes = useMemo<GutterLane[]>(() => lanes.map((l) => ({ key: l.key, color: l.color, kind: l.kind, approx: l.approx })), [lanes]);
  const byLine = useMemo(() => marksByLine(lanes, lineCount || Infinity), [lanes, lineCount]);
  const annos = useMemo(() => {
    const list = annoList(lanes, lineCount || Infinity);
    if (head) for (const r of head.added) list.push({ key: `own:${r[0]}`, lane: -1, range: r });
    return list.sort((a, b) => a.range[0] - b.range[0]);
  }, [lanes, head, lineCount]);
  const markStarts = useMemo(() => [...new Set(annos.filter((a) => a.lane >= 0).map((a) => a.range[0]))].sort((a, b) => a - b), [annos]);

  /* ── body of the right side ── */
  const listReady = diffMode ? Boolean(diffFiles) : treeReady;
  const showTreeSkel = useDelayedFlag(!listReady && (diffMode ? diff?.status === "loading" : tree.status === "loading"));
  const showTextSkel = useDelayedFlag(text?.status === "loading");

  return {
    fileRef, fileVersion, inTree, treeReady, binary, text, readmePath, readme, lineCount, own, lanes, head, gutterLanes, byLine,
    annos, markStarts, listReady, showTreeSkel, showTextSkel,
  };
}

export type OpenFileState = ReturnType<typeof useOpenFile>;
