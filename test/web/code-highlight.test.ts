import { describe, expect, it } from "vitest";
import { languageOf, LineHighlighter, highlighterFor, runsOf, tokenizeAll } from "../../web/src/views/code/highlight";

/**
 * Runs with a class, as "word|class" strings; plain runs are left out. Two tokens of the same class
 * with only spaces between them form one run (fewer spans), so runs split at spaces here.
 */
function classes(path: string, src: string): string[][] {
  const lines = src.split("\n");
  const tokens = tokenizeAll(languageOf(path), lines);
  return lines.map((l, i) =>
    runsOf(l, tokens[i])
      .filter(([t, c]) => c && t.trim())
      .flatMap(([t, c]) => (c === "tk-com" || c === "tk-str" || c === "tk-head" || c === "tk-meta" || c === "tk-code" || c === "tk-strong" ? [t.trim()] : t.trim().split(/\s+/)).map((w) => `${w}|${c.replace("tk-", "")}`)),
  );
}

describe("languageOf", () => {
  it("knows the languages by extension", () => {
    expect(languageOf("src/a.ts")).toEqual({ lang: "ts", jsx: false });
    expect(languageOf("src/a.tsx")).toEqual({ lang: "ts", jsx: true });
    expect(languageOf("a.jsx")?.jsx).toBe(true);
    expect(languageOf("README.md")?.lang).toBe("md");
    expect(languageOf("main.go")?.lang).toBe("go");
    expect(languageOf("app.py")?.lang).toBe("py");
    expect(languageOf("index.html")?.lang).toBe("html");
    expect(languageOf("site.css")?.lang).toBe("css");
    expect(languageOf("package.json")?.lang).toBe("json");
    expect(languageOf("LICENSE")).toBeNull();
    expect(languageOf("Makefile", "text")).toBeNull();
  });
});

describe("JavaScript and TypeScript", () => {
  it("colors keywords, strings, numbers, calls and properties", () => {
    const [l] = classes("a.js", `const total = items.reduce((s, x) => s + x.price * 1.5, 0); // sum`);
    expect(l).toContain("const|kw");
    expect(l).toContain("reduce|fn");
    expect(l).toContain("price|prop");
    expect(l).toContain("1.5|num");
    expect(l).toContain("// sum|com");
  });

  it("keeps a block comment over several lines", () => {
    const c = classes("a.js", "/* one\n two */ let x = 1");
    expect(c[0]).toEqual(["/* one|com"]);
    expect(c[1][0]).toBe("two */|com");
    expect(c[1]).toContain("let|kw");
  });

  it("follows template strings with expressions over lines", () => {
    const c = classes("a.ts", "const s = `a ${fn(1)} b\nc ${`inner`} d`;\nreturn s");
    expect(c[0]).toContain("fn|fn");
    expect(c[0]).toContain("1|num");
    expect(c[1][0]).toBe("c|str");
    expect(c[1]).toContain("`inner`|str");
    expect(c[2]).toContain("return|kw");
  });

  it("tells a regex from a division", () => {
    const r = classes("a.js", "const re = /a+b/g; const d = x / 2 / y;");
    expect(r[0]).toContain("/a+b/g|re");
    expect(r[0].filter((t) => t.endsWith("|re"))).toHaveLength(1);
  });

  it("colors TypeScript types and keywords", () => {
    const [l] = classes("a.ts", "export interface Cart { items: Item[]; total: number }");
    expect(l).toContain("interface|kw");
    expect(l).toContain("Cart|type");
    expect(l).toContain("Item|type");
    expect(l).toContain("number|type");
  });

  it("does not color an object key that is also a keyword", () => {
    const [l] = classes("a.ts", "const o = { type: 1, default: 2 }");
    expect(l).not.toContain("type|kw");
  });

  it("reads JSX tags, attributes and children over lines", () => {
    const c = classes("a.jsx", 'return (\n  <div className="row" onClick={() => go(1)}>\n    Hello {name}\n  </div>\n);');
    expect(c[1]).toContain("div|tag");
    expect(c[1]).toContain("className|attr");
    expect(c[1]).toContain('"row"|str');
    expect(c[1]).toContain("go|fn");
    expect(c[2]).not.toContain("Hello|kw");
    expect(c[3]).toContain("div|tag");
    expect(c[4]).not.toContain("div|tag");
  });

  it("does not read a comparison as JSX", () => {
    const [l] = classes("a.js", "if (a < b && c > d) run()");
    expect(l.some((t) => t.endsWith("|tag"))).toBe(false);
    expect(l).toContain("run|fn");
  });
});

describe("other languages", () => {
  it("JSON keys and values", () => {
    const [l] = classes("a.json", '{ "name": "gitring", "n": 2, "ok": true, "x": null }');
    expect(l).toContain('"name"|key');
    expect(l).toContain('"gitring"|str');
    expect(l).toContain("2|num");
    expect(l).toContain("true|lit");
  });

  it("CSS selectors, properties, values and comments", () => {
    const c = classes("a.css", "/* theme */\n.card:hover > a {\n  color: var(--accent);\n  margin: 0 4px !important;\n}");
    expect(c[0]).toEqual(["/* theme */|com"]);
    expect(c[1]).toContain(".card|sel");
    expect(c[1]).toContain(":hover|kw");
    expect(c[2]).toContain("color|prop");
    expect(c[2]).toContain("var|fn");
    expect(c[2]).toContain("--accent|var");
    expect(c[3]).toContain("4px|num");
    expect(c[3]).toContain("!important|kw");
  });

  it("HTML tags, attributes, entities and a script block", () => {
    const c = classes("a.html", '<!-- top -->\n<a href="/x" data-n=3>Tom &amp; Jerry</a>\n<script>\nconst x = 1;\n</script>');
    expect(c[0]).toEqual(["<!-- top -->|com"]);
    expect(c[1]).toContain("a|tag");
    expect(c[1]).toContain("href|attr");
    expect(c[1]).toContain('"/x"|str');
    expect(c[1]).toContain("3|str");
    expect(c[1]).toContain("&amp;|esc");
    expect(c[3]).toContain("const|kw");
    expect(c[3]).toContain("1|num");
    expect(c[4]).toContain("script|tag");
  });

  it("Markdown headings, inline code, links and fenced code", () => {
    const c = classes("a.md", "# Title\nUse `npm test` and [docs](https://x.dev).\n```js\nconst a = 1;\n```\n- item **bold**");
    expect(c[0]).toEqual(["# Title|head"]);
    expect(c[1]).toContain("`npm test`|code");
    expect(c[1]).toContain("docs|link");
    expect(c[3]).toContain("const|kw");
    expect(c[4]).toEqual(["```|meta"]);
    expect(c[5]).toContain("-|punc");
    expect(c[5]).toContain("**bold**|strong");
  });

  it("Python keywords, decorators, defs and triple-quoted strings", () => {
    const c = classes("a.py", '@cache\ndef total(items):\n    """Sum\n    of prices."""\n    return sum(i.price for i in items) # done');
    expect(c[0]).toEqual(["@cache|meta"]);
    expect(c[1]).toContain("def|kw");
    expect(c[1]).toContain("total|fn");
    expect(c[2]).toEqual(['"""Sum|str']);
    expect(c[3]).toEqual(['of prices."""|str']);
    expect(c[4]).toContain("return|kw");
    expect(c[4]).toContain("sum|fn");
    expect(c[4]).toContain("price|prop");
    expect(c[4]).toContain("# done|com");
  });

  it("Go keywords, types, raw strings and funcs", () => {
    const c = classes("a.go", "package main\nfunc (s *Shop) Total(n int) error {\n  q := `raw\nline`\n  return nil\n}");
    expect(c[0]).toContain("package|kw");
    expect(c[1]).toContain("Shop|type");
    expect(c[1]).toContain("Total|fn");
    expect(c[1]).toContain("int|type");
    expect(c[1]).toContain("error|type");
    expect(c[2]).toContain("`raw|str");
    expect(c[3][0]).toBe("line`|str");
    expect(c[4]).toContain("nil|lit");
  });
});

describe("LineHighlighter", () => {
  it("highlights in steps and gives the same tokens as one pass", () => {
    const lines = Array.from({ length: 500 }, (_, i) => (i % 50 === 0 ? "/* a\n" : i % 50 === 1 ? "b */ const x = `y" : `let v${i} = ${i}; // n`));
    const info = languageOf("big.ts");
    const all = tokenizeAll(info, lines);
    const lh = new LineHighlighter(lines, highlighterFor(info)!);
    let rounds = 0;
    while (lh.run(0, lh.done + 37)) rounds++;
    expect(rounds).toBeGreaterThan(5);
    expect(lh.finished).toBe(true);
    expect(lh.tokens).toEqual(all);
  });

  it("covers every character of a line", () => {
    const line = "const a = { b: [1, 2, 'x'] } /* c */";
    const [tokens] = tokenizeAll(languageOf("a.js"), [line]);
    expect(tokens[tokens.length - 2]).toBe(line.length);
    expect(runsOf(line, tokens).map(([t]) => t).join("")).toBe(line);
  });
});
