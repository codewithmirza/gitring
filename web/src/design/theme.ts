/**
 * Day / Dusk / Night theme.
 * Default follows prefers-color-scheme; the viewer's choice persists in localStorage.
 */
import { useSyncExternalStore } from "react";

export type Theme = "day" | "dusk" | "night";
export const THEMES: { id: Theme; label: string; help: string }[] = [
  { id: "day", label: "Day", help: "Bright light" },
  { id: "dusk", label: "Dusk", help: "Dim light" },
  { id: "night", label: "Night", help: "Dark" },
];

const KEY = "bearing.theme";
const listeners = new Set<() => void>();

function isTheme(v: unknown): v is Theme {
  return v === "day" || v === "dusk" || v === "night";
}

function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day";
  } catch {
    return "day";
  }
}

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

/** URL override (?theme=night) — used for screenshots; not persisted. */
function fromUrl(): Theme | null {
  try {
    const v = new URLSearchParams(location.search).get("theme");
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

let current: Theme = fromUrl() ?? stored() ?? systemTheme();
let explicit = Boolean(fromUrl() ?? stored());

function apply() {
  const root = document.documentElement;
  if (explicit) root.setAttribute("data-theme", current);
  else root.removeAttribute("data-theme");
}

export function getTheme(): Theme {
  return current;
}

export function setTheme(t: Theme) {
  current = t;
  explicit = true;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage can be blocked; the choice still applies for this visit */
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

/** Follow system changes while the viewer has not chosen a theme. */
export function initTheme() {
  apply();
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (explicit) return;
      current = systemTheme();
      listeners.forEach((l) => l());
    });
  } catch {
    /* old browsers */
  }
}
