/**
 * Two link helpers of the history page: a link that keeps ?project=, and a click that stays in the app.
 */
import { type MouseEvent } from "react";
import { navigate } from "../../app/router";

/** An app link with the ?project= of the address (for links that the router's Link cannot build: with #). */
export function withProject(to: string): string {
  const p = new URLSearchParams(location.search).get("project");
  if (!p) return to;
  const hash = to.includes("#") ? to.slice(to.indexOf("#")) : "";
  const base = hash ? to.slice(0, to.indexOf("#")) : to;
  return `${base}${base.includes("?") ? "&" : "?"}project=${encodeURIComponent(p)}${hash}`;
}

export function openInApp(e: MouseEvent<HTMLAnchorElement>, to: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(to);
}
