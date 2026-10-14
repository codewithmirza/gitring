/**
 * Navigation of the code view: open a path, links, prefetch, the list of refs and finder marks.
 */
import { useCallback, useMemo } from "react";
import { isCommitId } from "../../../state/api";
import { ago, ATTEMPT_STATUS_TEXT, plural, shortSha } from "../../../state/format";
import { codeUrl, goCode } from "../links";
import type { RefOption } from "../pickers";
import { looksBinary } from "../tree";
import type { PanelState } from "./useCodePanels";
import type { CodeSource } from "./useCodeSource";
import type { FileTreeState } from "./useFileTree";
import type { OpenFileState } from "./useOpenFile";

export function useCodeNavigation(source: CodeSource, treeRows: FileTreeState, openFile: OpenFileState, panels: PanelState) {
  const { loc, narrow, client, diffMode, info, mainSha, mainFiles, workCopies, intents, landings, now } = source;
  const { files, rowMarks } = treeRows;
  const { fileRef, fileVersion } = openFile;
  const { setPhonePanel, setRefOpen, refBtn } = panels;
  const isWork = info.kind === "work";
  /* ── navigation ── */
  const openPath = useCallback(
    (p: string) => {
      goCode({ ref: loc.ref, path: p, view: loc.view });
      if (narrow) setPhonePanel("file");
    },
    [loc.ref, loc.view, narrow],
  );
  const hrefOf = useCallback((p: string) => codeUrl({ ref: loc.ref, path: p, view: loc.view }), [loc.ref, loc.view]);
  const prefetch = useCallback(
    (p: string) => {
      if (!client || !fileRef || diffMode || looksBinary(p)) return;
      void client.file(fileRef, p, { version: fileVersion || undefined, priority: "low" }).catch(() => undefined);
    },
    [client, fileRef, fileVersion, diffMode],
  );

  /* ── ref options ── */
  const refOptions = useMemo<RefOption[]>(() => {
    const out: RefOption[] = [
      {
        id: "main",
        ref: "main",
        name: "main",
        current: info.kind === "main",
        hint: (
          <span className="voice-agent">
            {shortSha(mainSha)}, {plural(mainFiles.length, "file")}
          </span>
        ),
      },
    ];
    for (const w of workCopies) {
      const n = Object.keys(w.changed).length;
      out.push({
        id: w.id,
        ref: w.id,
        name: `${w.callsign}: ${w.intentTitle}`,
        group: "Work copies",
        color: w.color,
        current: isWork && info.wc.id === w.id,
        hint: `${ATTEMPT_STATUS_TEXT[w.status]}, ${plural(n, "file")} changed`,
      });
    }
    const titles = new Map((intents ?? []).map((i) => [i.id, i.title]));
    // The newest merge is main itself: listing it again would offer the same files twice.
    const merges = landings.filter((l) => l.mainAfter !== mainSha).sort((a, b) => b.at - a.at);
    for (const l of merges.slice(0, 6)) {
      out.push({
        id: `m:${l.id}`,
        ref: l.mainAfter,
        name: `After: ${titles.get(l.intentId) ?? "a merge"}`,
        group: "Recent merges",
        current: info.kind === "commit" && info.sha === l.mainAfter,
        hint: (
          <span className="voice-agent">
            {shortSha(l.mainAfter)}, {ago(l.at, now)}
          </span>
        ),
      });
    }
    return out;
  }, [info, mainSha, mainFiles.length, workCopies, landings, intents, now, isWork]);

  const chooseRef = useCallback(
    (ref: string) => {
      setRefOpen(false);
      goCode({ ref, path: loc.path, view: ref !== "main" && !isCommitId(ref) && loc.view === "diff" ? "diff" : "code" });
      requestAnimationFrame(() => refBtn.current?.focus());
    },
    [loc.path, loc.view],
  );

  const allPaths = useMemo(() => files.map((f) => f.path), [files]);
  const finderMarks = useCallback(
    (p: string) => {
      const r = rowMarks.get(p);
      return r ? [...r.changed, ...r.planned] : [];
    },
    [rowMarks],
  );

  return { openPath, hrefOf, prefetch, refOptions, chooseRef, allPaths, finderMarks };
}

export type NavigationState = ReturnType<typeof useCodeNavigation>;
