/**
 * Probe Worker: runs src/platform/checks (runner + preview) in workerd against the greeter project
 * (test/checks/greeter.ts) and against broken variants of it.
 *
 *   GET /run-checks?scenario=<name>[&timeoutMs=<ms>]   → CheckRun JSON (+ "scenario" and "testPaths")
 *   GET /preview/<scenario>/<path>                       → the app of that scenario, under the prefix
 *   GET /scenarios                                       → the scenario names
 *
 * Scenarios: greeter, own-harness, broken-test, broken-src, hang, net, app-throws, app-syntax.
 */
import { GREETER, type Tree } from "../../checks/greeter";
import { servePreview } from "../../../src/platform/checks/preview";
import { HARNESS_PATH, HARNESS_SOURCE, contentKey, runChecks } from "../../../src/platform/checks/runner";

interface Env {
  LOADER: WorkerLoader;
}

interface Scenario {
  tree: Tree;
  testPaths?: string[];
}

const testsOf = (tree: Tree) => Object.keys(tree).filter((p) => /^tests\/[^/]+\.test\.js$/.test(p)).sort();

function scenario(name: string): Scenario | null {
  switch (name) {
    case "greeter":
      // The tree has no harness/test.js: gitring injects its harness.
      return { tree: GREETER };
    case "own-harness":
      return { tree: { ...GREETER, [HARNESS_PATH]: HARNESS_SOURCE } };
    case "broken-test":
      return { tree: { ...GREETER, "tests/broken.test.js": 'import { test } from "../harness/test.js";\ntest("x", () => { ) });\n' } };
    case "broken-src":
      return { tree: { ...GREETER, "src/greet.js": GREETER["src/greet.js"] + "\nexport const = 1;\n" } };
    case "hang":
      return { tree: { ...GREETER, "tests/hang.test.js": 'import { test } from "../harness/test.js";\ntest("never ends", () => new Promise(() => {}));\ntest("still runs", () => {});\n' } };
    case "net":
      return { tree: { ...GREETER, "tests/net.test.js": 'import { test } from "../harness/test.js";\ntest("no network", async () => { await fetch("https://example.com/"); });\n' } };
    case "app-throws":
      return { tree: { ...GREETER, "src/index.js": 'export default { async fetch() { throw new Error("The <greeter> is closed & locked"); } };\n' } };
    case "app-syntax":
      return { tree: { ...GREETER, "src/index.js": GREETER["src/index.js"] + "\nexport const = 1;\n" } };
    default:
      return null;
  }
}

const SCENARIOS = ["greeter", "own-harness", "broken-test", "broken-src", "hang", "net", "app-throws", "app-syntax"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/scenarios") return Response.json(SCENARIOS);

    if (url.pathname === "/run-checks") {
      const name = url.searchParams.get("scenario") ?? "greeter";
      const found = scenario(name);
      if (!found) return Response.json({ error: `unknown scenario ${name}` }, { status: 404 });
      const files = new Map(Object.entries(found.tree));
      const testPaths = found.testPaths ?? testsOf(found.tree);
      const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? 10000);
      const run = await runChecks(env.LOADER, await contentKey(files), { files, testPaths }, { timeoutMs });
      return Response.json({ scenario: name, testPaths, ...run });
    }

    const match = url.pathname.match(/^\/preview\/([^/]+)/);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const found = scenario(name);
      if (!found) return new Response(`unknown scenario ${name}`, { status: 404 });
      const files = new Map(Object.entries(found.tree));
      return servePreview(env.LOADER, await contentKey(files), files, request, `/preview/${match[1]}`);
    }

    return new Response("gitring-checks-probe: try /scenarios, /run-checks?scenario=greeter or /preview/greeter/", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
