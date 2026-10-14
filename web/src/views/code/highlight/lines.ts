/**
 * Runs a highlighter over many lines: tokenizeAll, runsOf (text runs for rendering) and LineHighlighter.
 * Read by the code view. LineHighlighter works in small time slices so a large file never blocks the page.
 */
import { CLASS_NAMES, PLAIN } from "./classes";
import type { Highlighter } from "./emit";
import type { LangInfo } from "./language";
import { highlighterFor } from "./registry";

/** Tokens for all lines at once (tests and small files). */
export function tokenizeAll(info: LangInfo | null, lines: readonly string[]): number[][] {
  const hl = highlighterFor(info);
  if (!hl) return lines.map((l) => (l.length ? [l.length, PLAIN] : []));
  let st = hl.start;
  return lines.map((l) => {
    const r = hl.line(l, st);
    st = r.state;
    return r.tokens;
  });
}

/** Text runs of a tokenized line, for rendering and tests: [[text, className], …]. */
export function runsOf(text: string, tokens: readonly number[] | undefined): [string, string][] {
  if (!tokens || !tokens.length) return text ? [[text, ""]] : [];
  const out: [string, string][] = [];
  let p = 0;
  for (let k = 0; k < tokens.length; k += 2) {
    const end = tokens[k];
    if (end > p) out.push([text.slice(p, end), CLASS_NAMES[tokens[k + 1]] ?? ""]);
    p = end;
  }
  if (p < text.length) out.push([text.slice(p), ""]);
  return out;
}

/**
 * Highlights the lines of one file in small steps (so a large file never blocks the page): run() does
 * work for a time budget and says if more is left. Lines without tokens yet render as plain text.
 */
export class LineHighlighter {
  readonly tokens: (number[] | undefined)[];
  private state: unknown;
  private next = 0;

  constructor(
    readonly lines: readonly string[],
    private readonly hl: Highlighter,
  ) {
    this.tokens = new Array(lines.length);
    this.state = hl.start;
  }

  /** Lines with tokens: 0 … done-1. */
  get done(): number {
    return this.next;
  }

  get finished(): boolean {
    return this.next >= this.lines.length;
  }

  /** Tokenize until `budgetMs` is used or line `upTo` is done. Returns true when lines are left. */
  run(budgetMs: number, upTo = this.lines.length): boolean {
    const stop = Math.min(upTo, this.lines.length);
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    while (this.next < stop) {
      const r = this.hl.line(this.lines[this.next], this.state);
      this.tokens[this.next] = r.tokens;
      this.state = r.state;
      this.next++;
      if ((this.next & 31) === 0) {
        const t = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (t - t0 > budgetMs) break;
      }
    }
    return this.next < this.lines.length;
  }
}
