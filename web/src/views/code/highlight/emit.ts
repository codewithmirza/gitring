/**
 * The output side of the highlighter: Emit collects the tokens of a line, and make() turns a line function into a Highlighter.
 */
import { PLAIN } from "./classes";

export class Emit {
  t: number[] = [];
  at = 0;
  constructor(readonly s: string) {}
  /** Text from `at` to `end` has class `cls`. */
  to(end: number, cls: number) {
    if (end <= this.at) return;
    const n = this.t.length;
    if (n && this.t[n - 1] === cls) this.t[n - 2] = end;
    else this.t.push(end, cls);
    this.at = end;
  }
}

export type LineFn<S> = (s: string, from: number, end: number, state: S, e: Emit) => S;

export interface Highlighter<S = unknown> {
  start: S;
  line(text: string, state: S): { tokens: number[]; state: S };
}

/** Longer lines (minified code) get tokens for this many characters; the rest stays plain. */
const MAX_LINE = 4000;

export function make<S>(start: S, fn: LineFn<S>): Highlighter<S> {
  return {
    start,
    line(text, state) {
      const e = new Emit(text);
      const end = Math.min(text.length, MAX_LINE);
      const next = fn(text, 0, end, state, e);
      e.to(text.length, PLAIN);
      return { tokens: e.t, state: next };
    },
  };
}
