/**
 * The meaning of a change (src/core/analysis/meaning.ts): comment-only, formatting-only, docs-only,
 * test-only or logic, from the versions of each file. JS and TS are compared by their tokens without
 * comments; a doubt counts as logic, never as less.
 */
import { describe, expect, it } from "vitest";
import { CHANGE_KINDS, KIND_LABEL, SAFE_KINDS, changeMeaning, fileChangeKind, kindWords, pathKind, sameTokens, tokensOf } from "../../src/core/analysis/meaning";
import type { ChangeKind } from "../../src/core/types";
import { steViolations } from "../coord/ste";

const PRICE = 'export function price(cents) {\n  // cents to dollars\n  return "$" + (cents / 100).toFixed(2);\n}\n';
const PRICE_TS = 'export function price(cents: number): string {\n  // cents to dollars\n  return "$" + (cents / 100).toFixed(2);\n}\n';
const PRICE_TSX = 'export function Price({ cents }: { cents: number }) {\n  // cents to dollars\n  return <b>{"$" + (cents / 100).toFixed(2)}</b>;\n}\n';

const kind = (path: string, base: string | null, head: string | null): ChangeKind => fileChangeKind({ path, base, head });

describe("pathKind", () => {
  it("knows documentation by its extension or its name", () => {
    for (const p of ["README.md", "docs/guide.mdx", "notes.txt", "CHANGELOG", "LICENSE", "docs/api.rst"]) expect(pathKind(p), p).toBe("docs");
  });

  it("knows tests by their folder or their name", () => {
    for (const p of ["tests/a.test.js", "test/b.js", "src/__tests__/c.ts", "src/d.spec.ts", "src/e_test.go", "src/__snapshots__/f.snap", "spec/g.rb"]) expect(pathKind(p), p).toBe("test");
  });

  it("calls the rest code", () => {
    for (const p of ["src/a.js", "package.json", "wrangler.jsonc", "src/testing.ts", "src/contest.js"]) expect(pathKind(p), p).toBe("code");
  });
});

describe("tokens of JS and TS", () => {
  it("reads the tokens without comments and white space", () => {
    const a = tokensOf("const a = 1; // one\n", "x.js");
    const b = tokensOf("/* one */ const   a=1;", "x.js");
    expect(a).toEqual(b);
    expect(a!.length).toBe(5);
  });

  it("reads TypeScript, TSX and JSX", () => {
    expect(tokensOf(PRICE_TS, "x.ts")).not.toBeNull();
    expect(tokensOf(PRICE_TSX, "x.tsx")).not.toBeNull();
    expect(tokensOf('export const A = () => <a href="x">x</a>;\n', "x.jsx")).not.toBeNull();
  });

  it("gives null for source that the tokenizer cannot read", () => {
    expect(tokensOf("const a = 'unterminated\n", "x.js")).toBeNull();
    expect(sameTokens("const a = 'unterminated\n", "const a = 1;\n", "x.js")).toBeNull();
  });

  it("tells the same tokens from other tokens", () => {
    expect(sameTokens("a = 1 // x", "a = 1 /* y */", "x.js")).toBe(true);
    expect(sameTokens("a = 1", "a = 2", "x.js")).toBe(false);
    expect(sameTokens("a = 1", "a = 1; b = 2", "x.js")).toBe(false);
  });
});

describe("fileChangeKind", () => {
  it("sees a comment-only change of JS", () => {
    expect(kind("src/price.js", PRICE, PRICE.replace("// cents to dollars", "// cents to dollars, rounded"))).toBe("comment-only");
    expect(kind("src/price.js", PRICE, `/** The price. */\n${PRICE}`)).toBe("comment-only");
  });

  it("sees a comment-only change of TS and TSX", () => {
    expect(kind("src/price.ts", PRICE_TS, PRICE_TS.replace("// cents to dollars", "// to dollars"))).toBe("comment-only");
    expect(kind("src/Price.tsx", PRICE_TSX, PRICE_TSX.replace("// cents to dollars", "// to dollars"))).toBe("comment-only");
  });

  it("sees a formatting-only change: white space only, in a JS or TS file", () => {
    expect(kind("src/price.js", PRICE, PRICE.replace("  return", "    return"))).toBe("formatting-only");
    expect(kind("src/price.js", PRICE, PRICE.replace(/\n/g, "\r\n"))).toBe("formatting-only");
  });

  it("does not trust white space in other formats: it can change the meaning", () => {
    expect(kind("tool.py", "if a:\n    run()\n", "if a:\nrun()\n")).toBe("logic");
    expect(kind("ci.yml", "on:\n  push:\n", "on:\npush:\n")).toBe("logic");
    expect(kind("config.json", '{"a b":1}\n', '{"ab":1}\n')).toBe("logic");
    expect(kind("src/a.js", 'const a = "x y";\n', 'const a = "xy";\n')).toBe("logic");
  });

  it("calls only extension-less documentation names docs: history.js and notice.yml are code", () => {
    expect(kind("LICENSE", "a\n", "b\n")).toBe("docs-only");
    expect(kind("src/history.js", "run();\n", "run2();\n")).toBe("logic");
    expect(kind(".github/workflows/notice.yml", "a: 1\n", "a: 2\n")).toBe("logic");
  });

  it("calls a change of comments and white space together comment-only", () => {
    expect(kind("src/price.js", PRICE, PRICE.replace("  // cents to dollars\n", "    // dollars\n"))).toBe("comment-only");
  });

  it("calls a change of the code logic", () => {
    expect(kind("src/price.js", PRICE, PRICE.replace("toFixed(2)", "toFixed(0)"))).toBe("logic");
    // The quotes of a string or the form of a number count as the code: the tokens differ.
    expect(kind("src/price.js", PRICE, PRICE.replace('"$"', "'$'"))).toBe("logic");
    expect(kind("src/price.js", PRICE, PRICE.replace("100", "1e2"))).toBe("logic");
  });

  it("calls a change of code in a comment logic when it is code: the tokens differ", () => {
    expect(kind("src/a.js", "const a = 1;\n", "// const a = 1;\nconst a = 2;\n")).toBe("logic");
  });

  it("calls a JS file that the tokenizer cannot read logic", () => {
    const bad = "const a = 'unterminated\n";
    expect(kind("src/a.js", bad, `${bad}// note\n`)).toBe("logic");
    expect(kind("src/a.js", bad, `  ${bad}`)).toBe("logic");
  });

  it("calls every change of a documentation file docs-only, also a new or deleted one", () => {
    expect(kind("README.md", "# A\n", "# A\n\nMore.\n")).toBe("docs-only");
    expect(kind("docs/guide.md", null, "# Guide\n")).toBe("docs-only");
    expect(kind("docs/old.txt", "old\n", null)).toBe("docs-only");
  });

  it("calls a change of a test file test-only, and a comment in it comment-only", () => {
    expect(kind("tests/price.test.js", "test('a', () => 1);\n", "test('a', () => 2);\n")).toBe("test-only");
    expect(kind("tests/price.test.js", null, "test('a', () => 1);\n")).toBe("test-only");
    expect(kind("tests/price.test.js", "test('a', () => 1);\n", "// the test\ntest('a', () => 1);\n")).toBe("comment-only");
    expect(kind("tests/fixtures/data.json", '{"a":1}', '{"a":2}')).toBe("test-only");
  });

  it("calls a new or deleted code file logic", () => {
    expect(kind("src/new.js", null, "export const n = 1;\n")).toBe("logic");
    expect(kind("src/old.js", "export const o = 1;\n", null)).toBe("logic");
    expect(kind("src/empty.js", null, "")).toBe("logic");
  });
});

describe("changeMeaning", () => {
  it("takes the kind that needs the most care, and keeps the kind of each file", () => {
    const m = changeMeaning([
      { path: "README.md", base: "# A\n", head: "# A!\n" },
      { path: "src/price.js", base: PRICE, head: PRICE.replace("// cents to dollars", "// dollars") },
      { path: "tests/price.test.js", base: "test('a', () => 1);\n", head: "test('a', () => 2);\n" },
    ]);
    expect(m.kind).toBe("test-only");
    expect(m.files).toEqual({ "README.md": "docs-only", "src/price.js": "comment-only", "tests/price.test.js": "test-only" });
  });

  it("orders the kinds from the safest to the one that needs the most care", () => {
    expect(CHANGE_KINDS).toEqual(["comment-only", "formatting-only", "docs-only", "test-only", "logic"]);
    expect([...SAFE_KINDS]).toEqual(["comment-only", "formatting-only", "docs-only"]);
    expect(changeMeaning([{ path: "src/a.js", base: "a = 1 // x\n", head: "a = 1 // y\n" }]).kind).toBe("comment-only");
    expect(changeMeaning([{ path: "src/a.js", base: "a = 1\n", head: "a = 1;\n" }]).kind).toBe("logic");
  });

  it("counts binary files as logic, or as tests by their path", () => {
    expect(changeMeaning([], ["img/logo.png"])).toEqual({ kind: "logic", files: { "img/logo.png": "logic" } });
    expect(changeMeaning([], ["tests/fixtures/logo.png"]).kind).toBe("test-only");
    expect(changeMeaning([{ path: "README.md", base: "a", head: "b" }], ["img/logo.png"]).kind).toBe("logic");
  });

  it("calls an empty change formatting-only: nothing differs", () => {
    expect(changeMeaning([]).kind).toBe("formatting-only");
  });
});

describe("the words", () => {
  it("has one plain sentence and one short label for each kind", () => {
    for (const k of CHANGE_KINDS) {
      expect(kindWords(k)).toMatch(/\.$/);
      expect(steViolations(kindWords(k)), k).toEqual([]);
      expect(KIND_LABEL[k].length, k).toBeGreaterThan(0);
    }
    expect(kindWords("comment-only")).toBe("Only comments change.");
    expect(kindWords("formatting-only")).toBe("Only white space changes.");
    expect(kindWords("logic")).toBe("The code logic changes.");
  });
});
