/**
 * The line selection of the code view: jumps, the flash of a mark, the j and k moves, and the line that "Why?" asks about.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LineRange } from "../../../../../src/core/types";
import { goCode } from "../links";
import { lineForWhy } from "./whyLine";
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
  // The answer of "Why line N?" or the history of the file. A click on a line number opens the first one.
  const [lineAnswer, setLineAnswer] = useState<"why" | "history" | null>(null);
  useEffect(() => setLineAnswer(null), [path, loc.ref]);
  const onLines = useCallback(
    (r: LineRange, extend: boolean) => {
      selectLines(r);
      if (!extend) setLineAnswer("why");
    },
    [selectLines],
  );

  // "Why?" with no line selected: select the line under the caret, or the first line on screen that an agent changes.
  const chooseWhyLine = useCallback(() => {
    const scroller = document.querySelector<HTMLElement>(".cv-lines");
    const n = lineForWhy(scroller, window.getSelection(), annos.map((a) => a.range));
    selectLines([n, n]);
  }, [annos, selectLines]);

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

  return { jump, flash, setFlash, focusMark, jumpTo, selectLines, onLines, lineAnswer, setLineAnswer, chooseWhyLine, moveAnno };
}

export type CursorState = ReturnType<typeof useCodeCursor>;
