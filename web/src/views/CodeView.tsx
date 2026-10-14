/**
 * Code: the real files of main, of each active work copy and of past merges, with live marks where
 * agents work (no extra requests: the marks come from the live state).
 *
 *   left   the file tree (virtual list, filter, folders open where agents work)
 *   right  the file: line numbers, colors, soft wrap; a gutter with each agent's changed lines and the
 *          lines that change requests keep agents out of; "who works here" above the code.
 *   top    the ref switcher (w), Code | Diff for a work copy (d), Find file (t), Go to line (l),
 *          Copy link with the commit (y), the tree on or off ([), j / k between marks, Clone (members:
 *          a git clone command with a 6-hour read token).
 *
 * Address: /code/<ref>/<path>?view=diff#L10-L20 (see ./code/links). The path stays in the address,
 * so every view of a file has a link.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { FileNode, LineRange } from "../../../src/core/types";
import { Button, EmptyState, IconButton, Popover } from "../design/components";
import { Icon } from "../design/icons";
import { Link } from "../app/router";
import { openNewIntent } from "../app/ui";
import { useNow } from "../app/useNow";
import { useStore } from "../state/store";
import { useCanAct } from "../state/account";
import { isCommitId } from "../state/api";
import { ago, ATTEMPT_STATUS_TEXT, kb, plural, shortSha } from "../state/format";
import { langLabel, lineRangeText } from "./labels";
import {
  annoList,
  folderMarks as foldersOf,
  headChanges,
  lanesFor,
  marksByLine,
  selectLastMerges,
  selectMarks,
  selectWorkCopies,
  type FileMarks,
  type FolderMarks,
  type Lane,
  type LastMerge,
  type WorkCopy,
} from "./code/annotations";
import { CodeLines, splitLines, StaticCode, WRAP_MAX, type GutterLane } from "./code/CodeLines";
import { CodeTree, rowMarksOf, type RowMarks } from "./code/CodeTree";
import { AllDiffs, FileDiff } from "./code/CodeDiff";
import { lineRequester, mayRequestLines } from "../app/lineRequest";
import { CodeLink } from "./code/CodeLink";
import { resolveRef, useAttemptDiff, useDelayedFlag, useFileText, useHarbor, useTree, type RefInfo } from "./code/data";
import { languageOf } from "./code/highlight";
import { absoluteUrl, codeUrl, goCode, useCodeLocation, type CodeLocation } from "./code/links";
import { FileFinder, LinePicker, MoreMenu, RefPicker, type RefOption } from "./code/pickers";
import { CloneButton } from "./code/CloneButton";
import { LineHistory } from "./code/LineHistory";
import { allFolders, ancestors, baseName, buildTree, flattenTree, foldersToShow, looksBinary } from "./code/tree";
import type { DiffFile } from "../state/api";
import "./code/code.css";

export { codeHref } from "./code/links";

const NO_FILES: FileNode[] = [];
const NO_MARKS = new Map<string, FileMarks>();
const NO_LAST = new Map<string, LastMerge>();
const NO_WC: WorkCopy[] = [];
const NO_ATTEMPTS: never[] = [];
const NO_LANDINGS: never[] = [];

/* ───────────── small helpers ───────────── */

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* storage off */
  }
}

function useNarrow(): boolean {
  const q = "(max-width: 760px)";
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** A copy action that says "Copied" for a moment (inline, no toast). */
function useCopied(): [string | null, (key: string, text: string) => void] {
  const [done, setDone] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback((key: string, text: string) => {
    void copyText(text).then((ok) => {
      setDone(ok ? key : `${key}:fail`);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(null), 1600);
    });
  }, []);
  return [done, copy];
}

const vc = (color: number) => ({ "--vc": `var(--v${((color % 12) + 12) % 12})` }) as CSSProperties;

function Dot({ color, ring }: { color: number; ring?: boolean }) {
  return <span className={ring ? "cv-dot cv-dot--ring" : "cv-dot"} style={vc(color)} aria-hidden="true" />;
}

/** Expanded folders, kept per project and ref while the page lives (back and forward keep them). */
const expandedMemory = new Map<string, Set<string>>();

/** Lines of a hunk list for people: "lines 10–18 and 40–44". */
function rangesText(ranges: LineRange[]): string {
  if (!ranges.length) return "";
  const parts = ranges.slice(0, 3).map((r) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`));
  const more = ranges.length > 3 ? ` and ${ranges.length - 3} more` : "";
  return `${ranges.length === 1 && ranges[0][0] === ranges[0][1] ? "line" : "lines"} ${parts.join(", ")}${more}`;
}

/* ───────────── marks under a line (popover content) ───────────── */

function MarkCard({ lanes, line, path, now }: { lanes: Lane[]; line: number; path: string; now: number }) {
  const here = lanes.filter((l) => l.ranges.some((r) => line >= Math.min(r[0], r[1]) && line <= Math.max(r[0], r[1])));
  if (!here.length) return <p className="cv-markcard__none">No agent works on line {line}.</p>;
  return (
    <div className="cv-markcard">
      {here.map((l) => {
        const range = l.ranges.find((r) => line >= Math.min(r[0], r[1]) && line <= Math.max(r[0], r[1]))!;
        if (l.kind === "keepout" && l.keep) {
          const k = l.keep;
          return (
            <section key={l.key} className="cv-markcard__item is-keep">
              <p className="cv-markcard__title">
                <span className="cv-keep" aria-hidden="true" /> Change request to <strong>{k.to?.callsign ?? "an agent"}</strong>
              </p>
              <p>
                Keep out of {lineRangeText(range)}.{k.from ? ` ${k.from.callsign} changes these lines.` : ""}
              </p>
              <p className="cv-markcard__msg voice-agent">{k.correction.message}</p>
              <p className="cv-markcard__meta">
                {k.correction.status === "acknowledged" ? "The agent acknowledged it" : k.correction.status === "closed" ? "Closed at merge" : k.correction.status === "delivered" ? "Sent to the agent" : "Waiting to go to the agent"} ·{" "}
                {ago(k.correction.createdAt, now)}
              </p>
              <div className="cv-markcard__actions">
                {k.to && (
                  <Link className="b-btn b-btn--secondary b-btn--sm" to={`/tasks/${encodeURIComponent(k.to.intentId)}`}>
                    Open the task
                  </Link>
                )}
                {k.from && (
                  <CodeLink className="b-btn b-btn--ghost b-btn--sm" to={{ ref: k.from.id, path, view: "diff" }}>
                    Show the change of {k.from.callsign}
                  </CodeLink>
                )}
              </div>
            </section>
          );
        }
        const wc = l.wc!;
        return (
          <section key={l.key} className="cv-markcard__item">
            <p className="cv-markcard__title">
              <Dot color={wc.color} /> <strong>{wc.callsign}</strong> changes {lineRangeText(range)}
            </p>
            <p className="voice-human cv-markcard__task">{wc.intentTitle}</p>
            {l.approx && <p className="cv-markcard__note">These line numbers are on the base of its work copy. Main moved since then, so they can be a little off.</p>}
            {wc.approach && <p className="cv-markcard__msg voice-agent">{wc.approach}</p>}
            <p className="cv-markcard__meta">
              {ATTEMPT_STATUS_TEXT[wc.status]} · updated {ago(wc.updatedAt, now)}
            </p>
            <div className="cv-markcard__actions">
              <CodeLink className="b-btn b-btn--secondary b-btn--sm" to={{ ref: wc.id, path, view: "diff" }}>
                Show the change
              </CodeLink>
              <Link className="b-btn b-btn--ghost b-btn--sm" to={`/overview?v=${encodeURIComponent(wc.id)}`}>
                Open the work copy
              </Link>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ───────────── who works on this file ───────────── */

function ContextStrip({
  info,
  path,
  fm,
  last,
  own,
  onShowLines,
  now,
}: {
  info: RefInfo;
  path: string;
  fm: FileMarks | undefined;
  last: LastMerge | undefined;
  own: DiffFile | undefined;
  onShowLines: (r: LineRange) => void;
  now: number;
}) {
  const [all, setAll] = useState(false);
  const items: { key: string; node: ReactNode }[] = [];
  if (info.kind === "work") {
    const wc = info.wc;
    items.push({
      key: "self",
      node: (
        <>
          <Dot color={wc.color} />
          <span>
            {own ? (
              <>
                <strong>{wc.callsign}</strong> {own.status === "A" ? "adds" : own.status === "D" ? "deletes" : "changes"} this file{" "}
                <span className="voice-agent">
                  <span className="cv-plus">+{own.additions}</span> <span className="cv-minus">−{own.deletions}</span>
                </span>
              </>
            ) : (
              <>
                <strong>{wc.callsign}</strong> does not change this file
              </>
            )}{" "}
            for <span className="voice-human">{wc.intentTitle}</span>
          </span>
        </>
      ),
    });
  }
  for (const w of fm?.work ?? []) {
    if (info.kind === "work" && w.wc.id === info.wc.id) continue;
    const hunks = w.touch?.hunks ?? [];
    items.push({
      key: `w:${w.wc.id}`,
      node: (
        <>
          <Dot color={w.wc.color} ring={!w.touch} />
          <span>
            <strong>{w.wc.callsign}</strong>{" "}
            {w.touch ? (hunks.length ? `changes ${rangesText(hunks)}` : w.touch.status === "A" ? "adds this file" : w.touch.status === "D" ? "deletes this file" : "changes this file") : "plans to change this file"}
            {info.kind === "work" ? " too" : ""} · <span className="voice-human">{w.wc.intentTitle}</span> · {ATTEMPT_STATUS_TEXT[w.wc.status]}
          </span>
          <span className="cv-ctx__acts">
            {w.touch && (
              <CodeLink to={{ ref: w.wc.id, path, view: "diff" }} className="cv-ctx__act">
                Show the change
              </CodeLink>
            )}
            <Link to={`/overview?v=${encodeURIComponent(w.wc.id)}`} className="cv-ctx__act">
              Work copy
            </Link>
          </span>
        </>
      ),
    });
  }
  for (const k of fm?.keepOut ?? []) {
    items.push({
      key: `k:${k.correction.id}:${k.lines[0]}`,
      node: (
        <>
          <span className="cv-keep" aria-hidden="true" />
          <span>
            Change request to <strong>{k.to?.callsign ?? "an agent"}</strong>: keep out of {lineRangeText(k.lines)}
            {k.from ? `. ${k.from.callsign} changes them.` : "."}
          </span>
          <span className="cv-ctx__acts">
            {info.kind !== "work" && (
              <button type="button" className="cv-ctx__act cv-linkbtn" onClick={() => onShowLines(k.lines)}>
                Show the lines
              </button>
            )}
            {k.to && (
              <Link to={`/tasks/${encodeURIComponent(k.to.intentId)}`} className="cv-ctx__act">
                Task
              </Link>
            )}
          </span>
        </>
      ),
    });
  }
  if (last && info.kind === "main") {
    items.push({
      key: "last",
      node: (
        <>
          <Icon name="anchor" size={12} />
          <span>
            Last merge: <span className="voice-human">{last.intentTitle}</span>
            {last.callsign ? ` by ${last.callsign}` : ""} · {ago(last.landing.at, now)}
          </span>
          <span className="cv-ctx__acts">
            <Link to={`/history/${encodeURIComponent(last.landing.id)}`} className="cv-ctx__act">
              Merge record
            </Link>
          </span>
        </>
      ),
    });
  }
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 3);
  return (
    <div className="cv-ctx">
      <h2 className="vh">Who works on this file</h2>
      <ul className="cv-ctx__list" role="list">
        {shown.map((it) => (
          <li key={it.key} className="cv-ctx__item">
            {it.node}
          </li>
        ))}
      </ul>
      {items.length > 3 && (
        <button type="button" className="cv-linkbtn cv-ctx__more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show ${items.length - 3} more`}
        </button>
      )}
    </div>
  );
}

/* ───────────── loading shapes ───────────── */

function LinesSkeleton({ rows = 18 }: { rows?: number }) {
  return (
    <div className="cv-skel" role="status" aria-label="Loading the file">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="cv-skel__line" style={{ width: `${18 + ((i * 37) % 60)}%`, marginLeft: `${(i % 4) * 2}ch` }} />
      ))}
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div className="cv-skel cv-skel--tree" role="status" aria-label="Loading the files">
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className="cv-skel__line" style={{ width: `${40 + ((i * 29) % 45)}%`, marginLeft: `${(i % 3) * 14}px` }} />
      ))}
    </div>
  );
}

/* ───────────── the view ───────────── */

export function CodeView() {
  const loc = useCodeLocation();
  const client = useHarbor();
  const now = useNow(30_000);
  const narrow = useNarrow();
  const canAct = useCanAct();

  const projectId = useStore((s) => s.projectId);
  const projectName = useStore((s) => s.state?.project.name ?? "the project");
  const mainSha = useStore((s) => s.state?.project.mainSha ?? "");
  const mainFiles = useStore((s) => s.state?.files ?? NO_FILES);
  const importing = useStore((s) => s.state?.project.importing ?? null);
  const github = useStore((s) => s.state?.project.settings?.github ?? null);
  const attempts = useStore((s) => s.state?.attempts ?? NO_ATTEMPTS);
  const landings = useStore((s) => s.state?.landings ?? NO_LANDINGS);
  const intents = useStore((s) => s.state?.intents);
  const workCopies = useStore((s) => (s.state ? selectWorkCopies(s.state) : NO_WC));
  const marks = useStore((s) => (s.state ? selectMarks(s.state) : NO_MARKS));
  const lastMerges = useStore((s) => (s.state ? selectLastMerges(s.state) : NO_LAST));

  const info = useMemo(() => resolveRef(loc.ref, mainSha, attempts, workCopies), [loc.ref, mainSha, attempts, workCopies]);
  const isWork = info.kind === "work";
  const diffMode = isWork && loc.view === "diff";
  const path = loc.path;

  const [retry, setRetry] = useState(0);
  const tree = useTree(client, info, mainFiles, retry);
  const treeData = tree.data;
  const workVersion = isWork ? info.wc.updatedAt : 0;
  const diff = useAttemptDiff(client, isWork ? info.ref : null, workVersion, retry);
  const diffFiles = diff?.status === "ready" ? diff.data.files : diff?.data?.files;
  const ownByPath = useMemo(() => new Map((diffFiles ?? []).map((f) => [f.path, f])), [diffFiles]);

  /* ── the commit of a merge (from History links) ── */
  const mergeOfCommit = useMemo(() => (info.kind === "commit" || info.kind === "main" ? landings.find((l) => l.mainAfter === info.sha) : undefined), [info, landings]);
  const commitChanged = useMemo(() => {
    if (!mergeOfCommit) return null;
    const a = attempts.find((x) => x.id === mergeOfCommit.attemptId);
    return a ? a.footprint?.files ?? {} : null;
  }, [mergeOfCommit, attempts]);

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
            {shortSha(mainSha)} · {plural(mainFiles.length, "file")}
          </span>
        ),
      },
    ];
    for (const w of workCopies) {
      const n = Object.keys(w.changed).length;
      out.push({
        id: w.id,
        ref: w.id,
        name: `${w.callsign} · ${w.intentTitle}`,
        group: "Work copies",
        color: w.color,
        current: isWork && info.wc.id === w.id,
        hint: `${ATTEMPT_STATUS_TEXT[w.status]} · ${plural(n, "file")} changed`,
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
            {shortSha(l.mainAfter)} · {ago(l.at, now)}
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

  /* ── labels ── */
  const refLabel: ReactNode =
    info.kind === "main" ? (
      <>
        <span className="cv-dot cv-dot--main" aria-hidden="true" />
        <span className="cv-refbtn__name">main</span>
        <span className="cv-refbtn__sha voice-agent">{shortSha(mainSha)}</span>
      </>
    ) : info.kind === "work" ? (
      <>
        <Dot color={info.wc.color} />
        <span className="cv-refbtn__name">{info.wc.callsign}</span>
        <span className="cv-refbtn__sha voice-human">{info.wc.intentTitle}</span>
      </>
    ) : info.kind === "commit" ? (
      <>
        <Icon name="commit" size={14} />
        <span className="cv-refbtn__name">commit</span>
        <span className="cv-refbtn__sha voice-agent">{shortSha(info.sha)}</span>
      </>
    ) : (
      <>
        <Icon name="info" size={14} />
        <span className="cv-refbtn__name voice-agent">{shortSha(loc.ref, 12)}</span>
      </>
    );
  const refText = info.kind === "main" ? `main ${shortSha(mainSha)}` : info.kind === "work" ? `the work copy of ${info.wc.callsign}` : info.kind === "commit" ? `commit ${shortSha(info.sha)}` : loc.ref;
  /** The version that "Why line N?" asks about. */
  const whyRef = info.kind === "work" ? info.ref : info.kind === "commit" ? info.sha : "main";

  // A member asks the agent of an active work copy to change lines of its diff.
  const askAgent = info.kind === "work" && canAct && mayRequestLines(info.attempt) ? lineRequester(projectId, info.attempt.id, info.wc.callsign) : undefined;

  /* ── body of the right side ── */
  const listReady = diffMode ? Boolean(diffFiles) : treeReady;
  const showTreeSkel = useDelayedFlag(!listReady && (diffMode ? diff?.status === "loading" : tree.status === "loading"));
  const showTextSkel = useDelayedFlag(text?.status === "loading");

  let main: ReactNode;
  if (info.kind === "ended") {
    const merged = info.attempt.status === "landed";
    main = (
      <EmptyState
        text={merged ? `This work copy merged ${info.attempt.landedAt ? ago(info.attempt.landedAt, now) : "earlier"}. Its changes are on main now.` : "This work copy stopped. Its changes did not merge."}
        action={
          <CodeLink className="b-btn b-btn--primary" to={{ ref: "main", path: loc.path }}>
            Open main
          </CodeLink>
        }
      />
    );
  } else if (info.kind === "unknown") {
    main = (
      <EmptyState
        text="gitring does not know this ref. It is not main, an active work copy or a commit of this project."
        action={
          <CodeLink className="b-btn b-btn--primary" to={{ ref: "main", path: loc.path }}>
            Open main
          </CodeLink>
        }
      />
    );
  } else if (info.kind === "main" && importing && !mainFiles.length) {
    main = <EmptyState text={importing.error ? `The import did not finish: ${importing.error}` : "gitring imports the repository. The files show here when the import ends."} />;
  } else if (info.kind === "main" && !mainFiles.length) {
    main = (
      <EmptyState
        text="Main has no files yet. Write a task. Agents write the first files."
        action={
          canAct ? (
            <Button variant="primary" icon="plus" onClick={() => openNewIntent()}>
              Write a task
            </Button>
          ) : undefined
        }
      />
    );
  } else if (tree.status === "error" && !treeData) {
    main = (
      <EmptyState
        text={`gitring could not load the files of ${refText}. ${tree.error}`}
        action={
          <Button icon="reload" onClick={() => setRetry((r) => r + 1)}>
            Try again
          </Button>
        }
      />
    );
  } else if (diffMode) {
    if (!diff || diff.status === "loading") main = <LinesSkeleton rows={14} />;
    else if (diff.status === "error")
      main = (
        <EmptyState
          text={`gitring could not load the changes. ${diff.error}`}
          action={
            <Button icon="reload" onClick={() => setRetry((r) => r + 1)}>
              Try again
            </Button>
          }
        />
      );
    else if (path) {
      const f = ownByPath.get(path);
      main = f ? (
        <div className="cv-scroll">
          <FileDiff file={f} open={{ ref: loc.ref, path, view: "code" }} onRequest={askAgent} />
        </div>
      ) : (
        <EmptyState
          text={`${info.kind === "work" ? info.wc.callsign : "This work copy"} does not change ${baseName(path)}.`}
          action={
            <CodeLink className="b-btn b-btn--secondary" to={{ ref: loc.ref, view: "diff" }}>
              Show all changes
            </CodeLink>
          }
        />
      );
    } else
      main = (
        <div className="cv-scroll">
          <AllDiffs files={diff.data.files} openOf={(p) => ({ ref: loc.ref, path: p, view: "code" })} onRequest={askAgent} />
        </div>
      );
  } else if (!path) {
    main = <RefOverview info={info} marks={marks} readme={readme} readmePath={readmePath} now={now} commitChanged={commitChanged} mergeTitle={mergeOfCommit ? intents?.find((i) => i.id === mergeOfCommit.intentId)?.title : undefined} diffFiles={diffFiles} />;
  } else if (binary) {
    main = <EmptyState text={`gitring does not show binary files${files.find((f) => f.path === path)?.size ? ` (${kb(files.find((f) => f.path === path)!.size)})` : ""}.`} />;
  } else if (treeReady && !inTree) {
    main = (
      <EmptyState
        text={`${baseName(path)} is not on ${refText}. It was deleted or moved, or it does not exist yet.`}
        action={
          info.kind !== "main" ? (
            <CodeLink className="b-btn b-btn--secondary" to={{ ref: "main", path }}>
              Look on main
            </CodeLink>
          ) : undefined
        }
      />
    );
  } else if (!text || text.status === "loading") {
    main = showTextSkel ? <LinesSkeleton /> : <div className="cv-wait" aria-busy="true" />;
  } else if (text.status === "error") {
    main =
      text.code === 404 ? (
        <EmptyState text="gitring does not show this file. It is binary or very large." />
      ) : (
        <EmptyState
          text={`gitring could not load this file. ${text.error}`}
          action={
            <Button icon="reload" onClick={() => setRetry((r) => r + 1)}>
              Try again
            </Button>
          }
        />
      );
  } else {
    main = (
      <CodeLines
        text={text.data}
        info={languageOf(path)}
        label={`${path}, ${plural(lineCount, "line")}`}
        wrap={wrap}
        lanes={gutterLanes}
        byLine={byLine}
        head={head}
        selected={loc.lines}
        flash={flash}
        onLines={onLines}
        onMark={onMark}
        jump={jump}
        markStarts={markStarts}
        focusMark={focusMark}
      />
    );
  }

  const fileSize = path ? files.find((f) => f.path === path)?.size : undefined;
  const crumbs = path ? path.split("/") : [];

  return (
    <div className={["cv", showTree ? "has-tree" : "no-tree", narrow ? "is-narrow" : ""].join(" ")} data-panel={narrow ? phonePanel : undefined}>
      <h1 className="vh" tabIndex={-1}>
        Code of {projectName}
        {path ? `: ${path}` : ""}
      </h1>

      <div className="cv-bar" role="toolbar" aria-label="Code">
        <button
          type="button"
          className="cv-iconbtn cv-bar__files"
          aria-pressed={showTree}
          aria-label={showTree ? "Hide the files" : "Show the files"}
          title={narrow ? "Files" : "Show or hide the files ( [ )"}
          onClick={() => (narrow ? setPhonePanel(phonePanel === "tree" ? "file" : "tree") : setTreeOn(!treeOn))}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M2 2.75h12v10.5H2Z M6 2.75v10.5" />
          </svg>
          {narrow && <span>Files</span>}
        </button>

        <button
          ref={refBtn}
          type="button"
          className="cv-refbtn"
          aria-haspopup="dialog"
          aria-expanded={refOpen}
          aria-label={`Ref: ${refText}. Switch to main or a work copy.`}
          onClick={() => setRefOpen(!refOpen)}
        >
          {refLabel}
          <Icon name="chevron-down" size={12} />
        </button>
        <RefPicker anchor={refBtn.current} open={refOpen} onClose={() => setRefOpen(false)} options={refOptions} onChoose={chooseRef} />

        {isWork && (
          <div className="cv-seg" role="group" aria-label="Show the code or the changes (d)">
            <CodeLink aria-current={!diffMode ? "true" : undefined} className="cv-seg__opt" to={{ ref: loc.ref, path: loc.path, view: "code" }} replace>
              Code
            </CodeLink>
            <CodeLink aria-current={diffMode ? "true" : undefined} className="cv-seg__opt" to={{ ref: loc.ref, path: loc.path, view: "diff" }} replace>
              Diff
            </CodeLink>
          </div>
        )}

        <button ref={findBtn} type="button" className="cv-findbtn" aria-haspopup="dialog" aria-expanded={findOpen} onClick={() => setFindOpen(!findOpen)}>
          <Icon name="filter" size={14} />
          <span className="cv-findbtn__text">Find file</span>
          <kbd className="b-kbd">t</kbd>
        </button>
        <FileFinder
          anchor={findBtn.current}
          open={findOpen}
          onClose={() => setFindOpen(false)}
          paths={allPaths}
          marks={finderMarks}
          onChoose={(p, newTab) => {
            setFindOpen(false);
            if (newTab) window.open(hrefOf(p), "_blank", "noopener");
            else openPath(p);
          }}
        />

        <span className="cv-bar__meta">
          {diffMode && diffFiles
            ? `${plural(diffFiles.length, "file")} changed`
            : treeReady
              ? `${plural(files.length, "file")}`
              : ""}
        </span>
        {canAct && projectId && !importing && <CloneButton project={projectId} />}
      </div>

      <div className="cv-body">
        <aside className="cv-tree" aria-label="Files" hidden={!showTree}>
          <div className="cv-tree__head">
            <label className="vh" htmlFor="cv-filter">
              Filter the files
            </label>
            <input
              id="cv-filter"
              className="b-input cv-tree__filter"
              type="search"
              placeholder="Filter files"
              autoComplete="off"
              spellCheck={false}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && filter) {
                  e.stopPropagation();
                  setFilter("");
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  (e.currentTarget.closest(".cv-tree")?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? null)?.focus();
                }
              }}
            />
            <IconButton icon="minus" label="Close all folders" size="sm" onClick={() => setExpanded(new Set(path ? ancestors(path) : []))} />
          </div>
          {showTreeSkel ? (
            <TreeSkeleton />
          ) : (
            <CodeTree
              rows={rows}
              selectedPath={path}
              fileMarks={fileMarks}
              folderMarks={folders}
              onToggle={onToggle}
              onOpen={openPath}
              hrefOf={hrefOf}
              onPrefetch={diffMode ? undefined : prefetch}
              label={diffMode ? "Changed files" : `Files of ${refText}`}
              revealKey={loc.ref}
              emptyText={!listReady ? "" : dFilter ? `No file matches “${dFilter}”.` : diffMode ? "No changes yet." : "No files."}
            />
          )}
          <p className="cv-keys" aria-hidden="true">
            <kbd className="b-kbd">t</kbd> find <kbd className="b-kbd">w</kbd> ref <kbd className="b-kbd">l</kbd> line <kbd className="b-kbd">y</kbd> link <kbd className="b-kbd">j</kbd>
            <kbd className="b-kbd">k</kbd> marks
          </p>
        </aside>

        <section className="cv-main" aria-label={path ? `File ${path}` : "Files"}>
          {path && !diffMode && info.kind !== "ended" && info.kind !== "unknown" && (
            <header className="cv-filehead">
              <nav className="cv-crumbs voice-agent" aria-label="Path">
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  const dir = crumbs.slice(0, i + 1).join("/");
                  return (
                    <span key={dir} className="cv-crumbs__part">
                      {last ? (
                        <span aria-current="page" className="cv-crumbs__file">
                          {c}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="cv-crumbs__dir"
                          onClick={() => {
                            setExpanded((s) => new Set([...s, ...ancestors(`${dir}/x`)]));
                            if (narrow) setPhonePanel("tree");
                            else setTreeOn(true);
                          }}
                          title={`Show ${dir} in the files`}
                        >
                          {c}
                        </button>
                      )}
                      {!last && <span className="cv-crumbs__sep" aria-hidden="true">/</span>}
                    </span>
                  );
                })}
              </nav>
              <span className="cv-filehead__meta">
                {text?.status === "ready" && (
                  <button ref={lineBtn} type="button" className="cv-metabtn" aria-haspopup="dialog" aria-expanded={lineOpen} onClick={() => setLineOpen(!lineOpen)} title="Go to a line (l)">
                    {plural(lineCount, "line")}
                  </button>
                )}
                {fileSize ? <span>{kb(fileSize)}</span> : null}
                <span>{langLabel(undefined, path)}</span>
                <span className="cv-copied" role="status" aria-live="polite">
                  {copied === "path" ? "Path copied" : copied === "file" ? "File copied" : copied === "link" ? "Link copied" : copied?.endsWith(":fail") ? "Copying did not work. Select the text and copy it." : ""}
                </span>
              </span>
              <LinePicker
                anchor={lineBtn.current}
                open={lineOpen}
                onClose={() => setLineOpen(false)}
                max={Math.max(1, lineCount)}
                onGo={(r) => {
                  setLineOpen(false);
                  selectLines(r);
                  setFlash(r);
                  jumpTo(r[0]);
                }}
              />
              <span className="cv-filehead__acts">
                <LineHistory projectId={projectId} refName={whyRef} path={path} line={loc.lines?.[0] ?? null} version={fileVersion} now={now} />
                <button
                  type="button"
                  className="cv-tool"
                  aria-pressed={wrap && lineCount <= WRAP_MAX}
                  aria-disabled={lineCount > WRAP_MAX || undefined}
                  title={lineCount > WRAP_MAX ? `Soft wrap is off for files over ${WRAP_MAX.toLocaleString("en-US")} lines.` : "Wrap long lines"}
                  onClick={() => lineCount <= WRAP_MAX && setWrap(!wrap)}
                >
                  Wrap
                </button>
                <button type="button" className="cv-tool" onClick={copyPermalink} title="Copy a link with the commit (y)">
                  Copy link
                </button>
                {githubHref && !narrow && (
                  <a className="cv-tool" href={githubHref} target="_blank" rel="noopener noreferrer">
                    Open on GitHub
                  </a>
                )}
                <MoreMenu
                  actions={[
                    { key: "line", label: "Go to line", keys: "l", disabled: text?.status !== "ready", onSelect: () => setLineOpen(true) },
                    { key: "path", label: "Copy path", onSelect: () => copy("path", path) },
                    { key: "file", label: "Copy file", disabled: text?.status !== "ready", onSelect: () => text?.status === "ready" && copy("file", text.data) },
                    ...(rawHref ? [{ key: "raw", label: "Open raw text", href: rawHref, external: true }] : []),
                    ...(githubHref && narrow ? [{ key: "gh", label: "Open on GitHub", href: githubHref, external: true }] : []),
                  ]}
                />
              </span>
            </header>
          )}
          {path && !diffMode && (info.kind === "main" || info.kind === "work") && (
            <ContextStrip info={info} path={path} fm={marks.get(path)} last={lastMerges.get(path)} own={own} onShowLines={(r) => { selectLines(r); setFlash(r); jumpTo(r[0]); }} now={now} />
          )}
          {main}
        </section>
      </div>

      <Popover anchor={markAt?.el ?? null} open={Boolean(markAt)} onClose={() => setMarkAt(null)} label={`Who works on line ${markAt?.line ?? ""}`} align="start">
        {markAt && path && <MarkCard lanes={lanes} line={markAt.line} path={path} now={now} />}
      </Popover>
    </div>
  );
}

/* ───────────── a ref without a file ───────────── */

function RefOverview({
  info,
  marks,
  readme,
  readmePath,
  now,
  commitChanged,
  mergeTitle,
  diffFiles,
}: {
  info: RefInfo;
  marks: Map<string, FileMarks>;
  readme: ReturnType<typeof useFileText>;
  readmePath: string | null;
  now: number;
  commitChanged: Record<string, { status: "A" | "M" | "D"; additions: number; deletions: number }> | null;
  mergeTitle?: string;
  diffFiles?: DiffFile[];
}) {
  if (info.kind === "work") {
    const wc = info.wc;
    const changed = diffFiles ?? Object.entries(wc.changed).map(([path, t]) => ({ path, status: t.status, additions: t.additions, deletions: t.deletions, diff: "" }));
    return (
      <div className="cv-scroll">
        <article className="cv-over">
          <p className="cv-over__eyebrow">
            <Dot color={wc.color} /> Work copy of <strong>{wc.callsign}</strong> · {ATTEMPT_STATUS_TEXT[wc.status]} · updated {ago(wc.updatedAt, now)}
          </p>
          <h2 className="cv-over__title voice-human">{wc.intentTitle}</h2>
          {wc.approach && <p className="cv-over__approach voice-agent">{wc.approach}</p>}
          {wc.plan.length > 0 && (
            <ol className="cv-over__plan voice-agent">
              {wc.plan.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          )}
          <h3 className="cv-over__h">Changed files</h3>
          {changed.length ? (
            <ul className="cv-over__files" role="list">
              {changed.map((f) => (
                <li key={f.path}>
                  <span className={`cv-own cv-own--${f.status}`} aria-hidden="true">
                    {f.status}
                  </span>
                  <CodeLink to={{ ref: info.ref, path: f.path, view: "diff" }} className="voice-agent">
                    {f.path}
                  </CodeLink>
                  <span className="voice-agent cv-over__stat">
                    <span className="cv-plus">+{f.additions}</span> <span className="cv-minus">−{f.deletions}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cv-note">No changes yet. The plan names {plural(wc.planned.length, "file")}.</p>
          )}
          <div className="cv-over__acts">
            {changed.length > 0 && (
              <CodeLink className="b-btn b-btn--primary" to={{ ref: info.ref, view: "diff" }}>
                Show all changes
              </CodeLink>
            )}
            <Link className="b-btn b-btn--ghost" to={`/tasks/${encodeURIComponent(wc.intentId)}`}>
              Open the task
            </Link>
          </div>
        </article>
      </div>
    );
  }
  const working = [...marks.entries()]
    .filter(([, fm]) => fm.work.length || fm.keepOut.length)
    .sort((a, b) => b[1].work.length - a[1].work.length || a[0].localeCompare(b[0]))
    .slice(0, 12);
  const mergeFiles = commitChanged && (
    <ul className="cv-over__files" role="list">
      {Object.entries(commitChanged).map(([p, t]) => (
        <li key={p}>
          <span className={`cv-own cv-own--${t.status}`} aria-hidden="true">
            {t.status}
          </span>
          {t.status === "D" ? (
            <span className="voice-agent">{p}</span>
          ) : (
            <CodeLink to={{ ref: info.kind === "commit" ? info.ref : "main", path: p }} className="voice-agent">
              {p}
            </CodeLink>
          )}
          <span className="vh">{t.status === "A" ? ", added" : t.status === "D" ? ", deleted" : ", changed"}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="cv-scroll">
      <article className="cv-over">
        {info.kind === "commit" ? (
          <>
            <p className="cv-over__eyebrow">
              <Icon name="commit" size={12} /> Commit {shortSha(info.sha)} · an earlier state of main
            </p>
            <h2 className="cv-over__title">{mergeTitle ? <>Main after “<span className="voice-human">{mergeTitle}</span>”</> : "Files of this commit"}</h2>
            {mergeFiles}
          </>
        ) : (
          <>
            <h2 className="cv-over__h">Where agents work</h2>
            {working.length ? (
              <ul className="cv-over__files" role="list">
                {working.map(([p, fm]) => (
                  <li key={p}>
                    <span className="cv-over__dots" aria-hidden="true">
                      {fm.work.slice(0, 3).map((w) => (
                        <Dot key={w.wc.id} color={w.wc.color} ring={!w.touch} />
                      ))}
                      {fm.keepOut.length > 0 && <span className="cv-keep" />}
                    </span>
                    <CodeLink to={{ ref: "main", path: p }} className="voice-agent">
                      {p}
                    </CodeLink>
                    <span className="cv-over__who">
                      {fm.work.map((w) => `${w.wc.callsign}${w.touch ? "" : " (plan)"}`).join(", ")}
                      {fm.keepOut.length ? ` · ${plural(fm.keepOut.length, "change request")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cv-note">No agent works on main now. Choose a file, or press t to find one.</p>
            )}
            {mergeTitle && commitChanged && (
              <>
                <h2 className="cv-over__h">
                  Last merge: <span className="voice-human">{mergeTitle}</span>
                </h2>
                {mergeFiles}
              </>
            )}
          </>
        )}
        {readmePath && readme && (
          <section className="cv-readme" aria-label={readmePath}>
            <h3 className="cv-over__h voice-agent">{readmePath}</h3>
            {readme.status === "ready" ? (
              <StaticCode text={readme.data} info={languageOf(readmePath)} />
            ) : readme.status === "error" ? (
              <p className="cv-note">gitring could not load {readmePath}.</p>
            ) : (
              <LinesSkeleton rows={6} />
            )}
          </section>
        )}
      </article>
    </div>
  );
}
