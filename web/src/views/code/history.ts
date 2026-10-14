/**
 * History of a file in the code view: "Why is this line here?" and the changes of the file.
 * The answers come from the REST twins of the history tools (src/worker/history-routes.ts).
 * The shapes are in src/core/history.ts.
 *
 * Pure parts (addresses and words) are here, so a unit test can check them without a browser.
 */
import { useEffect, useState } from "react";
import type { HistoryAnswer, HistoryStep, WhyAnswer, WhyRecord } from "../../../../src/core/history";
import { getJson, HttpError, isAbort } from "../../state/http";
import { METHOD_TEXT, plural, shortSha } from "../../state/format";
import type { Loaded } from "./data";

export type { HistoryAnswer, HistoryStep, WhyAnswer, WhyRecord };

/** The address of the why answer for a line (or a file) of a version. `v` changes the address when the version moves. */
export function whyUrl(projectId: string, ref: string, path: string, line: number | null, v = ""): string {
  const q = new URLSearchParams({ path, ref });
  if (line) q.set("line", String(line));
  if (v) q.set("v", v);
  return `/api/projects/${encodeURIComponent(projectId)}/why?${q}`;
}

/** The address of the changes of a file on main. */
export function historyUrl(projectId: string, path: string, limit = 30, v = ""): string {
  const q = new URLSearchParams({ path, limit: String(limit) });
  if (v) q.set("v", v);
  return `/api/projects/${encodeURIComponent(projectId)}/history?${q}`;
}

/** The state of a change request, for people. */
export function requestStatusText(status: string): string {
  switch (status) {
    case "acknowledged":
      return "The agent applied it";
    case "delivered":
      return "Sent to the agent";
    case "pending":
      return "Not sent";
    case "superseded":
      return "Replaced by a newer request";
    case "closed":
      return "Closed at merge";
    default:
      return status;
  }
}

/** One line about who made a change of main: "Work of Robin-4 · 3-way merge · commit abc1234". */
export function stepMeta(s: HistoryStep): string {
  const sha = `commit ${shortSha(s.sha)}`;
  if (s.kind === "merge" && s.merge) return `Work of ${s.merge.callsign} · ${METHOD_TEXT[s.merge.method] ?? s.merge.method} · ${sha}`;
  if (s.kind === "root") return `The start of the history · ${sha}`;
  return `Main moved without a merge · ${sha}`;
}

/** What a change did to the file: "+4 −1", "added", "deleted". */
export function changeText(s: HistoryStep): string {
  const c = s.change;
  if (!c) return s.kind === "root" ? "on main at the start" : "";
  if (c.status === "A") return `added, +${c.additions}`;
  if (c.status === "D") return "deleted";
  return `+${c.additions} −${c.deletions}${c.paths ? ` in ${plural(c.paths, "file")}` : ""}`;
}

/** The tests of a merge: "5 of 5 tests pass". */
export function testsText(t: { passed: number; failed: number }): string {
  const total = t.passed + t.failed;
  return total ? `${t.passed} of ${total} tests pass` : "No test ran";
}

/** A short goal: the first paragraph, at most 220 characters. */
export function shortGoal(goal: string): string {
  const first = goal.split(/\n\s*\n/)[0].replace(/^#+\s*/gm, "").trim();
  return first.length > 220 ? `${first.slice(0, 219).trimEnd()}…` : first;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "gitring could not load this. Try again.");

/** A JSON answer for an address; a new address loads again, `retry` loads the same one again. */
export function useJson<T>(url: string | null, retry = 0): Loaded<T> | null {
  const [state, setState] = useState<{ url: string; value: Loaded<T> } | null>(null);
  useEffect(() => {
    if (!url) return;
    const ctl = new AbortController();
    setState({ url, value: { status: "loading" } });
    getJson<T>(url, { signal: ctl.signal, timeoutMs: 30_000 })
      .then((data) => setState({ url, value: { status: "ready", data } }))
      .catch((e) => {
        if (isAbort(e)) return;
        setState({ url, value: { status: "error", error: message(e), code: e instanceof HttpError ? e.status : 0 } });
      });
    return () => ctl.abort();
  }, [url, retry]);
  if (!url) return null;
  if (!state || state.url !== url) return { status: "loading" };
  return state.value;
}
