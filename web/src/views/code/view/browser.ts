/**
 * Browser helpers of the code view: remembered flags in local storage, a narrow-screen hook and copy to the clipboard.
 * Storage and the clipboard can fail (private windows, no permission). Every helper here survives that.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* storage off */
  }
}

export function useNarrow(): boolean {
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
export function useCopied(): [string | null, (key: string, text: string) => void] {
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
