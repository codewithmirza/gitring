/**
 * A hook for the current time, refreshed on an interval, for words like "4 min ago".
 */
import { useEffect, useState } from "react";

/** The current time, refreshed every `ms` (for relative times like "4 min ago"). */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
