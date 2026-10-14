/**
 * Reads and writes the addresses of the code page, such as /code/<ref>/<file path>?view=diff#L10-L20.
 * A ref is main, the id of a work copy ("at_x7k2m9") or a commit id. /code alone means main with no file.
 * ?view=diff shows a work copy against its base. #L12 or #L10-L20 selects a line or a range of lines.
 * Older links with ?ref=<ref>&path=<path> open too. ?project= stays as the router keeps it.
 * The format is the same as codeHref() in the shell's router, so both make the same links.
 */
import { useSyncExternalStore } from "react";

export type CodeMode = "code" | "diff";

export interface CodeLocation {
  ref: string;
  path: string | null;
  view: CodeMode;
  /** Selected lines, first ≤ last. */
  lines: [number, number] | null;
}

export interface CodeHrefOptions {
  diff?: boolean;
  line?: number;
  endLine?: number;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** The address of a file (or a whole ref) in the code view. Same format as the router's codeHref(ref, path). */
export function codeHref(path?: string | null, ref = "main", opts: CodeHrefOptions = {}): string {
  const file = path ? `/${encodePath(path)}` : "";
  const query = opts.diff ? "?view=diff" : "";
  return `/code/${encodeURIComponent(ref || "main")}${file}${query}${lineHash(opts.line ? [opts.line, opts.endLine ?? opts.line] : null)}`;
}

/** "#L12" or "#L10-L20" (empty for no lines). */
export function lineHash(lines: readonly [number, number] | null): string {
  if (!lines) return "";
  const [a, b] = lines[0] <= lines[1] ? lines : [lines[1], lines[0]];
  return a === b ? `#L${a}` : `#L${a}-L${b}`;
}

/** "#L12" → [12, 12]; "#L20-L10" → [10, 20]; anything else → null. */
export function parseLineHash(hash: string): [number, number] | null {
  const m = /^#?L(\d+)(?:-L?(\d+))?$/i.exec(hash.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1) return null;
  return a <= b ? [a, b] : [b, a];
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Read a code view address (pathname, search and hash of `location`). */
export function parseCodeLocation(pathname: string, search: string, hash: string): CodeLocation {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decode);
  const q = new URLSearchParams(search);
  let ref = "main";
  let path: string | null = null;
  if (parts[0] === "code" && parts.length > 1) {
    ref = parts[1] || "main";
    path = parts.length > 2 ? parts.slice(2).join("/") : null;
  }
  // Older form: /code?ref=…&path=…
  if (parts.length <= 1) {
    ref = q.get("ref") || ref;
    path = q.get("path") || null;
  }
  if (path) path = path.replace(/^\/+/, "");
  return { ref, path: path || null, view: q.get("view") === "diff" ? "diff" : "code", lines: parseLineHash(hash) };
}

/* ───────────── live location ───────────── */

const NAV_EVENT = "gitring:navigate";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener("hashchange", cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener("hashchange", cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

const getHref = () => location.pathname + location.search + location.hash;

let lastKey = "";
let lastLoc: CodeLocation = { ref: "main", path: null, view: "code", lines: null };

/** The code location of the address bar; it changes on navigation, back/forward and hash changes. */
export function useCodeLocation(): CodeLocation {
  const key = useSyncExternalStore(subscribe, getHref, getHref);
  if (key !== lastKey) {
    lastKey = key;
    const next = parseCodeLocation(location.pathname, location.search, location.hash);
    // Keep the old object when nothing that matters changed (stable deps for effects).
    const same =
      next.ref === lastLoc.ref &&
      next.path === lastLoc.path &&
      next.view === lastLoc.view &&
      (next.lines === lastLoc.lines || (next.lines && lastLoc.lines && next.lines[0] === lastLoc.lines[0] && next.lines[1] === lastLoc.lines[1]));
    if (!same) lastLoc = next;
  }
  return lastLoc;
}

/** Keep the query (for example ?project=) and change path, view or lines. */
export function codeUrl(loc: Partial<CodeLocation> & { ref: string }, current: { search: string } = location): string {
  const q = new URLSearchParams(current.search);
  q.delete("ref");
  q.delete("path");
  if (loc.view === "diff") q.set("view", "diff");
  else q.delete("view");
  const s = q.toString();
  const file = loc.path ? `/${encodePath(loc.path)}` : "";
  return `/code/${encodeURIComponent(loc.ref)}${file}${s ? `?${s}` : ""}${lineHash(loc.lines ?? null)}`;
}

/** Go to a code location: a new history entry, or a replacement (line selection, view toggles). */
export function goCode(loc: Partial<CodeLocation> & { ref: string }, opts: { replace?: boolean } = {}): void {
  const url = codeUrl(loc);
  if (url === getHref()) return;
  if (opts.replace) history.replaceState(history.state, "", url);
  else history.pushState(null, "", url);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** A full permanent link (origin included) for copying. */
export function absoluteUrl(path: string): string {
  return `${location.origin}${path}`;
}
