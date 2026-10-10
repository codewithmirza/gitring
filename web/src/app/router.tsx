/** A small path router on the History API. */
import { useSyncExternalStore, type ComponentPropsWithRef, type MouseEvent } from "react";

export type Route =
  | { name: "home" }
  | { name: "chart" }
  | { name: "intents"; id?: string }
  | { name: "logbook"; id?: string }
  | { name: "code"; ref?: string; path?: string }
  | { name: "connect" }
  | { name: "design" }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "account" }
  | { name: "notfound"; path: string };

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Paths: "/" home, "/overview", "/tasks" and "/tasks/:id", "/history" and "/history/:id",
 * "/code", "/code/:ref" and "/code/:ref/<file path>" (ref: main, a work copy id or a commit), "/connect",
 * "/projects", "/settings", "/account". Old paths stay as aliases: "/chart", "/intents/:id", "/logbook/:id".
 * "/design" exists in development builds only.
 */
export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decode);
  if (parts.length === 0) return { name: "home" };
  switch (parts[0]) {
    case "overview":
    case "chart":
      return { name: "chart" };
    case "tasks":
    case "intents":
      return { name: "intents", id: parts[1] };
    case "history":
    case "logbook":
      return { name: "logbook", id: parts[1] };
    case "code":
      return { name: "code", ref: parts[1], path: parts.length > 2 ? parts.slice(2).join("/") : undefined };
    case "connect":
      return { name: "connect" };
    case "design":
      if (import.meta.env.DEV) return { name: "design" };
      break;
    case "projects":
      return { name: "projects" };
    case "settings":
      return { name: "settings" };
    case "account":
      return { name: "account" };
  }
  return { name: "notfound", path: pathname };
}

const ALIASES: Record<string, string> = { chart: "/overview", intents: "/tasks", logbook: "/history" };

/** The current path for an old alias ("/chart" → "/overview", "/intents/x" → "/tasks/x"), else null. */
export function canonicalPath(pathname: string): string | null {
  const m = /^\/(chart|intents|logbook)(?=\/|$)(.*)$/.exec(pathname);
  return m ? ALIASES[m[1]] + m[2] : null;
}

/** Views that show one project. They need its state; "/", "/projects", "/account" and "/design" do not. */
export function isProjectRoute(route: Route): boolean {
  return (
    route.name === "chart" ||
    route.name === "intents" ||
    route.name === "logbook" ||
    route.name === "code" ||
    route.name === "connect" ||
    route.name === "settings"
  );
}

/**
 * Link to the code view: "/code/main/src/app.js", a work copy ("/code/at_123/src/app.js"),
 * its diff against its base ("?view=diff") and a line ("#L12" or "#L12-L20").
 */
export function codeHref(ref = "main", path?: string, opts: { diff?: boolean; line?: number; endLine?: number } = {}): string {
  const file = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  const query = opts.diff ? "?view=diff" : "";
  const hash = opts.line ? `#L${opts.line}${opts.endLine && opts.endLine > opts.line ? `-L${opts.endLine}` : ""}` : "";
  return `/code/${encodeURIComponent(ref)}${file}${query}${hash}`;
}

const EVENT = "gitring:navigate";
/** Query params that belong to the session and survive navigation. */
const KEEP = ["project"];

/** The URL for an app path: keeps ?project= of the current address. Handles "?query" and "#hash". */
export function href(to: string): string {
  const hashAt = to.indexOf("#");
  const hash = hashAt >= 0 ? to.slice(hashAt) : "";
  const rest = hashAt >= 0 ? to.slice(0, hashAt) : to;
  const [path, query = ""] = rest.split("?");
  const cur = new URLSearchParams(location.search);
  const next = new URLSearchParams(query);
  for (const k of KEEP) if (cur.has(k) && !next.has(k)) next.set(k, cur.get(k)!);
  const q = next.toString();
  return `${path}${q ? `?${q}` : ""}${hash}`;
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = href(to);
  if (url === location.pathname + location.search + location.hash) return;
  if (opts.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(EVENT, cb);
  };
}

const getPath = () => location.pathname;
const getSearch = () => location.search;
const getLocation = () => location.pathname + location.search;

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, getPath, getPath);
  return parseRoute(path);
}

/** Path and query as one string: it changes on every navigation, also when only the query changes. */
export function useLocationKey(): string {
  return useSyncExternalStore(subscribe, getLocation, getLocation);
}

export function useSearchParam(name: string): string | null {
  const search = useSyncExternalStore(subscribe, getSearch, getSearch);
  return new URLSearchParams(search).get(name);
}

/** Set or clear one query param without a new history entry. */
export function setSearchParam(name: string, value: string | null) {
  const p = new URLSearchParams(location.search);
  if (value === null) p.delete(name);
  else p.set(name, value);
  const q = p.toString();
  history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
  window.dispatchEvent(new Event(EVENT));
}

/* Preload: App registers a function that starts loading the code of a view; links call it on hover and focus. */
let preloader: ((path: string) => void) | null = null;
export function setPreloader(fn: (path: string) => void) {
  preloader = fn;
}
export function preloadPath(to: string) {
  preloader?.(to);
}

interface LinkProps extends Omit<ComponentPropsWithRef<"a">, "href"> {
  to: string;
  replace?: boolean;
}

/** In-app link: a real <a href> (new tab and copy work), client navigation on a plain click, preload on hover. */
export function Link({ to, replace, onClick, onMouseEnter, onFocus, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      href={href(to)}
      onMouseEnter={(e) => {
        onMouseEnter?.(e);
        preloadPath(to);
      }}
      onFocus={(e) => {
        onFocus?.(e);
        preloadPath(to);
      }}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to, { replace });
      }}
    />
  );
}

/** Props for a menu item or a button that acts as an in-app link (plain click: client navigation). */
export function linkProps(to: string): { href: string; onSelect: (e: MouseEvent<HTMLElement>) => void } {
  return {
    href: href(to),
    onSelect: (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
