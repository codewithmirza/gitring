/**
 * Data for the code view: the files of a ref and the text of one file.
 *
 *   - main needs no request for its tree: the live state has the files of main.
 *   - A commit's tree and files never change, so they come from memory after the first read.
 *   - A work copy's tree loads once, then again (with If-None-Match) only when the live state says
 *     that the work copy changed.
 *   - Every request aborts when the view closes or the ref or file changes.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Attempt, FileNode } from "../../../../src/core/types";
import { harborOrNull, isAbort, isCommitId, onHarbor, type DiffResult, type HarborClient } from "../../state/api";
import { HttpError } from "../../state/http";
import type { WorkCopy } from "./annotations";

export function useHarbor(): HarborClient | null {
  return useSyncExternalStore(onHarbor, harborOrNull, harborOrNull);
}

export type RefInfo =
  | { kind: "main"; ref: string; sha: string; fileRef: string; version: string }
  | { kind: "commit"; ref: string; sha: string; fileRef: string; version: string }
  | { kind: "work"; ref: string; wc: WorkCopy; attempt: Attempt; fileRef: string }
  | { kind: "ended"; ref: string; attempt: Attempt }
  | { kind: "unknown"; ref: string };

/** What a ref in the address is, from the live state. */
export function resolveRef(ref: string, mainSha: string, attempts: readonly Attempt[], workCopies: readonly WorkCopy[]): RefInfo {
  const fileRefOfMain = isCommitId(mainSha) ? mainSha : "main";
  if (ref === "main" || ref === "" || (mainSha && ref === mainSha)) return { kind: "main", ref: ref || "main", sha: mainSha, fileRef: fileRefOfMain, version: mainSha };
  if (isCommitId(ref)) return { kind: "commit", ref, sha: ref, fileRef: ref, version: ref };
  const wc = workCopies.find((w) => w.id === ref);
  const attempt = attempts.find((a) => a.id === ref);
  if (wc && attempt) return { kind: "work", ref, wc, attempt, fileRef: ref };
  if (attempt) return { kind: "ended", ref, attempt };
  return { kind: "unknown", ref };
}

export type Loaded<T> =
  | { status: "loading"; data?: T }
  | { status: "ready"; data: T }
  | { status: "error"; error: string; code: number; data?: T };

const msg = (e: unknown) => (e instanceof Error ? e.message : "gitring could not load this. Try again.");
const code = (e: unknown) => (e instanceof HttpError ? e.status : 0);

export interface TreeData {
  files: FileNode[];
  /** The version of the tree: a commit id, or "<work copy>@<version>". File texts are keyed by it. */
  sha: string;
}

/**
 * The files of a ref. For main the live state is the source (no request). `retry` changes → load again.
 * While a work copy reloads, the old tree stays on screen.
 */
export function useTree(client: HarborClient | null, info: RefInfo, mainFiles: FileNode[], retry: number): Loaded<TreeData> {
  const mainData = info.kind === "main" ? { files: mainFiles, sha: info.version } : null;
  const remoteKey = info.kind === "commit" || info.kind === "work" ? info.fileRef : null;
  // The live state says when a work copy changed; that is the only reason to ask for its tree again.
  const version = info.kind === "work" ? info.wc.updatedAt : 0;
  const [state, setState] = useState<{ key: string; value: Loaded<TreeData> } | null>(null);
  const lastVersion = useRef<{ key: string; version: number } | null>(null);

  useEffect(() => {
    if (!remoteKey || !client) return;
    const ctl = new AbortController();
    const same = lastVersion.current?.key === remoteKey;
    // A change of the same work copy waits a moment: an agent writes several files in a row.
    const delay = same && lastVersion.current!.version !== version ? 400 : 0;
    lastVersion.current = { key: remoteKey, version };
    const timer = setTimeout(() => {
      setState((s) => (s?.key === remoteKey ? (s.value.status === "ready" ? s : { key: remoteKey, value: { status: "loading", data: s.value.data } }) : { key: remoteKey, value: { status: "loading" } }));
      client
        .tree(remoteKey, { signal: ctl.signal })
        .then((t) => setState({ key: remoteKey, value: { status: "ready", data: { files: t.files, sha: t.sha } } }))
        .catch((e) => {
          if (isAbort(e)) return;
          setState((s) => ({ key: remoteKey, value: { status: "error", error: msg(e), code: code(e), data: s?.key === remoteKey ? s.value.data : undefined } }));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [client, remoteKey, version, retry]);

  if (mainData) return { status: "ready", data: mainData };
  if (!remoteKey) return { status: "error", error: "", code: 404 };
  if (!state || state.key !== remoteKey) return { status: "loading" };
  return state.value;
}

/** The text of one file. A text that is in memory shows at once (no loading state, no request). */
export function useFileText(client: HarborClient | null, fileRef: string | null, path: string | null, version: string, retry: number): Loaded<string> | null {
  const key = fileRef && path ? `${fileRef}\u0000${version}\u0000${path}` : null;
  const cached = client && fileRef && path ? client.cachedFile(fileRef, path, version || undefined) : undefined;
  const [state, setState] = useState<{ key: string; value: Loaded<string> } | null>(null);

  useEffect(() => {
    if (!key || !client || !fileRef || !path || cached !== undefined) return;
    const ctl = new AbortController();
    setState((s) => (s?.key === key && s.value.status !== "error" ? s : { key, value: { status: "loading" } }));
    client
      .file(fileRef, path, { signal: ctl.signal, version: version || undefined })
      .then((text) => setState({ key, value: { status: "ready", data: text } }))
      .catch((e) => {
        if (isAbort(e)) return;
        setState({ key, value: { status: "error", error: msg(e), code: code(e) } });
      });
    return () => ctl.abort();
    // `cached` is derived from the key; it does not need to start a load of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, retry]);

  if (!key) return null;
  if (cached !== undefined) return { status: "ready", data: cached };
  if (!state || state.key !== key) return { status: "loading" };
  return state.value;
}

/** The diff of a work copy against its base; reused until the work copy changes (its updatedAt). */
export function useAttemptDiff(client: HarborClient | null, attemptId: string | null, version: number, retry: number): Loaded<DiffResult> | null {
  const key = attemptId ? `${attemptId}@${version}` : null;
  const [state, setState] = useState<{ key: string; id: string; value: Loaded<DiffResult> } | null>(null);
  useEffect(() => {
    if (!key || !client || !attemptId) return;
    const ctl = new AbortController();
    // A new version of the same work copy keeps the old diff on screen until the new one is there.
    setState((s) => (s?.id === attemptId && s.value.status === "ready" ? s : { key, id: attemptId, value: { status: "loading" } }));
    client
      .attemptDiff(attemptId, { signal: ctl.signal, version })
      .then((d) => setState({ key, id: attemptId, value: { status: "ready", data: d } }))
      .catch((e) => {
        if (isAbort(e)) return;
        setState({ key, id: attemptId, value: { status: "error", error: msg(e), code: code(e) } });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, retry]);
  if (!key) return null;
  if (!state || state.id !== attemptId) return { status: "loading" };
  return state.value;
}

/**
 * Show a loading shape only when loading takes longer than `delay` ms, and then for at least `min` ms,
 * so a fast answer shows no flash and a slow one does not flicker.
 */
export function useDelayedFlag(on: boolean, delay = 150, min = 400): boolean {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (on) {
      const t = setTimeout(() => {
        since.current = Date.now();
        setShown(true);
      }, delay);
      return () => clearTimeout(t);
    }
    if (!shown) return;
    const left = Math.max(0, min - (Date.now() - since.current));
    const t = setTimeout(() => setShown(false), left);
    return () => clearTimeout(t);
  }, [on, delay, min, shown]);
  return shown;
}
