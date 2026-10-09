/**
 * The sample project (sample/repo), its intents (sample/intents.json) and the reference solutions
 * (test/fixtures/sample-solutions). The checks run through runChecks: the generated modules execute in Node.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as acorn from "acorn";
import { diffIndices } from "node-diff3";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks } from "../../src/platform/checks/runner";
import type { CheckRun } from "../../src/core/types";
import { SAMPLE_DIR, LANDING_ORDER, applyChange, changeFor, checkFiles, land, loadSample, parseStep, testPathsOf, treeAlone, type Tree } from "../fixtures/compose.mjs";
import { nodeLoader, treeMap } from "./node-loader";

const run = promisify(execFile);
const demo = await loadSample();
const SLUGS = ["currency", "dark-mode", "search", "staff-picks", "api-item"];
const loader = nodeLoader();
const tempDirs: string[] = [];
afterAll(async () => {
  await loader.cleanup();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

let keys = 0;
function check(tree: Tree, testPaths: string[]): Promise<CheckRun> {
  return runChecks(loader, `demo-${keys++}`, { files: treeMap(tree), testPaths });
}

function failures(result: CheckRun): string[] {
  return result.cases.filter((c) => !c.ok).map((c) => `${c.file} > ${c.name}: ${c.error}`);
}

/** Top-level declarations of a module: name → source text ("default" for export default). */
function declarations(source: string): Map<string, string> {
  const program = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }) as unknown as { body: AnyNode[] };
  const out = new Map<string, string>();
  for (const node of program.body) {
    const text = source.slice(node.start, node.end);
    const decl = node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
    if (node.type === "ExportDefaultDeclaration") out.set("default", text);
    else if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) out.set(decl.id.name, text);
    else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations ?? []) if (d.id?.type === "Identifier") out.set(d.id.name, decl.declarations!.length === 1 ? text : source.slice(d.start, d.end));
    }
  }
  return out;
}
interface AnyNode {
  type: string;
  start: number;
  end: number;
  id?: { type: string; name: string };
  declaration?: AnyNode;
  declarations?: AnyNode[];
}

/** Symbols (path#name) that a change defines, modifies or removes. */
function changedSymbols(base: Tree, change: Tree): string[] {
  const symbols: string[] = [];
  for (const [file, content] of Object.entries(change)) {
    if (!file.startsWith("src/")) continue;
    const before = declarations(base[file] ?? "");
    const after = declarations(content);
    for (const [name, text] of after) if (before.get(name) !== text) symbols.push(`${file}#${name}`);
    for (const name of before.keys()) if (!after.has(name)) symbols.push(`${file}#${name}`);
  }
  return symbols.sort();
}

describe("demo build outputs", () => {
  it("sample/intents.json and sample/bundle.json are up to date (node sample/build.mjs --check)", async () => {
    await expect(run(process.execPath, [path.join(SAMPLE_DIR, "build.mjs"), "--check"])).resolves.toBeDefined();
  });
});

describe("sample intents (sample/intents.json)", () => {
  it("has the five intents, in order", () => {
    expect(demo.intents.map((i) => i.slug)).toEqual(SLUGS);
  });

  it.each(SLUGS)("%s: has a title, a goal of 2–5 sentences, and one check file named after it", (slug) => {
    const intent = demo.intents.find((i) => i.slug === slug)!;
    expect(intent.title.length).toBeGreaterThan(5);
    const sentences = intent.goal.split(/(?<=[.!?])\s+(?=[A-Z`])/).length;
    expect(sentences).toBeGreaterThanOrEqual(2);
    expect(sentences).toBeLessThanOrEqual(5);
    expect(intent.checks).toHaveLength(1);
    expect(intent.checks[0].path).toBe(`tests/${slug}.test.js`);
    expect(intent.checks[0].description.length).toBeGreaterThan(10);
    expect(intent.checks[0].content).toContain('from "../harness/test.js"');
  });

  it.each(SLUGS)("%s: expect.files are the files that the solution changes", (slug) => {
    const intent = demo.intents.find((i) => i.slug === slug)!;
    const files = demo.solutions[slug].files;
    for (const [file, content] of Object.entries(files)) expect(content, file).not.toBe(demo.seed[file]);
    expect(Object.keys(files).sort()).toEqual([...intent.expect.files].sort());
  });

  it.each(SLUGS)("%s: expect.symbols are the symbols that the solution defines or changes", (slug) => {
    const intent = demo.intents.find((i) => i.slug === slug)!;
    expect(changedSymbols(demo.seed, demo.solutions[slug].files)).toEqual([...intent.expect.symbols].sort());
  });
});

describe("the seed repo", () => {
  it("passes its own tests in the check runner", async () => {
    const result = await check(demo.seed, testPathsOf(demo.seed));
    expect(failures(result)).toEqual([]);
    expect(result).toMatchObject({ ok: true, passed: 6 });
  });

  it.each(SLUGS)("%s: the check fails on the seed (and the runner itself works)", async (slug) => {
    const tree = { ...demo.seed, ...checkFiles(demo, slug) };
    const result = await check(tree, [`tests/${slug}.test.js`]);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.failed).toBeGreaterThan(0);
  });

  it("runs with tests/run.mjs in Node: exit 0 when green, exit 1 when a test fails", async () => {
    const green = await writeTree(demo.seed);
    const ok = await run(process.execPath, ["tests/run.mjs"], { cwd: green });
    expect(ok.stdout).toContain("6 passed, 0 failed, 1 files");
    const red = await writeTree({ ...demo.seed, ...checkFiles(demo, "currency") });
    const failed = await run(process.execPath, ["tests/run.mjs", "tests/currency.test.js"], { cwd: red }).catch((e: { code: number; stdout: string }) => e);
    expect(failed).toMatchObject({ code: 1 });
    expect((failed as { stdout: string }).stdout).toContain('FAIL  tests/currency.test.js > formatPrice converts to euros at 0.92, to the cent');
  });
});

describe("reference solutions", () => {
  it.each(SLUGS)("%s alone (files/ on the seed): app tests and its own check pass", async (slug) => {
    const result = await check(treeAlone(demo, slug), ["tests/app.test.js", `tests/${slug}.test.js`]);
    expect(failures(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(["search", "staff-picks"])("%s adapted (adapted/ on seed + currency): app, currency and its own checks pass", async (slug) => {
    const tree = treeAlone(demo, slug, "adapted");
    expect(tree["tests/currency.test.js"]).toBeDefined();
    const result = await check(tree, ["tests/app.test.js", "tests/currency.test.js", `tests/${slug}.test.js`]);
    expect(failures(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(["search", "staff-picks"])("%s adapted calls formatPrice with the currency", (slug) => {
    expect(demo.solutions[slug].adapted!["src/render.js"]).toContain("renderItem(p, currency)");
    expect(demo.solutions[slug].adapted!["src/render.js"]).toContain("formatPrice(p.cents, currency)");
  });
});

describe("landing order: " + LANDING_ORDER.join(" → "), () => {
  const landed = land(demo, LANDING_ORDER);

  it("every step merges with no conflict", () => {
    expect(landed.log).toEqual(LANDING_ORDER.map((step) => ({ step, conflicts: [] })));
    expect(landed.ok).toBe(true);
  });

  it("all tests pass at the end: app + the five intents", async () => {
    expect(testPathsOf(landed.tree)).toEqual(["tests/api-item.test.js", "tests/app.test.js", "tests/currency.test.js", "tests/dark-mode.test.js", "tests/search.test.js", "tests/staff-picks.test.js"]);
    const result = await check(landed.tree, testPathsOf(landed.tree));
    expect(failures(result)).toEqual([]);
    expect(result).toMatchObject({ ok: true, passed: 39, failed: 0 });
  });

  it("all tests pass after each step (the composed check of each landing)", async () => {
    for (let n = 1; n <= LANDING_ORDER.length; n++) {
      const partial = land(demo, LANDING_ORDER.slice(0, n));
      const result = await check(partial.tree, testPathsOf(partial.tree));
      expect(failures(result), LANDING_ORDER[n - 1]).toEqual([]);
    }
  });

  it("sample/bundle.json carries the seed and the intents, and no solutions", async () => {
    const bundle = (await import("../../sample/bundle.json", { with: { type: "json" } })).default as Record<string, unknown> & { repo: Tree };
    expect(Object.keys(bundle).sort()).toEqual(["intents", "name", "repo", "schema"]);
    expect(bundle.repo).toEqual(demo.seed);
  });

  it("keeps at least 2 unchanged lines between the edits of different intents (stricter than git)", () => {
    let main = { ...demo.seed };
    for (const step of LANDING_ORDER) {
      const { slug, variant } = parseStep(step);
      const { base, change } = changeFor(demo, slug, variant);
      for (const [file, theirs] of Object.entries(change)) {
        const ours = main[file];
        if (ours === undefined || base[file] === undefined || ours === base[file] || theirs === base[file]) continue;
        expect(minGap(base[file], ours, theirs), `${step}: ${file}`).toBeGreaterThanOrEqual(2);
      }
      main = applyChange(main, base, change).tree;
    }
  });

  it("also lands with gitring's own merge3 (src/core/text/merge3.ts)", async (ctx) => {
    const mod = await import("../../src/core/text/merge3").catch(() => null);
    if (!mod) return ctx.skip();
    let main = { ...demo.seed };
    for (const step of LANDING_ORDER) {
      const { slug, variant } = parseStep(step);
      const { base, change } = changeFor(demo, slug, variant);
      for (const [file, theirs] of Object.entries(change)) {
        const merged = mod.merge3(base[file] ?? "", main[file] ?? "", theirs);
        expect(merged.clean, `${step}: ${file}`).toBe(true);
        main = { ...main, [file]: merged.content };
      }
    }
    expect(main).toEqual(landed.tree);
  });

  it("any order of the other four also lands cleanly once currency has landed", () => {
    const rest = LANDING_ORDER.slice(1);
    const orders = permutations(rest);
    expect(orders).toHaveLength(24);
    for (const order of orders) expect(land(demo, ["currency", ...order]).ok, order.join(" → ")).toBe(true);
  });
});

describe("pairs that conflict as text without gitring (files/ variants, no corrections)", () => {
  function second(a: string, b: string) {
    return land(demo, [a, b]).log[1];
  }

  it("currency and search conflict as text (import line, renderPage, end of products.js)", () => {
    expect(second("currency", "search").conflicts).toEqual(["src/products.js", "src/render.js"]);
    expect(second("search", "currency").conflicts).toEqual(["src/products.js", "src/render.js"]);
  });

  it("currency and staff-picks conflict as text (the price line in renderItem)", () => {
    expect(second("currency", "staff-picks").conflicts).toEqual(["src/render.js"]);
    expect(second("staff-picks", "currency").conflicts).toEqual(["src/render.js"]);
  });

  it("dark-mode and search share the header but keep apart lines, so they merge in both orders", async () => {
    for (const order of [["dark-mode", "search"], ["search", "dark-mode"]]) {
      const result = land(demo, order);
      expect(result.ok).toBe(true);
      const checked = await check(result.tree, testPathsOf(result.tree));
      expect(failures(checked)).toEqual([]);
    }
  });

  it("every other pair merges cleanly", () => {
    const colliding = new Set(["currency+search", "search+currency", "currency+staff-picks", "staff-picks+currency"]);
    for (const a of SLUGS) {
      for (const b of SLUGS) {
        if (a === b || colliding.has(`${a}+${b}`)) continue;
        expect(second(a, b).conflicts, `${a} then ${b}`).toEqual([]);
      }
    }
  });

  it("a consumer that re-derives on the new main (adapted/) merges, the stale one does not", () => {
    const main = land(demo, ["currency"]).tree;
    const stale = changeFor(demo, "staff-picks", "files");
    expect(applyChange(main, stale.base, stale.change).conflicts).toEqual(["src/render.js"]);
    const adapted = changeFor(demo, "staff-picks", "adapted");
    expect(applyChange(main, adapted.base, adapted.change).conflicts).toEqual([]);
  });
});

/** Fewest unchanged base lines between an edit of ours and an edit of theirs (-1 = they overlap). */
function minGap(base: string, ours: string, theirs: string): number {
  const o = base.split("\n");
  const ranges = (side: string) => diffIndices(o, side.split("\n")).map((h) => [h.buffer1[0], h.buffer1[0] + h.buffer1[1]] as const);
  let min = Infinity;
  for (const [s1, e1] of ranges(ours)) {
    for (const [s2, e2] of ranges(theirs)) {
      const gap = s2 >= e1 ? s2 - e1 : s1 >= e2 ? s1 - e2 : -1;
      min = Math.min(min, gap);
    }
  }
  return min;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

async function writeTree(tree: Tree): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gitring-demo-"));
  tempDirs.push(dir);
  for (const [file, content] of Object.entries(tree)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}
