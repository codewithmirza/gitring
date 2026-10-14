/**
 * The small state of the toolbar and panels: popovers, soft wrap, tree on or off, phone panel, copy notice.
 * Wrap and tree stay in local storage, so they survive a reload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readFlag, useCopied, writeFlag } from "./browser";
import type { CodeSource } from "./useCodeSource";

export function useCodePanels(source: CodeSource) {
  const { path, narrow } = source;
  /* ── popovers ── */
  const refBtn = useRef<HTMLButtonElement | null>(null);
  const findBtn = useRef<HTMLButtonElement | null>(null);
  const lineBtn = useRef<HTMLButtonElement | null>(null);
  const [refOpen, setRefOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [markAt, setMarkAt] = useState<{ line: number; el: HTMLElement } | null>(null);
  const onMark = useCallback((line: number, el: HTMLElement) => setMarkAt({ line, el }), []);

  /* ── panels ── */
  const [wrap, setWrapState] = useState(() => readFlag("gitring.code.wrap", typeof matchMedia !== "undefined" && matchMedia("(max-width: 760px)").matches));
  const setWrap = (v: boolean) => {
    setWrapState(v);
    writeFlag("gitring.code.wrap", v);
  };
  const [treeOn, setTreeOnState] = useState(() => readFlag("gitring.code.tree", true));
  const setTreeOn = (v: boolean) => {
    setTreeOnState(v);
    writeFlag("gitring.code.tree", v);
  };
  // Phones show the tree or the file. A file in the address shows the file.
  const [phonePanel, setPhonePanel] = useState<"tree" | "file">(path ? "file" : "tree");
  useEffect(() => {
    if (path) setPhonePanel("file");
  }, [path]);
  const showTree = narrow ? phonePanel === "tree" : treeOn;

  const [copied, copy] = useCopied();

  return {
    refBtn, findBtn, lineBtn, refOpen, setRefOpen, findOpen, setFindOpen, lineOpen, setLineOpen, markAt, setMarkAt, onMark, wrap,
    setWrap, treeOn, setTreeOn, phonePanel, setPhonePanel, showTree, copied, copy,
  };
}

export type PanelState = ReturnType<typeof useCodePanels>;
