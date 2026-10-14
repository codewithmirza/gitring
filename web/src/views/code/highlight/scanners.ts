/**
 * Small scanning helpers that every language uses: character tests, sticky regexes and quoted strings.
 */
export const isIdStart = (c: string) => /[A-Za-z_$À-￿]/.test(c);
export const isDigit = (c: string) => c >= "0" && c <= "9";
export const WS = /\s/;

export function sticky(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("y") ? re.flags : re.flags + "y");
}

/** Match a sticky regex at `i` (within `end`); returns the end index or -1. */
export function at(re: RegExp, s: string, i: number, end: number): number {
  re.lastIndex = i;
  const m = re.exec(s);
  if (!m || m.index !== i) return -1;
  return Math.min(i + m[0].length, end);
}

/** A quoted string from `i` (the quote) to the closing quote or the end. Returns [end, closed]. */
export function quoted(s: string, i: number, end: number, q: string): [number, boolean] {
  for (let j = i + 1; j < end; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === q) return [j + 1, true];
  }
  return [end, false];
}

export function nextNonSpace(s: string, i: number, end: number): number {
  while (i < end && WS.test(s[i])) i++;
  return i;
}
