/** A small path router on the History API. */
import { useSyncExternalStore, type ComponentPropsWithRef, type MouseEvent } from "react";

export type Route =
  | { name: "home" }
  | { name: "chart" }
  | { name: "intents"; id?: string }
  | { name: "logbook"; id?: string }
  | { name: "connect" }
  | { name: "design" }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "notfound"; path: string };

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Paths: "/" home, "/overview", "/tasks" and "/tasks/:id", "/history" and "/history/:id", "/connect",
 * "/projects", "/settings". Old paths stay as aliases: "/chart", "/intents/:id", "/logbook/:id".
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
    case "connect":
      return { name: "connect" };
    case "design":
      if (import.meta.env.DEV) return { name: "design" };
      break;
    case "projects":
      return { name: "projects" };
    case "settings":
      return { name: "settings" };
  }
  return { name: "notfound", path: pathname };
}

const ALIASES: Record<string, string> = { chart: "/overview", intents: "/tasks", logbook: "/history" };

/** The current path for an old alias ("/chart" → "/overview", "/intents/x" → "/tasks/x"), else null. */
export function canonicalPath(pathname: string): string | null {
  const m = /^\/(chart|intents|logbook)(?=\/|$)(.*)$/.exec(pathname);
  return m ? ALIASES[m[1]] + m[2] : null;
}

/** Views that show one project. They need its state; "/", "/projects" and "/design" do not. */
export function isProjectRoute(route: Route): boolean {
  return route.name === "chart" || route.name === "intents" || route.name === "logbook" || route.name === "connect" || route.name === "settings";
}

const EVENT = "gitring:navigate";
/** Query params that belong to the session and survive navigation. */
const KEEP = ["project"];

export function href(to: string): string {
  const [path, query = ""] = to.split("?");
  const cur = new URLSearchParams(location.search);
  const next = new URLSearchParams(query);
  for (const k of KEEP) if (cur.has(k) && !next.has(k)) next.set(k, cur.get(k)!);
  const q = next.toString();
  return q ? `${path}?${q}` : path;
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = href(to);
  if (url === location.pathname + location.search) return;
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
  history.replaceState(null, "", location.pathname + (q ? `?${q}` : ""));
  window.dispatchEvent(new Event(EVENT));
}

interface LinkProps extends Omit<ComponentPropsWithRef<"a">, "href"> {
  to: string;
  replace?: boolean;
}

export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      href={href(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to, { replace });
      }}
    />
  );
}
