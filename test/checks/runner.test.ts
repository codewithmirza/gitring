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
import { GREETER, GREETER_TEST_COUNT, GREETER_TEST_FILE } from "./greeter";
import { nodeLoader, treeMap } from "./node-loader";

const greeter = treeMap(GREETER);
const loader = nodeLoader();
afterAll(() => loader.cleanup());

function withFiles(extra: Record<string, string>): Map<string, string> {
  return new Map([...greeter, ...Object.entries(extra)]);
}

const PASSING = `import { test, expect } from "../harness/test.js";\ntest("one", () => expect(1).toBe(1));\n`;

describe("buildCheckModules", () => {
  const built = buildCheckModules({ files: greeter, testPaths: [GREETER_TEST_FILE, "tests/extra.test.js"] });

  it("uses the generated runner as the main module", () => {
    expect(built.mainModule).toBe(RUNNER_MODULE);
    expect(built.modules[RUNNER_MODULE]).toContain("export default {");
    expect(built.modules[RUNNER_MODULE]).toContain("return Response.json(await __run());");
  });

  it("includes every .js/.mjs file under its repo path, and nothing else", () => {
    const repoModules = Object.keys(built.modules).filter((name) => !name.startsWith("__gitring__/")).sort();
    // README.md and package.json are not modules. harness/test.js is not in the tree: gitring adds it.
    expect(repoModules).toEqual(["harness/test.js", "src/greet.js", "src/index.js", "tests/greet.test.js", "tests/helpers.mjs"]);
    expect(built.modules["src/index.js"]).toBe(GREETER["src/index.js"]);
  });

  it("imports the harness, then [marker, test file] for each test, in order", () => {
    const files = withFiles({ "tests/b.test.js": PASSING, "tests/a.test.js": PASSING });
    const { modules } = buildCheckModules({ files, testPaths: ["tests/b.test.js", GREETER_TEST_FILE, "tests/a.test.js"] });
    const imports = modules[RUNNER_MODULE].split("\n").filter((line) => line.startsWith("import"));
    expect(imports).toEqual([
      'import { __run } from "../harness/test.js";',
      'import "./file-0.js";',
      'import "../tests/b.test.js";',
      'import "./file-1.js";',
      'import "../tests/greet.test.js";',
      'import "./file-2.js";',
      'import "../tests/a.test.js";',
    ]);
    expect(modules["__gitring__/file-0.js"]).toBe('import { __setFile } from "../harness/test.js";\n__setFile("tests/b.test.js");\n');
    expect(modules["__gitring__/file-2.js"]).toContain('__setFile("tests/a.test.js")');
  });

  it("skips absent test paths and duplicates", () => {
    const { modules } = buildCheckModules({ files: greeter, testPaths: [GREETER_TEST_FILE, "tests/nope.test.js", GREETER_TEST_FILE] });
    expect(modules[RUNNER_MODULE].match(/^import "\.\.\/tests\//gm)).toHaveLength(1);
    expect(modules["__gitring__/file-1.js"]).toBeUndefined();
  });

  it("injects the harness when the tree has none", () => {
    expect(greeter.has(HARNESS_PATH)).toBe(false);
    const { modules } = buildCheckModules({ files: greeter, testPaths: [GREETER_TEST_FILE] });
    expect(modules[HARNESS_PATH]).toBe(HARNESS_SOURCE);
  });

  it("keeps the repo's own harness when there is one", () => {
    const files = withFiles({ [HARNESS_PATH]: "// custom\n" + HARNESS_SOURCE });
    expect(buildCheckModules({ files, testPaths: [] }).modules[HARNESS_PATH]).toMatch(/^\/\/ custom/);
  });

  it("HARNESS_SOURCE has no imports and exports the API that its header documents", () => {
    expect(HARNESS_SOURCE).not.toMatch(/^\s*import\s/m);
    const exported = [...HARNESS_SOURCE.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((match) => match[1]);
    expect(exported.sort()).toEqual(["__run", "__setFile", "expect", "test"]);
  });

  it("does not let tree files replace generated modules", () => {
    const files = withFiles({ [RUNNER_MODULE]: "export default {};" });
    expect(buildCheckModules({ files, testPaths: [] }).modules[RUNNER_MODULE]).toContain("__run");
  });
});

describe("toLoaderModules", () => {
  it("passes .mjs modules as { js } and .js modules as strings", () => {
    expect(toLoaderModules({ "a.js": "x", "tests/helpers.mjs": "y" })).toEqual({ "a.js": "x", "tests/helpers.mjs": { js: "y" } });
  });
});

describe("runChecks (generated modules executed in Node)", () => {
  it("runs the tests of the greeter and reports a passing CheckRun", async () => {
    const run = await runChecks(loader, "greeter", { files: greeter, testPaths: [GREETER_TEST_FILE] });
    expect(run).toMatchObject({ subject: "greeter", scope: "attempt", ok: true, failed: 0, passed: GREETER_TEST_COUNT });
    expect(run.error).toBeUndefined();
    expect(run.id).toMatch(/^chk_[0-9a-f]{16}$/);
    expect(run.cases.every((c) => c.file === GREETER_TEST_FILE && c.ok && c.ms >= 0)).toBe(true);
    expect(run.at).toBeLessThanOrEqual(Date.now());
  });

  it("attributes each case to its file, in import order", async () => {
    const files = withFiles({ "tests/z.test.js": PASSING });
    const run = await runChecks(loader, "order", { files, testPaths: ["tests/z.test.js", GREETER_TEST_FILE] });
    expect(run.cases.map((c) => c.file)).toEqual(["tests/z.test.js", ...Array(GREETER_TEST_COUNT).fill(GREETER_TEST_FILE)]);
  });

  it("reports failing tests with their messages", async () => {
    const french = 'import { test, expect } from "../harness/test.js";\nimport { greet } from "../src/greet.js";\ntest("greets in French", () => expect(greet("Ada")).toBe("Bonjour, Ada!"));\n';
    const files = withFiles({ "tests/french.test.js": french });
    const run = await runChecks(loader, "greeter+french-check", { files, testPaths: ["tests/french.test.js"] }, { scope: "composed", id: "chk_custom" });
    expect(run).toMatchObject({ id: "chk_custom", scope: "composed", ok: false });
    expect(run.error).toBeUndefined();
    expect(run.failed).toBeGreaterThan(0);
    expect(run.cases.find((c) => !c.ok)?.error).toMatch(/expected "Hello, Ada!" to be "Bonjour, Ada!"/);
  });

  it("uses checks:<key>:<digest> ids and reuses the isolate for the same input", async () => {
    const local = nodeLoader();
    const input = { files: greeter, testPaths: [GREETER_TEST_FILE] };
    await runChecks(local, "k1", input);
    await runChecks(local, "k1", input);
    await runChecks(local, "k1", { ...input, testPaths: [GREETER_TEST_FILE, GREETER_TEST_FILE] });
    expect(local.ids).toHaveLength(3);
    expect(local.ids[0]).toMatch(/^checks:k1:[0-9a-f]{8}$/);
    expect(new Set(local.ids).size).toBe(1);
    expect(local.codeCalls()).toBe(1);
    const code = local.codes.get(local.ids[0])!;
    expect(code).toMatchObject({ compatibilityDate: "2026-10-01", mainModule: RUNNER_MODULE, globalOutbound: null });
    expect(code.modules["tests/helpers.mjs"]).toEqual({ js: GREETER["tests/helpers.mjs"] });
    await local.cleanup();
  });

  it("gives a different id to a different test list on the same tree", async () => {
    const local = nodeLoader();
    const files = withFiles({ "tests/z.test.js": PASSING });
    await runChecks(local, "same", { files, testPaths: [GREETER_TEST_FILE] });
    await runChecks(local, "same", { files, testPaths: [GREETER_TEST_FILE, "tests/z.test.js"] });
    expect(new Set(local.ids).size).toBe(2);
    await local.cleanup();
  });

  it("passes with no test paths, without a load", async () => {
    const local = nodeLoader();
    const run = await runChecks(local, "none", { files: greeter, testPaths: [] });
    expect(run).toMatchObject({ ok: true, passed: 0, failed: 0, cases: [] });
    expect(local.ids).toEqual([]);
  });

  it("fails missing and unsupported test files without a runner error", async () => {
    const files = withFiles({ "tests/x.test.ts": "test()" });
    const run = await runChecks(loader, "missing", { files, testPaths: [GREETER_TEST_FILE, "tests/gone.test.js", "tests/x.test.ts"] });
    expect(run.ok).toBe(false);
    expect(run.error).toBeUndefined();
    expect(run.passed).toBe(GREETER_TEST_COUNT);
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
    const run = await runChecks(loader, "broken", { files, testPaths: [GREETER_TEST_FILE, "tests/broken.test.js", "tests/z.test.js"] });
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/^The checks did not load: .*SyntaxError/);
    expect(run.passed).toBe(GREETER_TEST_COUNT + 1);
    expect(run.cases.filter((c) => !c.ok)).toEqual([expect.objectContaining({ file: "tests/broken.test.js", name: "(load)", ok: false })]);
  });

  it("reports a missing named export as a load failure of that file", async () => {
    const files = withFiles({ "tests/link.test.js": 'import { test } from "../harness/test.js";\nimport { findGreeting } from "../src/greet.js";\ntest("x", () => findGreeting("a"));\n' });
    const run = await runChecks(loader, "link", { files, testPaths: [GREETER_TEST_FILE, "tests/link.test.js"] });
    expect(run.error).toMatch(/findGreeting/);
    expect(run.passed).toBe(GREETER_TEST_COUNT);
    expect(run.cases.find((c) => c.file === "tests/link.test.js")).toMatchObject({ name: "(load)", ok: false });
  });

  it("stops at the time budget and fails every requested file", async () => {
    const files = withFiles({ "tests/hang.test.js": 'import { test } from "../harness/test.js";\nawait new Promise(() => {});\ntest("never", () => {});\n' });
    const started = Date.now();
    const run = await runChecks(loader, "hang", { files, testPaths: [GREETER_TEST_FILE, "tests/hang.test.js"] }, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.ok).toBe(false);
    expect(run.error).toBe("The checks did not finish in 300 ms.");
    expect(run.cases.map((c) => [c.file, c.name])).toEqual([
      [GREETER_TEST_FILE, "(timeout)"],
      ["tests/hang.test.js", "(timeout)"],
    ]);
  });
});

describe("runChecks with a fake loader", () => {
  function fakeLoader(fetch: () => Promise<Response>): WorkerLoader {
    const stub = { getEntrypoint: () => ({ fetch }) as unknown as Fetcher } as unknown as WorkerStub;
    return { get: () => stub, load: () => stub };
  }
  const input = { files: greeter, testPaths: [GREETER_TEST_FILE] };

  it("puts a workerd start failure on one line", async () => {
    const loader = fakeLoader(async () => {
      throw new Error("Failed to start Worker:\nUncaught SyntaxError: Unexpected token ')'\n  at src/greet.js:12:5");
    });
    const run = await runChecks(loader, "k", input);
    expect(run.error).toBe("The checks did not load: Uncaught SyntaxError: Unexpected token ')' at src/greet.js:12:5");
    expect(run.cases).toEqual([expect.objectContaining({ file: GREETER_TEST_FILE, name: "(load)", ok: false })]);
  });

  it("rejects output that is not a list of results", async () => {
    const run = await runChecks(fakeLoader(async () => new Response("{}")), "k", input);
    expect(run.error).toBe("The check runner did not return a list of results.");
    const failing = await runChecks(fakeLoader(async () => new Response("boom", { status: 500 })), "k", input);
    expect(failing.error).toBe("The check runner answered 500: boom");
  });

  it("normalizes odd case data", async () => {
    const body = JSON.stringify([{ file: GREETER_TEST_FILE, name: 3, ok: "yes", ms: -1 }, { file: GREETER_TEST_FILE, ok: true, ms: 2 }]);
    const run = await runChecks(fakeLoader(async () => new Response(body)), "k", input);
    expect(run.cases).toEqual([
      { file: GREETER_TEST_FILE, name: "3", ok: false, ms: 0, error: "The test failed." },
      { file: GREETER_TEST_FILE, name: "(unnamed test)", ok: true, ms: 2 },
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
