import { describe, expect, it } from "vitest";
import { compose, type ComposeInput } from "../../src/core/land/compose";
import type { Snapshot } from "../../src/core/git/snapshot";

/* A tiny content-addressed blob store (fake shas; compose only compares them). */
function store() {
  const blobs = new Map<string, string | Uint8Array>();
  const shaOf = (content: string | Uint8Array): string => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(`t${content}`) : new Uint8Array([98, ...content]);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (const b of bytes) {
      h1 = Math.imul(h1 ^ b, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ b, 2246822519) >>> 0;
    }
    return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(3).slice(0, 40);
  };
  const snap = (files: Record<string, string | Uint8Array | { content: string | Uint8Array; mode: string }>): Snapshot => {
    const s: Snapshot = new Map();
    for (const [path, v] of Object.entries(files)) {
      const content = typeof v === "string" || v instanceof Uint8Array ? v : v.content;
      const mode = typeof v === "string" || v instanceof Uint8Array ? "100644" : v.mode;
      const sha = shaOf(content);
      blobs.set(sha, content);
      s.set(path, { sha, mode });
    }
    return s;
  };
  const io = {
    readText: async (sha: string) => {
      const v = blobs.get(sha);
      if (v === undefined) throw new Error(`missing blob ${sha}`);
      return typeof v === "string" ? v : null;
    },
    readBytes: async (sha: string) => {
      const v = blobs.get(sha);
      return v instanceof Uint8Array ? v : v === undefined ? null : new TextEncoder().encode(v);
    },
  };
  return { snap, io };
}

const PRODUCTS = [
  "export const products = [",
  '  { id: 1, title: "Dune", cents: 1299 },',
  '  { id: 2, title: "Emma", cents: 899 },',
  "];",
  "",
  "export function formatPrice(cents) {",
  "  return `$${(cents / 100).toFixed(2)}`;",
  "}",
].join("\n") + "\n";

const RENDER = [
  'import { formatPrice } from "./products.js";',
  "",
  "export function header() {",
  "  return `<header><h1>Bookshop</h1></header>`;",
  "}",
  "",
  "export function renderItem(p) {",
  "  return `<li>${p.title} ${formatPrice(p.cents)}</li>`;",
  "}",
].join("\n") + "\n";

const STYLES = "export const css = `body { font: 16px system-ui; }`;\n";
const sub = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`fixture: ${from} not found`);
  return text.replace(from, to);
};

describe("compose", () => {
  it("fast-forward: main == base → the attempt's changes relative to base", async () => {
    const { snap, io } = store();
    const base = snap({ "src/products.js": PRODUCTS, "src/render.js": RENDER, "src/styles.js": STYLES });
    const attempt = snap({
      "src/products.js": sub(PRODUCTS, "formatPrice(cents)", "formatPrice(cents, currency = \"USD\")"),
      "src/render.js": RENDER,
      "tests/currency.test.js": 'import { test } from "../harness/test.js";\n',
    });
    const main = new Map(base);
    const out = await compose({ base, main, attempt, ...io });
    expect(out.method).toBe("fast-forward");
    expect(out.clean).toBe(true);
    expect(out.touched).toEqual(["src/products.js", "src/styles.js", "tests/currency.test.js"]);
    expect(out.changes).toEqual([
      { path: "src/products.js", content: sub(PRODUCTS, "formatPrice(cents)", 'formatPrice(cents, currency = "USD")'), mode: "100644" },
      { path: "src/styles.js", content: null },
      { path: "tests/currency.test.js", content: 'import { test } from "../harness/test.js";\n', mode: "100644" },
    ]);
  });

  it("clean merge: main moved; different files and different regions merge", async () => {
    const { snap, io } = store();
    const base = snap({ "src/products.js": PRODUCTS, "src/render.js": RENDER, "src/styles.js": STYLES });
    // main: dark mode landed (header + styles).
    const mainRender = sub(RENDER, "<header>", '<header class="dark">');
    const main = snap({ "src/products.js": PRODUCTS, "src/render.js": mainRender, "src/styles.js": STYLES + "export const dark = `body { background: #111; }`;\n" });
    // attempt: currency (products.js + the renderItem call) and a new test file.
    const attemptRender = sub(RENDER, "formatPrice(p.cents)", "formatPrice(p.cents, currency)");
    const attempt = snap({
      "src/products.js": sub(PRODUCTS, "formatPrice(cents)", "formatPrice(cents, currency)"),
      "src/render.js": attemptRender,
      "src/styles.js": STYLES,
      "tests/currency.test.js": "// currency\n",
    });
    const out = await compose({ base, main, attempt, ...io });
    expect(out.method).toBe("merge");
    expect(out.clean).toBe(true);
    expect(out.conflicts).toEqual([]);
    expect(out.touched).toEqual(["src/products.js", "src/render.js", "tests/currency.test.js"]);
    const byPath = Object.fromEntries(out.changes.map((c) => [c.path, c.content]));
    expect(Object.keys(byPath).sort()).toEqual(["src/products.js", "src/render.js", "tests/currency.test.js"]);
    expect(byPath["src/render.js"]).toContain('<header class="dark">');
    expect(byPath["src/render.js"]).toContain("formatPrice(p.cents, currency)");
    // styles.js changed on main only: nothing to apply.
    expect(byPath["src/styles.js"]).toBeUndefined();
  });

  it("conflict: both sides edit the same header line", async () => {
    const { snap, io } = store();
    const base = snap({ "src/render.js": RENDER });
    const main = snap({ "src/render.js": sub(RENDER, "<h1>Bookshop</h1>", '<h1>Bookshop</h1><button id="theme">Dark</button>') });
    const attempt = snap({ "src/render.js": sub(RENDER, "<h1>Bookshop</h1>", '<h1>Bookshop</h1><input type="search">') });
    const out = await compose({ base, main, attempt, ...io });
    expect(out).toMatchObject({ method: "merge", clean: false, changes: [], touched: ["src/render.js"] });
    expect(out.conflicts).toEqual([{ path: "src/render.js", reason: "both-modified", detail: "1 conflict region at base lines 4." }]);
  });

  it("identical results on both sides need no change", async () => {
    const { snap, io } = store();
    const base = snap({ "src/render.js": RENDER, "src/styles.js": STYLES, "old.txt": "x\n" });
    const same = sub(RENDER, "Bookshop", "Book shop");
    const main = snap({ "src/render.js": same, "src/styles.js": STYLES + "/* main */\n" });
    const attempt = snap({ "src/render.js": same, "src/styles.js": STYLES });
    const out = await compose({ base, main, attempt, ...io });
    expect(out).toMatchObject({ method: "merge", clean: true, changes: [] });
    // Both deleted old.txt: the attempt touched it, main already has the result.
    expect(out.touched).toEqual(["old.txt", "src/render.js"]);
  });

  it("modify-delete in both directions", async () => {
    const { snap, io } = store();
    const base = snap({ "src/products.js": PRODUCTS, "src/render.js": RENDER });
    const main = snap({ "src/products.js": PRODUCTS + "// main\n" }); // main deleted render.js, changed products.js
    const attempt = snap({ "src/render.js": RENDER + "// attempt\n" }); // attempt deleted products.js, changed render.js
    const out = await compose({ base, main, attempt, ...io });
    expect(out.clean).toBe(false);
    expect(out.conflicts).toEqual([
      { path: "src/products.js", reason: "modify-delete", detail: "Main changed the file. The attempt deleted it." },
      { path: "src/render.js", reason: "modify-delete", detail: "Main deleted the file. The attempt changed it." },
    ]);
  });

  it("add-add: same content is clean, different content conflicts", async () => {
    const { snap, io } = store();
    const base = snap({ "src/render.js": RENDER });
    const main = snap({ "src/render.js": RENDER, "tests/a.test.js": "same\n", "tests/b.test.js": "export const a = 1;\n" });
    const attempt = snap({ "src/render.js": RENDER, "tests/a.test.js": "same\n", "tests/b.test.js": "export const b = 2;\n" });
    const out = await compose({ base, main, attempt, ...io });
    expect(out.changes).toEqual([]);
    expect(out.conflicts).toEqual([{ path: "tests/b.test.js", reason: "add-add", detail: "1 conflict region at base lines 0." }]);
  });

  it("binary files: both changed → conflict; attempt only → bytes (when readable)", async () => {
    const { snap, io } = store();
    const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, n]);
    const base = snap({ "logo.png": png(1), "icon.png": png(5) });
    const main = snap({ "logo.png": png(2), "icon.png": png(5) });
    const attempt = snap({ "logo.png": png(3), "icon.png": png(6) });
    const out = await compose({ base, main, attempt, ...io });
    expect(out.conflicts).toEqual([{ path: "logo.png", reason: "binary", detail: "Both sides changed a binary file." }]);
    expect(out.changes).toEqual([{ path: "icon.png", content: png(6), mode: "100644" }]);
    const noBytes = await compose({ base, main, attempt, readText: io.readText });
    expect(noBytes.conflicts.map((c) => [c.path, c.reason])).toEqual([
      ["icon.png", "binary"],
      ["logo.png", "binary"],
    ]);
  });

  it("carries mode changes and merges a mode change with a content change", async () => {
    const { snap, io } = store();
    const script = "#!/bin/sh\necho hi\n";
    const base = snap({ "run.sh": script, "src/render.js": RENDER });
    const main = snap({ "run.sh": script + "echo main\n", "src/render.js": RENDER + "// main\n" });
    const attempt = snap({ "run.sh": { content: script, mode: "100755" }, "src/render.js": RENDER });
    const out = await compose({ base, main, attempt, ...io });
    expect(out.clean).toBe(true);
    expect(out.changes).toEqual([{ path: "run.sh", content: script + "echo main\n", mode: "100755" }]);
  });

  it("handles many files with bounded read concurrency, in path order", async () => {
    const { snap, io } = store();
    const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/m${String(i).padStart(2, "0")}.js`, `export const v = ${i};\n`]));
    const base = snap(files);
    const main = snap({ ...files, "src/m00.js": "export const v = 100;\n" });
    const attempt = snap(Object.fromEntries(Object.entries(files).map(([p, t]) => [p, t.replace("export", "export /* a */")])));
    let inFlight = 0;
    let peak = 0;
    const readText = async (sha: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return io.readText(sha);
    };
    const out = await compose({ base, main, attempt, readText });
    expect(out.touched).toHaveLength(60);
    expect(out.changes.map((c) => c.path)).toEqual(Object.keys(files).slice(1));
    expect(out.conflicts.map((c) => c.path)).toEqual(["src/m00.js"]);
    expect(peak).toBeLessThanOrEqual(16 * 3);
  });

  it("never mutates its inputs", async () => {
    const { snap, io } = store();
    const base = snap({ "src/render.js": RENDER, "src/products.js": PRODUCTS });
    const main = snap({ "src/render.js": sub(RENDER, "Bookshop", "Books"), "src/products.js": PRODUCTS });
    const attempt = snap({ "src/render.js": sub(RENDER, "p.title", "p.title.toUpperCase()"), "src/new.js": "x\n" });
    const copy = (s: Snapshot) => JSON.stringify([...s.entries()]);
    const before = [copy(base), copy(main), copy(attempt)];
    const input: ComposeInput = { base, main, attempt, ...io };
    const out = await compose(input);
    expect(out.clean).toBe(true);
    expect([copy(base), copy(main), copy(attempt)]).toEqual(before);
  });
});
