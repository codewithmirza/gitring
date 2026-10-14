/**
 * The selected lines of the code view, the jump to a line, the flash of a mark, and the move between marks (j and k).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LineRange } from "../../../../../src/core/types";
import { goCode } from "../links";
import type { CodeSource } from "./useCodeSource";
import type { OpenFileState } from "./useOpenFile";

export function useCodeCursor(source: CodeSource, openFile: OpenFileState) {
  const { path, loc } = source;
  const { text, annos } = openFile;
  /* ── selection, jumps, j/k ── */
  const [jump, setJump] = useState<{ line: number; n: number } | null>(null);
  const [flash, setFlash] = useState<LineRange | null>(null);
  const [focusMark, setFocusMark] = useState<{ line: number; n: number } | null>(null);
  const annoAt = useRef(-1);
  const jumpTo = useCallback((line: number) => setJump((j) => ({ line, n: (j?.n ?? 0) + 1 })), []);

  // A line in the address scrolls into view once the text is there.
  const lineKey = `${path}|${loc.lines?.[0] ?? ""}`;
  const jumped = useRef("");
  useEffect(() => {
    if (!loc.lines || text?.status !== "ready" || jumped.current === lineKey) return;
    jumped.current = lineKey;
    jumpTo(loc.lines[0]);
  }, [lineKey, loc.lines, text?.status, jumpTo]);
  useEffect(() => {
    annoAt.current = -1;
    setFlash(null);
  }, [path, loc.ref]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  const selectLines = useCallback(
    (r: LineRange | null) => {
      goCode({ ref: loc.ref, path: loc.path, view: loc.view, lines: r }, { replace: true });
    },
    [loc.ref, loc.path, loc.view],
  );
  const onLines = useCallback((r: LineRange) => selectLines(r), [selectLines]);

  const moveAnno = useCallback(
    (dir: 1 | -1) => {
      if (!annos.length) return;
      let i = annoAt.current;
      if (i === -1) {
        const from = loc.lines?.[0] ?? 0;
        i = dir === 1 ? annos.findIndex((a) => a.range[0] > from) : annos.length - 1 - [...annos].reverse().findIndex((a) => a.range[0] < (from || Infinity));
        if (i < 0 || i >= annos.length) i = dir === 1 ? 0 : annos.length - 1;
      } else i = (i + dir + annos.length) % annos.length;
      annoAt.current = i;
      const a = annos[i];
      setFlash(a.range);
      jumpTo(a.range[0]);
      if (a.lane >= 0) setFocusMark((f) => ({ line: a.range[0], n: (f?.n ?? 0) + 1 }));
    },
    [annos, loc.lines, jumpTo],
  );

  return { jump, flash, setFlash, focusMark, jumpTo, selectLines, onLines, moveAnno };
}

export type CursorState = ReturnType<typeof useCodeCursor>;
