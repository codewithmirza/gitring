import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  HARNESS_PATH,
  HARNESS_SOURCE,
  RUNNER_MODULE,
  buildCheckModules,
  contentKey,
  runChecks,
  toLoaderModules,
} from "../../src/platform/checks/runner";
import { loadDemo } from "../../demo/tools/compose.mjs";
import { nodeLoader, treeMap } from "./node-loader";

const demo = await loadDemo();
const seed = treeMap(demo.seed);
const loader = nodeLoader();
afterAll(() => loader.cleanup());

function withFiles(extra: Record<string, string>): Map<string, string> {
  return new Map([...seed, ...Object.entries(extra)]);
}

const PASSING = `import { test, expect } from "../harness/test.js";\ntest("one", () => expect(1).toBe(1));\n`;

describe("buildCheckModules", () => {
  const built = buildCheckModules({ files: seed, testPaths: ["tests/app.test.js", "tests/extra.test.js"] });

  it("uses the generated runner as the main module", () => {
    expect(built.mainModule).toBe(RUNNER_MODULE);
    expect(built.modules[RUNNER_MODULE]).toContain("export default {");
    expect(built.modules[RUNNER_MODULE]).toContain("return Response.json(await __run());");
  });

  it("includes every .js/.mjs file under its repo path, and nothing else", () => {
    const repoModules = Object.keys(built.modules).filter((name) => !name.startsWith("__bearing__/")).sort();
    expect(repoModules).toEqual(["harness/test.js", "src/index.js", "src/products.js", "src/render.js", "src/styles.js", "tests/app.test.js", "tests/run.mjs"]);
    expect(built.modules["src/render.js"]).toBe(demo.seed["src/render.js"]);
  });

  it("imports the harness, then [marker, test file] for each test, in order", () => {
    const files = withFiles({ "tests/b.test.js": PASSING, "tests/a.test.js": PASSING });
    const { modules } = buildCheckModules({ files, testPaths: ["tests/b.test.js", "tests/app.test.js", "tests/a.test.js"] });
    const imports = modules[RUNNER_MODULE].split("\n").filter((line) => line.startsWith("import"));
    expect(imports).toEqual([
      'import { __run } from "../harness/test.js";',
      'import "./file-0.js";',
      'import "../tests/b.test.js";',
      'import "./file-1.js";',
      'import "../tests/app.test.js";',
      'import "./file-2.js";',
      'import "../tests/a.test.js";',
    ]);
    expect(modules["__bearing__/file-0.js"]).toBe('import { __setFile } from "../harness/test.js";\n__setFile("tests/b.test.js");\n');
    expect(modules["__bearing__/file-2.js"]).toContain('__setFile("tests/a.test.js")');
  });

  it("skips absent test paths and duplicates", () => {
    const { modules } = buildCheckModules({ files: seed, testPaths: ["tests/app.test.js", "tests/nope.test.js", "tests/app.test.js"] });
    expect(modules[RUNNER_MODULE].match(/^import "\.\.\/tests\//gm)).toHaveLength(1);
    expect(modules["__bearing__/file-1.js"]).toBeUndefined();
  });

  it("injects the harness when the tree has none", () => {
    const files = new Map([...seed].filter(([path]) => path !== HARNESS_PATH));
    const { modules } = buildCheckModules({ files, testPaths: ["tests/app.test.js"] });
    expect(modules[HARNESS_PATH]).toBe(HARNESS_SOURCE);
  });

  it("keeps the repo's own harness when there is one", () => {
    const files = withFiles({ [HARNESS_PATH]: "// custom\n" + HARNESS_SOURCE });
    expect(buildCheckModules({ files, testPaths: [] }).modules[HARNESS_PATH]).toMatch(/^\/\/ custom/);
  });

  it("HARNESS_SOURCE is the same as demo/repo/harness/test.js", async () => {
    // If this fails: copy demo/repo/harness/test.js into the String.raw template in runner.ts.
    expect(HARNESS_SOURCE).toBe(await readFile(new URL("../../demo/repo/harness/test.js", import.meta.url), "utf8"));
  });

  it("does not let tree files replace generated modules", () => {
    const files = withFiles({ [RUNNER_MODULE]: "export default {};" });
    expect(buildCheckModules({ files, testPaths: [] }).modules[RUNNER_MODULE]).toContain("__run");
  });
});

describe("toLoaderModules", () => {
  it("passes .mjs modules as { js } and .js modules as strings", () => {
    expect(toLoaderModules({ "a.js": "x", "tests/run.mjs": "y" })).toEqual({ "a.js": "x", "tests/run.mjs": { js: "y" } });
  });
});

describe("runChecks (generated modules executed in Node)", () => {
  it("runs the seed app tests and reports a passing CheckRun", async () => {
    const run = await runChecks(loader, "seed", { files: seed, testPaths: ["tests/app.test.js"] });
    expect(run).toMatchObject({ subject: "seed", scope: "attempt", ok: true, failed: 0, passed: 6 });
    expect(run.error).toBeUndefined();
    expect(run.id).toMatch(/^chk_[0-9a-f]{16}$/);
    expect(run.cases.every((c) => c.file === "tests/app.test.js" && c.ok && c.ms >= 0)).toBe(true);
    expect(run.at).toBeLessThanOrEqual(Date.now());
  });

  it("attributes each case to its file, in import order", async () => {
    const files = withFiles({ "tests/z.test.js": PASSING });
    const run = await runChecks(loader, "order", { files, testPaths: ["tests/z.test.js", "tests/app.test.js"] });
    expect(run.cases.map((c) => c.file)).toEqual(["tests/z.test.js", ...Array(6).fill("tests/app.test.js")]);
  });

  it("reports failing tests with their messages", async () => {
    const files = withFiles({ "tests/currency.test.js": demo.intents[0].checks[0].content });
    const run = await runChecks(loader, "seed+currency-check", { files, testPaths: ["tests/currency.test.js"] }, { scope: "composed", id: "chk_custom" });
    expect(run).toMatchObject({ id: "chk_custom", scope: "composed", ok: false });
    expect(run.error).toBeUndefined();
    expect(run.failed).toBeGreaterThan(0);
    expect(run.cases.find((c) => !c.ok)?.error).toMatch(/expected "\$19\.99" to be "€18\.39"/);
  });

  it("uses checks:<key>:<digest> ids and reuses the isolate for the same input", async () => {
    const local = nodeLoader();
    const input = { files: seed, testPaths: ["tests/app.test.js"] };
    await runChecks(local, "k1", input);
    await runChecks(local, "k1", input);
    await runChecks(local, "k1", { ...input, testPaths: ["tests/app.test.js", "tests/app.test.js"] });
    expect(local.ids).toHaveLength(3);
    expect(local.ids[0]).toMatch(/^checks:k1:[0-9a-f]{8}$/);
    expect(new Set(local.ids).size).toBe(1);
    expect(local.codeCalls()).toBe(1);
    const code = local.codes.get(local.ids[0])!;
    expect(code).toMatchObject({ compatibilityDate: "2026-10-01", mainModule: RUNNER_MODULE, globalOutbound: null });
    expect(code.modules["tests/run.mjs"]).toEqual({ js: demo.seed["tests/run.mjs"] });
    await local.cleanup();
  });

  it("gives a different id to a different test list on the same tree", async () => {
    const local = nodeLoader();
    const files = withFiles({ "tests/z.test.js": PASSING });
    await runChecks(local, "same", { files, testPaths: ["tests/app.test.js"] });
    await runChecks(local, "same", { files, testPaths: ["tests/app.test.js", "tests/z.test.js"] });
    expect(new Set(local.ids).size).toBe(2);
    await local.cleanup();
  });

  it("passes with no test paths, without a load", async () => {
    const local = nodeLoader();
    const run = await runChecks(local, "none", { files: seed, testPaths: [] });
    expect(run).toMatchObject({ ok: true, passed: 0, failed: 0, cases: [] });
    expect(local.ids).toEqual([]);
  });

  it("fails missing and unsupported test files without a runner error", async () => {
    const files = withFiles({ "tests/x.test.ts": "test()" });
    const run = await runChecks(loader, "missing", { files, testPaths: ["tests/app.test.js", "tests/gone.test.js", "tests/x.test.ts"] });
    expect(run.ok).toBe(false);
    expect(run.error).toBeUndefined();
    expect(run.passed).toBe(6);
    expect(run.cases.filter((c) => !c.ok).map((c) => [c.file, c.name])).toEqual([
      ["tests/gone.test.js", "(missing file)"],
      ["tests/x.test.ts", "(unsupported file)"],
    ]);
  });

  it("fails a test file that registers no tests", async () => {
    const files = withFiles({ "tests/empty.test.js": 'import { test } from "../harness/test.js";\n' });
    const run = await runChecks(loader, "empty", { files, testPaths: ["tests/empty.test.js"] });
    expect(run.ok).toBe(false);
    expect(run.cases).toEqual([{ file: "tests/empty.test.js", name: "(no tests)", ok: false, error: "The file registers no tests.", ms: 0 }]);
  });

  it("isolates a test file that does not load and still runs the others", async () => {
    const files = withFiles({
      "tests/broken.test.js": 'import { test } from "../harness/test.js";\ntest("x", () => { ) });\n',
      "tests/z.test.js": PASSING,
    });
    const run = await runChecks(loader, "broken", { files, testPaths: ["tests/app.test.js", "tests/broken.test.js", "tests/z.test.js"] });
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/^The checks did not load: .*SyntaxError/);
    expect(run.passed).toBe(7);
    expect(run.cases.filter((c) => !c.ok)).toEqual([expect.objectContaining({ file: "tests/broken.test.js", name: "(load)", ok: false })]);
  });

  it("reports a missing named export as a load failure of that file", async () => {
    const files = withFiles({ "tests/link.test.js": 'import { test } from "../harness/test.js";\nimport { findProducts } from "../src/products.js";\ntest("x", () => findProducts("a"));\n' });
    const run = await runChecks(loader, "link", { files, testPaths: ["tests/app.test.js", "tests/link.test.js"] });
    expect(run.error).toMatch(/findProducts/);
    expect(run.passed).toBe(6);
    expect(run.cases.find((c) => c.file === "tests/link.test.js")).toMatchObject({ name: "(load)", ok: false });
  });

  it("stops at the time budget and fails every requested file", async () => {
    const files = withFiles({ "tests/hang.test.js": 'import { test } from "../harness/test.js";\nawait new Promise(() => {});\ntest("never", () => {});\n' });
    const started = Date.now();
    const run = await runChecks(loader, "hang", { files, testPaths: ["tests/app.test.js", "tests/hang.test.js"] }, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.ok).toBe(false);
    expect(run.error).toBe("The checks did not finish in 300 ms.");
    expect(run.cases.map((c) => [c.file, c.name])).toEqual([
      ["tests/app.test.js", "(timeout)"],
      ["tests/hang.test.js", "(timeout)"],
    ]);
  });
});

describe("runChecks with a fake loader", () => {
  function fakeLoader(fetch: () => Promise<Response>): WorkerLoader {
    const stub = { getEntrypoint: () => ({ fetch }) as unknown as Fetcher } as unknown as WorkerStub;
    return { get: () => stub, load: () => stub };
  }
  const input = { files: seed, testPaths: ["tests/app.test.js"] };

  it("puts a workerd start failure on one line", async () => {
    const loader = fakeLoader(async () => {
      throw new Error("Failed to start Worker:\nUncaught SyntaxError: Unexpected token ')'\n  at src/render.js:12:5");
    });
    const run = await runChecks(loader, "k", input);
    expect(run.error).toBe("The checks did not load: Uncaught SyntaxError: Unexpected token ')' at src/render.js:12:5");
    expect(run.cases).toEqual([expect.objectContaining({ file: "tests/app.test.js", name: "(load)", ok: false })]);
  });

  it("rejects output that is not a list of results", async () => {
    const run = await runChecks(fakeLoader(async () => new Response("{}")), "k", input);
    expect(run.error).toBe("The check runner did not return a list of results.");
    const failing = await runChecks(fakeLoader(async () => new Response("boom", { status: 500 })), "k", input);
    expect(failing.error).toBe("The check runner answered 500: boom");
  });

  it("normalizes odd case data", async () => {
    const body = JSON.stringify([{ file: "tests/app.test.js", name: 3, ok: "yes", ms: -1 }, { file: "tests/app.test.js", ok: true, ms: 2 }]);
    const run = await runChecks(fakeLoader(async () => new Response(body)), "k", input);
    expect(run.cases).toEqual([
      { file: "tests/app.test.js", name: "3", ok: false, ms: 0, error: "The test failed." },
      { file: "tests/app.test.js", name: "(unnamed test)", ok: true, ms: 2 },
    ]);
    expect(run).toMatchObject({ ok: false, passed: 1, failed: 1 });
  });
});

describe("contentKey", () => {
  it("is stable, independent of insertion order, and changes with content", async () => {
    const a = await contentKey(new Map([["a.js", "1"], ["b.js", "2"]]));
    expect(a).toMatch(/^[0-9a-f]{20}$/);
    expect(await contentKey(new Map([["b.js", "2"], ["a.js", "1"]]))).toBe(a);
    expect(await contentKey(new Map([["a.js", "1"], ["b.js", "3"]]))).not.toBe(a);
    expect(await contentKey(new Map([["a.js1", ""], ["b.js", "2"]]))).not.toBe(a);
  });
});
