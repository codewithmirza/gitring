/**
 * The keys of the code view, the links to copy or open elsewhere, and the browser tab title.
 * The keys are t, w, l, y, d, [, j and k.
 * A key does nothing while a field, a menu or a dialog has the focus, or right after the g key of the app.
 */
import { useEffect, useRef } from "react";
import { isCommitId } from "../../../state/api";
import { absoluteUrl, codeUrl, goCode } from "../links";
import { baseName } from "../tree";
import type { CursorState } from "./useCodeCursor";
import type { PanelState } from "./useCodePanels";
import type { CodeSource } from "./useCodeSource";
import type { OpenFileState } from "./useOpenFile";

export function useCodeActions(source: CodeSource, openFile: OpenFileState, cursor: CursorState, panels: PanelState) {
  const { path, loc, diffMode, narrow, info, mainSha, github, projectId, projectName } = source;
  const { text, fileRef } = openFile;
  const { moveAnno } = cursor;
  const { setFindOpen, setRefOpen, setLineOpen, setPhonePanel, phonePanel, setTreeOn, treeOn, copy } = panels;
  const isWork = info.kind === "work";
  /* ── keyboard ── */
  const keyState = useRef({ gAt: 0 });
  const handlers = useRef<Record<string, () => void>>({});
  handlers.current = {
    t: () => setFindOpen(true),
    w: () => setRefOpen(true),
    l: () => text?.status === "ready" && setLineOpen(true),
    y: () => path && copyPermalink(),
    d: () => isWork && goCode({ ref: loc.ref, path: loc.path, view: diffMode ? "code" : "diff" }),
    "[": () => (narrow ? setPhonePanel(phonePanel === "tree" ? "file" : "tree") : setTreeOn(!treeOn)),
    j: () => moveAnno(1),
    k: () => moveAnno(-1),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu'], .b-pop, .b-popover")) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "g") {
        keyState.current.gAt = Date.now();
        return;
      }
      // The letter after "g" belongs to the app's "go to" keys (g c, g t …).
      if (Date.now() - keyState.current.gAt < 1200) {
        keyState.current.gAt = 0;
        return;
      }
      const h = handlers.current[e.key];
      if (!h) return;
      e.preventDefault();
      h();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── links ── */
  const permaRef = info.kind === "main" && isCommitId(mainSha) ? mainSha : loc.ref;
  const permalink = (): string => {
    const q = new URLSearchParams(location.search);
    q.delete("view");
    if (loc.view === "diff") q.set("view", "diff");
    const s = q.toString();
    const url = codeUrl({ ref: permaRef, path: loc.path, view: loc.view, lines: loc.lines }, { search: s ? `?${s}` : "" });
    return absoluteUrl(url);
  };
  function copyPermalink() {
    copy("link", permalink());
  }
  const githubHref = (() => {
    const repo = github?.repo;
    if (!repo || !path || info.kind !== "main") return null;
    const branch = github?.mode === "pull-request" && github.branch ? github.branch : "HEAD";
    const lines = loc.lines ? (loc.lines[0] === loc.lines[1] ? `#L${loc.lines[0]}` : `#L${loc.lines[0]}-L${loc.lines[1]}`) : "";
    return `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}${lines}`;
  })();
  const rawHref = path && fileRef ? `/api/projects/${encodeURIComponent(projectId)}/file?ref=${encodeURIComponent(fileRef)}&path=${encodeURIComponent(path)}` : null;

  // The tab title names the file.
  useEffect(() => {
    if (!path) return;
    const id = requestAnimationFrame(() => {
      document.title = `${baseName(path)} · Code · ${projectName} · gitring`;
    });
    return () => cancelAnimationFrame(id);
  }, [path, projectName]);

  return { copyPermalink, githubHref, rawHref };
}

export type ActionState = ReturnType<typeof useCodeActions>;
