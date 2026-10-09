/** A small path router on the History API. */
import { useSyncExternalStore, type ComponentPropsWithRef, type MouseEvent } from "react";

export type Route =
  | { name: "chart" }
  | { name: "intents"; id?: string }
  | { name: "logbook"; id?: string }
  | { name: "connect" }
  | { name: "sim" }
  | { name: "design" }
  | { name: "projects" }
  | { name: "settings" }
  | { name: "notfound"; path: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "chart" };
  switch (parts[0]) {
    case "chart":
      return { name: "chart" };
    case "intents":
      return { name: "intents", id: parts[1] };
    case "logbook":
      return { name: "logbook", id: parts[1] };
    case "connect":
      return { name: "connect" };
    case "sim":
      return { name: "sim" };
    case "design":
      return { name: "design" };
    case "projects":
      return { name: "projects" };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "notfound", path: pathname };
  }
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

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, getPath, getPath);
  return parseRoute(path);
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
