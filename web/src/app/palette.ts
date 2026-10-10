/**
 * Command palette logic without the DOM: fuzzy match, query prefixes and ranking.
 *
 * Prefixes (as on GitHub): ">" commands, "#" tasks, "@" agents and work copies, "/" files.
 * Without a prefix the palette searches everything; with an empty query it shows recent items first.
 */

export type PaletteGroup = "Recent" | "Commands" | "Pages" | "Projects" | "Tasks" | "Agents" | "Files";

export interface PaletteEntry {
  /** Unique and stable, for the recent list: "task:i_1", "file:src/a.js", "cmd:new-task". */
  key: string;
  group: Exclude<PaletteGroup, "Recent">;
  title: string;
  /** Second text: a folder, a status, a project. */
  hint?: string;
  /** More words that match, not shown. */
  keywords?: string;
}

export interface Ranked<T extends PaletteEntry> {
  item: T;
  score: number;
  /** Positions in `item.title` that matched, for highlight. */
  hits: number[];
}

export const PREFIXES: Record<string, PaletteEntry["group"]> = { ">": "Commands", "#": "Tasks", "@": "Agents", "/": "Files" };

export function parseQuery(raw: string): { group: PaletteEntry["group"] | null; text: string } {
  const q = raw.trimStart();
  const g = PREFIXES[q[0] ?? ""];
  return g ? { group: g, text: q.slice(1).trim() } : { group: null, text: q.trim() };
}

const SEP = /[\s/_\-.#@:()]/;

/**
 * How well `query` matches `text`: null when it does not match (the letters of the query must appear in
 * order). Higher is better: whole-word and start-of-word matches, letters in a row and short texts win.
 */
export function fuzzyScore(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return { score: 0, hits: [] };
  // Two passes: one that jumps to word starts, one that takes the leftmost letter. The better one wins;
  // the leftmost pass finds every real match, so the jump never hides one.
  const a = matchPass(q, text, true);
  const b = matchPass(q, text, false);
  if (!a) return b;
  if (!b) return a;
  return a.score >= b.score ? a : b;
}

function matchPass(q: string, text: string, preferStarts: boolean): { score: number; hits: number[] } | null {
  const t = text.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const c of q) {
    if (c === " ") {
      prev = -2;
      continue;
    }
    // preferStarts: the next letter in a row, else the next start of a word with this letter, else the next letter.
    let at = -1;
    for (let i = from; i < t.length; i++) {
      if (t[i] !== c) continue;
      if (!preferStarts || i === prev + 1 || i === 0 || SEP.test(t[i - 1]) || (text[i] !== t[i] && text[i - 1] === t[i - 1])) {
        at = i;
        break;
      }
      if (at < 0) at = i;
    }
    if (at < 0) return null;
    let s = 1;
    if (at === prev + 1) s += 6;
    if (at === 0 || SEP.test(t[at - 1])) s += 8;
    else if (text[at] !== t[at] && text[at - 1] === t[at - 1]) s += 5;
    s -= Math.min(4, (at - from) * 0.15);
    hits.push(at);
    score += s;
    prev = at;
    from = at + 1;
  }
  const whole = t.indexOf(q);
  if (whole === 0) score += 16;
  else if (whole > 0) score += SEP.test(t[whole - 1]) ? 12 : 8;
  score -= t.length * 0.04;
  return { score, hits };
}

/** Score an entry: its title, or (weaker) its hint and keywords. Files match their name before their folder. */
export function scoreEntry(query: string, e: PaletteEntry): { score: number; hits: number[] } | null {
  if (e.group === "Files") {
    const slash = e.title.lastIndexOf("/");
    const base = fuzzyScore(query, e.title.slice(slash + 1));
    const full = fuzzyScore(query, e.title);
    if (base) return { score: base.score + 10, hits: base.hits.map((h) => h + slash + 1) };
    return full;
  }
  const main = fuzzyScore(query, e.title);
  if (main) return main;
  const extra = fuzzyScore(query, `${e.hint ?? ""} ${e.keywords ?? ""}`);
  return extra ? { score: extra.score - 12, hits: [] } : null;
}

const GROUP_ORDER: PaletteEntry["group"][] = ["Commands", "Pages", "Projects", "Tasks", "Agents", "Files"];
const LIMIT_ALL: Record<PaletteEntry["group"], number> = { Commands: 6, Pages: 5, Projects: 5, Tasks: 6, Agents: 5, Files: 8 };

export interface Section<T extends PaletteEntry> {
  group: PaletteGroup;
  items: Ranked<T>[];
}

/**
 * The sections the palette shows for a query. `recent` holds keys of recently used entries (newest first);
 * they come first for an empty query and get a small boost when they match.
 */
export function rank<T extends PaletteEntry>(raw: string, entries: T[], recent: string[] = []): Section<T>[] {
  const { group, text } = parseQuery(raw);
  const pool = group ? entries.filter((e) => e.group === group) : entries;

  if (!text) {
    if (group) return [{ group, items: pool.slice(0, 60).map((item) => ({ item, score: 0, hits: [] })) }];
    const byKey = new Map(pool.map((e) => [e.key, e]));
    const rec = recent
      .map((k) => byKey.get(k))
      .filter((e): e is T => Boolean(e))
      .slice(0, 5);
    const seen = new Set(rec.map((e) => e.key));
    const out: Section<T>[] = [];
    if (rec.length) out.push({ group: "Recent", items: rec.map((item) => ({ item, score: 0, hits: [] })) });
    for (const g of ["Commands", "Pages"] as const) {
      const items = pool.filter((e) => e.group === g && !seen.has(e.key)).slice(0, g === "Commands" ? 5 : 8);
      if (items.length) out.push({ group: g, items: items.map((item) => ({ item, score: 0, hits: [] })) });
    }
    return out;
  }

  const recentBoost = new Map(recent.map((k, i) => [k, 6 - Math.min(5, i)]));
  const scored: Ranked<T>[] = [];
  for (const item of pool) {
    const m = scoreEntry(text, item);
    if (m) scored.push({ item, score: m.score + (recentBoost.get(item.key) ?? 0), hits: m.hits });
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  if (group) return scored.length ? [{ group, items: scored.slice(0, 60) }] : [];
  const out: Section<T>[] = [];
  for (const g of GROUP_ORDER) {
    const items = scored.filter((r) => r.item.group === g).slice(0, LIMIT_ALL[g]);
    if (items.length) out.push({ group: g, items });
  }
  // The section with the best match goes first.
  out.sort((a, b) => b.items[0].score - a.items[0].score);
  return out;
}

/* ───────────── recent items (per browser) ───────────── */

const RECENT_KEY = "gitring.palette.recent";

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

export function pushRecent(key: string) {
  try {
    const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage off */
  }
}
