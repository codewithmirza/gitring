/**
 * Probe Worker: runs src/platform/checks (runner + preview) in workerd against the sample project and
 * its reference solutions. First run `node test/fixtures/build-probe.mjs` (workerd cannot read the disk).
 *
 *   GET /run-checks?scenario=<name>[&timeoutMs=<ms>]   → CheckRun JSON (+ "scenario" and "testPaths")
 *   GET /preview/<scenario>/<path>                       → the app of that scenario, under the prefix
 *   GET /scenarios                                       → the scenario names
 *
 * Scenarios: seed, seed+checks, solution:<slug>, adapted:<slug>, landed, no-harness, broken-test,
 * broken-src, hang, net, app-throws, app-syntax.
 */
import bundle from "../../fixtures/sample-probe.json";
import { servePreview } from "../../../src/platform/checks/preview";
import { contentKey, runChecks } from "../../../src/platform/checks/runner";

interface Env {
  LOADER: WorkerLoader;
}

type Tree = Record<string, string>;
interface Scenario {
  tree: Tree;
  testPaths?: string[];
}

const demo = bundle as unknown as {
  repo: Tree;
  intents: { slug: string; checks: { path: string; content: string }[] }[];
  solutions: Record<string, { files: Tree; adapted?: Tree }>;
  landing: { order: string[]; tree: Tree };
};

function checksOf(slug: string): Tree {
  const intent = demo.intents.find((i) => i.slug === slug);
  if (!intent) throw new Error(`unknown intent ${slug}`);
  return Object.fromEntries(intent.checks.map((c) => [c.path, c.content]));
}

const allChecks = (): Tree => Object.assign({}, ...demo.intents.map((i) => checksOf(i.slug)));
const testsOf = (tree: Tree) => Object.keys(tree).filter((p) => /^tests\/[^/]+\.test\.js$/.test(p)).sort();
const without = (tree: Tree, path: string): Tree => Object.fromEntries(Object.entries(tree).filter(([p]) => p !== path));

function scenario(name: string): Scenario | null {
  const [kind, slug] = name.split(":");
  const seed = demo.repo;
  switch (kind) {
    case "seed":
      return { tree: seed };
    case "seed+checks":
      return { tree: { ...seed, ...allChecks() } };
    case "solution":
      return demo.solutions[slug] ? { tree: { ...seed, ...demo.solutions[slug].files, ...checksOf(slug) }, testPaths: ["tests/app.test.js", `tests/${slug}.test.js`] } : null;
    case "adapted": {
      const adapted = demo.solutions[slug]?.adapted;
      if (!adapted) return null;
      return { tree: { ...seed, ...demo.solutions.currency.files, ...checksOf("currency"), ...adapted, ...checksOf(slug) } };
    }
    case "landed":
      return { tree: demo.landing.tree };
    case "no-harness":
      return { tree: without(seed, "harness/test.js") };
    case "broken-test":
      return { tree: { ...seed, "tests/broken.test.js": 'import { test } from "../harness/test.js";\ntest("x", () => { ) });\n' } };
    case "broken-src":
      return { tree: { ...seed, "src/render.js": seed["src/render.js"].replace("function renderTag(tag) {", "function renderTag(tag) {{") } };
    case "hang":
      return { tree: { ...seed, "tests/hang.test.js": 'import { test } from "../harness/test.js";\ntest("never ends", () => new Promise(() => {}));\ntest("still runs", () => {});\n' } };
    case "net":
      return { tree: { ...seed, "tests/net.test.js": 'import { test } from "../harness/test.js";\ntest("no network", async () => { await fetch("https://example.com/"); });\n' } };
    case "app-throws":
      return { tree: { ...seed, "src/index.js": 'export default { async fetch() { throw new Error("The <shop> is closed & locked"); } };\n' } };
    case "app-syntax":
      return { tree: { ...seed, "src/index.js": seed["src/index.js"] + "\nexport const = 1;\n" } };
    default:
      return null;
  }
}

const SCENARIOS = [
  "seed", "seed+checks", "landed", "no-harness", "broken-test", "broken-src", "hang", "net", "app-throws", "app-syntax",
  ...demo.intents.map((i) => `solution:${i.slug}`),
  ...Object.keys(demo.solutions).filter((s) => demo.solutions[s].adapted).map((s) => `adapted:${s}`),
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/scenarios") return Response.json(SCENARIOS);

    if (url.pathname === "/run-checks") {
      const name = url.searchParams.get("scenario") ?? "seed";
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

    return new Response("gitring-checks-probe: try /scenarios, /run-checks?scenario=landed or /preview/landed/", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
