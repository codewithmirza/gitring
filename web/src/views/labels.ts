/**
 * Labels that only the lazy views use (the code view and the history).
 * They live here and not in state/format, so the first download of the app does not carry them.
 */

/** "line 12" or "lines 10–18". */
export function lineRangeText(range: readonly [number, number]): string {
  const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]];
  return a === b ? `line ${a}` : `lines ${a}–${b}`;
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A calm day heading for lists: "Today", "Yesterday", "Mon 8 Oct", or "8 Oct 2025" in another year. */
export function dayLabel(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const start = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((start(now) - start(ms)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (d.getFullYear() !== new Date(now).getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const LANG_TEXT: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  typescript: "TypeScript",
  json: "JSON",
  jsonc: "JSON",
  css: "CSS",
  html: "HTML",
  htm: "HTML",
  md: "Markdown",
  markdown: "Markdown",
  py: "Python",
  python: "Python",
  go: "Go",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  sh: "Shell",
  txt: "Text",
  text: "Text",
};

/** The name of a language for people ("TypeScript"), from the file's lang or extension. */
export function langLabel(lang: string | undefined, path = ""): string {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return LANG_TEXT[(lang ?? "").toLowerCase()] ?? LANG_TEXT[ext] ?? (lang && lang !== "text" ? lang.toUpperCase() : "Text");
}
