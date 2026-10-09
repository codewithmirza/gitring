import { describe, expect, it } from "vitest";
import { merge3, MARKER_OURS, MARKER_SEPARATOR, MARKER_THEIRS } from "../../src/core/text/merge3";

const RENDER = [
  'import { formatPrice } from "./products.js";', // 1
  'import { css } from "./styles.js";', // 2
  "", // 3
  "export function header() {", // 4
  '  return `<header><h1>Bookshop</h1></header>`;', // 5
  "}", // 6
  "", // 7
  "export function renderItem(p) {", // 8
  "  return `<li>${p.title} ${formatPrice(p.cents)}</li>`;", // 9
  "}", // 10
  "", // 11
  "export function renderPage(items) {", // 12
  "  return `<style>${css}</style>${header()}<ul>${items.map(renderItem).join(\"\")}</ul>`;", // 13
  "}", // 14
].join("\n") + "\n";

const replaceLine = (text: string, n: number, line: string) => {
  const lines = text.split("\n");
  lines[n - 1] = line;
  return lines.join("\n");
};
const insertAfter = (text: string, n: number, ...add: string[]) => {
  const lines = text.split("\n");
  lines.splice(n, 0, ...add);
  return lines.join("\n");
};

describe("merge3 (ours = main, theirs = attempt)", () => {
  it("is clean when only one side changed, or both made the same change", () => {
    const main = replaceLine(RENDER, 5, "  return `<header><h1>Bookshop</h1><nav></nav></header>`;");
    expect(merge3(RENDER, main, RENDER)).toEqual({ clean: true, content: main, conflicts: [] });
    expect(merge3(RENDER, RENDER, main)).toEqual({ clean: true, content: main, conflicts: [] });
    expect(merge3(RENDER, main, main)).toEqual({ clean: true, content: main, conflicts: [] });
  });

  it("merges changes in different regions of the file", () => {
    const main = replaceLine(RENDER, 5, "  return `<header class=dark><h1>Bookshop</h1></header>`;");
    const attempt = replaceLine(RENDER, 9, "  return `<li>${p.title} ${formatPrice(p.cents, currency)}</li>`;");
    const out = merge3(RENDER, main, attempt);
    expect(out.clean).toBe(true);
    expect(out.conflicts).toEqual([]);
    expect(out.content).toContain("<header class=dark>");
    expect(out.content).toContain("formatPrice(p.cents, currency)");
    expect(out.content.split("\n")).toHaveLength(RENDER.split("\n").length);
  });

  it("merges insertions at different places, and the same change made on both sides inside other edits", () => {
    const main = insertAfter(RENDER, 14, "", "export const version = 2;");
    const attempt = insertAfter(RENDER, 7, "export function staffPicks() {", "  return [];", "}", "");
    const out = merge3(RENDER, main, attempt);
    expect(out.clean).toBe(true);
    expect(out.content).toContain("export function staffPicks()");
    expect(out.content.trimEnd().endsWith("export const version = 2;")).toBe(true);
  });

  it("reports a conflict with git-style markers and the base range", () => {
    const main = replaceLine(RENDER, 5, "  return `<header class=dark><h1>Bookshop</h1></header>`;");
    const attempt = replaceLine(RENDER, 5, "  return `<header><h1>Bookshop</h1><input type=search></header>`;");
    const out = merge3(RENDER, main, attempt);
    expect(out.clean).toBe(false);
    expect(out.conflicts).toEqual([
      {
        baseRange: [5, 5],
        ours: ["  return `<header class=dark><h1>Bookshop</h1></header>`;"],
        theirs: ["  return `<header><h1>Bookshop</h1><input type=search></header>`;"],
      },
    ]);
    const lines = out.content.split("\n");
    const at = lines.indexOf(MARKER_OURS);
    expect(lines.slice(at, at + 5)).toEqual([
      "<<<<<<< main",
      "  return `<header class=dark><h1>Bookshop</h1></header>`;",
      "=======",
      "  return `<header><h1>Bookshop</h1><input type=search></header>`;",
      ">>>>>>> attempt",
    ]);
    expect(lines[at - 1]).toBe("export function header() {");
    expect(lines[at + 5]).toBe("}");
    expect(MARKER_SEPARATOR).toBe("=======");
    expect(MARKER_THEIRS).toBe(">>>>>>> attempt");
  });

  it("conflicts when both sides insert different lines at the same point (insertion range [n, n])", () => {
    const main = insertAfter(RENDER, 14, "export const a = 1;");
    const attempt = insertAfter(RENDER, 14, "export const b = 2;");
    const out = merge3(RENDER, main, attempt);
    expect(out.clean).toBe(false);
    expect(out.conflicts[0].baseRange).toEqual([14, 14]);
    expect(out.conflicts[0].ours).toEqual(["export const a = 1;"]);
    expect(out.conflicts[0].theirs).toEqual(["export const b = 2;"]);
  });

  it("moves common leading and trailing lines out of a conflict", () => {
    const base = "a\nb\nc\n";
    const out = merge3(base, "a\nX\nsame\nc\n", "a\nY\nsame\nc\n");
    expect(out.clean).toBe(false);
    expect(out.conflicts[0]).toMatchObject({ ours: ["X"], theirs: ["Y"] });
    expect(out.content).toBe(`a\n${MARKER_OURS}\nX\n${MARKER_SEPARATOR}\nY\n${MARKER_THEIRS}\nsame\nc\n`);
  });

  it("handles empty bases (add/add) and deletions", () => {
    expect(merge3("", "same\n", "same\n")).toEqual({ clean: true, content: "same\n", conflicts: [] });
    const addAdd = merge3("", "export const a = 1;\n", "export const b = 2;\n");
    expect(addAdd.clean).toBe(false);
    expect(addAdd.conflicts[0].baseRange).toEqual([0, 0]);
    // main deletes a function, the attempt edits another one.
    const lines = RENDER.split("\n");
    const main = [...lines.slice(0, 3), ...lines.slice(7)].join("\n"); // header() removed
    const attempt = replaceLine(RENDER, 13, "  return `${header()}<ol>${items.map(renderItem).join(\"\")}</ol>`;");
    const out = merge3(RENDER, main, attempt);
    expect(out.clean).toBe(true);
    expect(out.content).not.toContain("export function header()");
    expect(out.content).toContain("<ol>");
  });

  it("follows the side that changed the final newline", () => {
    expect(merge3("a\nb", "a\nB", "a\nb\n").content).toBe("a\nB\n");
    expect(merge3("a\nb\n", "A\nb\n", "a\nb").content).toBe("A\nb");
    expect(merge3("x\n", "", "x\n").content).toBe("");
  });

  it("does not split on CR and keeps CRLF lines intact", () => {
    const base = "a\r\nb\r\nc\r\n";
    const out = merge3(base, "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n");
    expect(out).toEqual({ clean: true, content: "A\r\nb\r\nC\r\n", conflicts: [] });
  });
});
