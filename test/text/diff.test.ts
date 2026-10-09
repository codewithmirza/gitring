import { describe, expect, it } from "vitest";
import { diffHunks, isProbablyText, lineDiff, rangesOverlap, unifiedDiff } from "../../src/core/text/diff";

/** "l1\nl2\n…\nlN\n" */
const numbered = (n: number): string => Array.from({ length: n }, (_, i) => `l${i + 1}\n`).join("");
const edit = (text: string, f: (lines: string[]) => void): string => {
  const lines = text.split("\n");
  const last = lines.pop(); // "" after the final newline
  f(lines);
  return lines.join("\n") + "\n" + (last ?? "");
};
const BASE = numbered(10);

describe("lineDiff", () => {
  it("reports an edit at the top", () => {
    const d = lineDiff(BASE, edit(BASE, (l) => (l[0] = "first")));
    expect(d).toEqual({ hunks: [[1, 1]], additions: 1, deletions: 1, changedNewLines: [[1, 1]] });
  });

  it("reports an edit in the middle", () => {
    const d = lineDiff(BASE, edit(BASE, (l) => (l[4] = "five")));
    expect(d).toEqual({ hunks: [[5, 5]], additions: 1, deletions: 1, changedNewLines: [[5, 5]] });
  });

  it("reports an edit at the end", () => {
    const d = lineDiff(BASE, edit(BASE, (l) => (l[9] = "ten")));
    expect(d).toEqual({ hunks: [[10, 10]], additions: 1, deletions: 1, changedNewLines: [[10, 10]] });
  });

  it("reports a replacement of 3 lines by 2", () => {
    const d = lineDiff(BASE, edit(BASE, (l) => l.splice(3, 3, "x", "y")));
    expect(d).toEqual({ hunks: [[4, 6]], additions: 2, deletions: 3, changedNewLines: [[4, 5]] });
  });

  it("uses [n, n] for a pure insertion after base line n", () => {
    const d = lineDiff(BASE, edit(BASE, (l) => l.splice(4, 0, "new a", "new b")));
    expect(d).toEqual({ hunks: [[4, 4]], additions: 2, deletions: 0, changedNewLines: [[5, 6]] });
  });

  it("uses [0, 0] for an insertion at the top of the file", () => {
    const d = lineDiff(BASE, "// header\n" + BASE);
    expect(d).toEqual({ hunks: [[0, 0]], additions: 1, deletions: 0, changedNewLines: [[1, 1]] });
  });

  it("uses [last, last] for an append at the end of the file", () => {
    const d = lineDiff(BASE, BASE + "l11\nl12\n");
    expect(d).toEqual({ hunks: [[10, 10]], additions: 2, deletions: 0, changedNewLines: [[11, 12]] });
  });

  it("reports a pure deletion with no changed new lines", () => {
    const d = lineDiff(BASE, edit(BASE, (l) => l.splice(2, 2)));
    expect(d).toEqual({ hunks: [[3, 4]], additions: 0, deletions: 2, changedNewLines: [] });
  });

  it("reports several hunks in base order", () => {
    const head = edit(BASE, (l) => {
      l[0] = "one";
      l.splice(5, 1); // delete l6
      l.push("l11");
    });
    const d = lineDiff(BASE, head);
    expect(d.hunks).toEqual([
      [1, 1],
      [6, 6],
      [10, 10],
    ]);
    expect(d.changedNewLines).toEqual([
      [1, 1],
      [10, 10],
    ]);
    expect([d.additions, d.deletions]).toEqual([2, 2]);
  });

  it("gives an empty diff for identical texts", () => {
    expect(lineDiff(BASE, BASE)).toEqual({ hunks: [], additions: 0, deletions: 0, changedNewLines: [] });
    expect(lineDiff("", "")).toEqual({ hunks: [], additions: 0, deletions: 0, changedNewLines: [] });
  });

  it("treats a whole-file add and a whole-file delete", () => {
    expect(lineDiff("", BASE)).toEqual({ hunks: [[0, 0]], additions: 10, deletions: 0, changedNewLines: [[1, 10]] });
    expect(lineDiff(BASE, "")).toEqual({ hunks: [[1, 10]], additions: 0, deletions: 10, changedNewLines: [] });
  });

  it("reports only the last line when just the final newline changes", () => {
    expect(lineDiff("a\nb\nc", "a\nb\nc\n")).toEqual({ hunks: [[3, 3]], additions: 1, deletions: 1, changedNewLines: [[3, 3]] });
    expect(lineDiff("a\nb\nc\n", "a\nb\nc")).toEqual({ hunks: [[3, 3]], additions: 1, deletions: 1, changedNewLines: [[3, 3]] });
    // appending after a last line without a newline touches that line (as in git)
    expect(lineDiff("a\nb", "a\nb\nc\n").hunks).toEqual([[2, 2]]);
  });

  it("ignores a CRLF ↔ LF conversion", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    expect(lineDiff(crlf, BASE)).toEqual({ hunks: [], additions: 0, deletions: 0, changedNewLines: [] });
    expect(lineDiff(BASE, crlf)).toEqual({ hunks: [], additions: 0, deletions: 0, changedNewLines: [] });
  });

  it("finds precise hunks in CRLF files", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    const head = crlf.replace("l7\r\n", "seven\r\n");
    expect(lineDiff(crlf, head)).toEqual({ hunks: [[7, 7]], additions: 1, deletions: 1, changedNewLines: [[7, 7]] });
    // a CRLF base edited by an agent that writes LF: only the real edit counts
    expect(lineDiff(crlf, BASE.replace("l3\n", "three\n")).hunks).toEqual([[3, 3]]);
  });

  it("keeps a lone CR inside a line", () => {
    expect(lineDiff("a\rb\nc\n", "a\rb\nC\n").hunks).toEqual([[2, 2]]);
  });

  it("stays bounded on large, very different texts", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `a${i}\n`).join("");
    const b = Array.from({ length: 20000 }, (_, i) => `b${i}\n`).join("");
    const t0 = Date.now();
    const d = lineDiff(a, b);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(d.hunks).toEqual([[1, 20000]]);
    expect([d.additions, d.deletions]).toEqual([20000, 20000]);
  });
});

describe("diffHunks", () => {
  it("separates replacements, insertions and deletions", () => {
    const head = edit(BASE, (l) => {
      l[1] = "two"; // replace l2
      l.splice(5, 0, "ins"); // insert after l5
      l.splice(9, 1); // delete l9 (index shifted by the insertion)
    });
    expect(diffHunks(BASE, head)).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
      { oldStart: 5, oldLines: 0, newStart: 6, newLines: 1 },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 0 },
    ]);
  });
});

describe("unifiedDiff", () => {
  const products = `export function formatPrice(cents) {\n  return "$" + (cents / 100).toFixed(2);\n}\n`;

  it("writes a git-style diff for a modified file", () => {
    const head = products.replace("(cents)", '(cents, currency = "USD")');
    expect(unifiedDiff("src/products.js", products, head)).toBe(
      [
        "--- a/src/products.js",
        "+++ b/src/products.js",
        "@@ -1,3 +1,3 @@",
        "-export function formatPrice(cents) {",
        '+export function formatPrice(cents, currency = "USD") {',
        '   return "$" + (cents / 100).toFixed(2);',
        " }",
        "",
      ].join("\n"),
    );
  });

  it("uses /dev/null for an added and a deleted file", () => {
    expect(unifiedDiff("src/cart.js", null, "a\nb\n")).toBe("--- /dev/null\n+++ b/src/cart.js\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(unifiedDiff("src/cart.js", "a\n", null)).toBe("--- a/src/cart.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n");
    expect(unifiedDiff("empty.txt", null, "")).toBe("--- /dev/null\n+++ b/empty.txt\n");
  });

  it("marks a missing final newline", () => {
    expect(unifiedDiff("f.txt", "a\nb", "a\nb\n")).toBe(
      "--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n",
    );
  });

  it("joins close hunks and splits distant ones", () => {
    const base = numbered(20);
    const close = edit(base, (l) => {
      l[2] = "x";
      l[7] = "y";
    });
    expect(unifiedDiff("f", base, close).match(/^@@/gm)).toHaveLength(1);
    const far = edit(base, (l) => {
      l[1] = "x";
      l[17] = "y";
    });
    const out = unifiedDiff("f", base, far);
    expect(out.match(/^@@.*$/gm)).toEqual(["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
  });

  it("honours the context size", () => {
    const head = edit(BASE, (l) => (l[4] = "five"));
    expect(unifiedDiff("f", BASE, head, 0)).toBe("--- a/f\n+++ b/f\n@@ -5 +5 @@\n-l5\n+five\n");
    expect(unifiedDiff("f", BASE, head, 1)).toBe("--- a/f\n+++ b/f\n@@ -4,3 +4,3 @@\n l4\n-l5\n+five\n l6\n");
  });

  it("returns an empty string when nothing changed", () => {
    expect(unifiedDiff("f", BASE, BASE)).toBe("");
    expect(unifiedDiff("f", null, null)).toBe("");
    expect(unifiedDiff("f", BASE.replace(/\n/g, "\r\n"), BASE)).toBe("");
  });
});

describe("rangesOverlap", () => {
  it("compares inclusive ranges", () => {
    expect(rangesOverlap([1, 3], [3, 5])).toBe(true);
    expect(rangesOverlap([1, 3], [4, 5])).toBe(false);
    expect(rangesOverlap([4, 5], [1, 3])).toBe(false);
    expect(rangesOverlap([2, 8], [4, 5])).toBe(true);
  });

  it("allows slack lines", () => {
    expect(rangesOverlap([1, 3], [5, 6], 1)).toBe(false);
    expect(rangesOverlap([1, 3], [5, 6], 2)).toBe(true);
    expect(rangesOverlap([5, 6], [1, 3], 2)).toBe(true);
  });

  it("treats a pure insertion point [n, n] like line n", () => {
    expect(rangesOverlap([4, 4], [4, 9])).toBe(true);
    expect(rangesOverlap([0, 0], [1, 2])).toBe(false);
    expect(rangesOverlap([0, 0], [1, 2], 1)).toBe(true);
  });

  it("normalizes reversed ranges", () => {
    expect(rangesOverlap([5, 3], [4, 4])).toBe(true);
  });
});

describe("isProbablyText", () => {
  const enc = new TextEncoder();

  it("accepts ASCII, UTF-8 and empty input", () => {
    expect(isProbablyText(enc.encode("export const x = 1;\n"))).toBe(true);
    expect(isProbablyText(enc.encode("Größe: 10 € — naïve café 書店 🚢\n"))).toBe(true);
    expect(isProbablyText(new Uint8Array())).toBe(true);
  });

  it("rejects a NUL byte in the first 8000 bytes", () => {
    expect(isProbablyText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))).toBe(false);
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(isProbablyText(late)).toBe(true);
    late[7999] = 0;
    expect(isProbablyText(late)).toBe(false);
  });

  it("rejects mostly invalid UTF-8 but accepts a few Latin-1 bytes", () => {
    let seed = 7;
    const noise = Uint8Array.from({ length: 4000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 1 + (seed % 255);
    });
    expect(isProbablyText(noise)).toBe(false);
    const latin1 = Uint8Array.from("caf\xe9 cr\xe8me br\xfbl\xe9e, then a longer run of ordinary ASCII text in this file\n", (c) => c.charCodeAt(0));
    expect(isProbablyText(latin1)).toBe(true);
  });

  it("does not count a multi-byte character cut by the 8000-byte window", () => {
    const bytes = new Uint8Array(8002).fill(0x61);
    bytes.set([0xe2, 0x82, 0xac], 7999); // "€" across the window edge
    expect(isProbablyText(bytes)).toBe(true);
  });
});
