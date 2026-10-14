/**
 * Starter templates for new projects: plain data, and a function that gives the files of one template.
 *
 * Every template that has code also has tests in tests/*.test.js for the gitring test runner (a Dynamic
 * Worker: no npm packages, no network). The test files import the harness from "../harness/test.js";
 * gitring adds that file when the tests run. So the first merge of a new project already runs tests.
 *
 * Each template has an AGENTS.md: it tells agents to send a plan to gitring before they write code.
 * No runtime dependencies: the Worker, the project object and the web UI share this file.
 */

export type TemplateId = "empty" | "js-library" | "worker-api" | "static-site";

export interface Template {
  id: TemplateId;
  /** A short name for people. */
  title: string;
  /** One sentence: what the template gives. */
  summary: string;
}

export const TEMPLATES: readonly Template[] = [
  { id: "empty", title: "Empty", summary: "A README, a .gitignore and an AGENTS.md. Agents write the first files and tests." },
  { id: "js-library", title: "JavaScript library", summary: "A small library in plain ES modules, with tests that run in the gitring test runner." },
  { id: "worker-api", title: "Worker API", summary: "A Cloudflare Worker that answers JSON. The routes are a pure module with tests." },
  { id: "static-site", title: "Static site", summary: "An index.html page and a small JavaScript module with tests." },
];

export function isTemplateId(raw: unknown): raw is TemplateId {
  return typeof raw === "string" && TEMPLATES.some((t) => t.id === raw);
}

export interface TemplateFile {
  path: string;
  content: string;
}

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

/** A package name from a project name: lowercase letters, digits and dashes. */
export function packageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

const GITIGNORE = lines("node_modules/", ".wrangler/", ".dev.vars", ".env", ".DS_Store", "dist/");

/** The part of AGENTS.md that every template has: how an agent works with gitring. */
function agentsGuide(extra: string[]): string {
  return lines(
    "# Notes for agents",
    "",
    "This repository lives in gitring. Many agents can change it at the same time.",
    "",
    "## How to work here",
    "",
    "1. Connect to gitring through MCP. The Connect page of the project shows the URL.",
    "2. Call `gitring_intents` to see the open tasks of the project.",
    "3. Call `gitring_declare` with your plan before you write code. Name the files and the functions that you will change.",
    "4. Write your work. When gitring sends a change request, apply it and call `gitring_ack`.",
    "5. Call `gitring_check` to run the tests. Then call `gitring_submit` to ask for a merge.",
    "",
    "Do not push to main. gitring merges the work when the tests pass.",
    "",
    "## Tests",
    "",
    "Add a test for each change. The tests are the files `tests/*.test.js`.",
    "gitring runs them in its test runner: a Cloudflare Worker with no npm packages and no network.",
    "A test file looks like this:",
    "",
    "```js",
    'import { test, expect } from "../harness/test.js";',
    'import { slugify } from "../src/index.js";',
    "",
    'test("slugify makes a lowercase slug", () => {',
    '  expect(slugify("Hello World")).toBe("hello-world");',
    "});",
    "```",
    "",
    "gitring adds `harness/test.js` when the tests run. Do not write that file.",
    "The matchers are `toBe`, `toEqual`, `toContain`, `toMatch`, `toBeTruthy`, `toBeFalsy`, `toThrow` and `.not`.",
    "A test can be async: `await` works in a test.",
    ...(extra.length ? ["", ...extra] : []),
  );
}

function readme(name: string, about: string[], extra: string[] = []): string {
  return lines(`# ${name}`, "", ...about, "", "Agents work on this repository through gitring. See AGENTS.md.", ...(extra.length ? ["", ...extra] : []));
}

function emptyFiles(name: string): TemplateFile[] {
  return [
    { path: "README.md", content: readme(name, ["A new project. Write a task in gitring, and agents write the first files."]) },
    { path: ".gitignore", content: GITIGNORE },
    { path: "AGENTS.md", content: agentsGuide([]) },
  ];
}

function libraryFiles(name: string): TemplateFile[] {
  const pkg = packageName(name);
  return [
    { path: "README.md", content: readme(name, ["A small JavaScript library in plain ES modules."], ["## Use it", "", "```js", `import { slugify, words } from "${pkg}";`, "", 'slugify("Hello World"); // "hello-world"', "```"]) },
    { path: ".gitignore", content: GITIGNORE },
    { path: "AGENTS.md", content: agentsGuide(["## Layout", "", "- `src/index.js`: the public functions of the library.", "- `tests/index.test.js`: their tests."]) },
    {
      path: "package.json",
      content: `${JSON.stringify({ name: pkg, version: "0.1.0", description: `${name}: a small JavaScript library.`, type: "module", main: "src/index.js", exports: { ".": "./src/index.js" }, files: ["src"] }, null, 2)}\n`,
    },
    {
      path: "src/index.js",
      content: lines(
        "/** The words of a text: runs of letters and digits, in lowercase. */",
        "export function words(text) {",
        '  return String(text ?? "")',
        "    .toLowerCase()",
        "    .split(/[^\\p{L}\\p{N}]+/u)",
        "    .filter(Boolean);",
        "}",
        "",
        '/** A slug for a URL: the words of a text, joined with "-". */',
        "export function slugify(text) {",
        '  return words(text).join("-");',
        "}",
      ),
    },
    {
      path: "tests/index.test.js",
      content: lines(
        'import { test, expect } from "../harness/test.js";',
        'import { slugify, words } from "../src/index.js";',
        "",
        'test("words splits a text into lowercase words", () => {',
        '  expect(words("Hello, World! 42 times")).toEqual(["hello", "world", "42", "times"]);',
        "});",
        "",
        'test("words gives no words for an empty text", () => {',
        '  expect(words("")).toEqual([]);',
        "  expect(words(undefined)).toEqual([]);",
        "});",
        "",
        'test("slugify joins the words with dashes", () => {',
        '  expect(slugify("  Hello   World  ")).toBe("hello-world");',
        "});",
      ),
    },
  ];
}

function workerFiles(name: string): TemplateFile[] {
  const pkg = packageName(name);
  return [
    {
      path: "README.md",
      content: readme(
        name,
        ["A Cloudflare Worker that answers JSON. The routes are in `src/routes.js`, a pure module with tests."],
        ["## Run it", "", "```sh", "npx wrangler dev", "```", "", "Then open http://localhost:8787/hello?name=Robin.", "", "## Deploy it", "", "```sh", "npx wrangler deploy", "```"],
      ),
    },
    { path: ".gitignore", content: GITIGNORE },
    {
      path: "AGENTS.md",
      content: agentsGuide([
        "## Layout",
        "",
        "- `src/index.js`: the Worker. It sends each request to `route`.",
        "- `src/routes.js`: the routes. Keep them pure: a Request in, a Response out.",
        "- `tests/routes.test.js`: the tests of the routes. `Request` and `Response` work in the tests.",
      ]),
    },
    { path: "package.json", content: `${JSON.stringify({ name: pkg, version: "0.1.0", private: true, type: "module", scripts: { dev: "wrangler dev", deploy: "wrangler deploy" } }, null, 2)}\n` },
    { path: "wrangler.jsonc", content: `${JSON.stringify({ name: pkg, main: "src/index.js", compatibility_date: "2026-10-01" }, null, 2)}\n` },
    {
      path: "src/index.js",
      content: lines('import { route } from "./routes.js";', "", "export default {", "  async fetch(request) {", "    return route(request);", "  },", "};"),
    },
    {
      path: "src/routes.js",
      content: lines(
        "/** A JSON answer. */",
        "export function json(body, status = 200) {",
        '  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });',
        "}",
        "",
        "/** The answer to one request. */",
        "export async function route(request) {",
        "  const url = new URL(request.url);",
        '  if (request.method !== "GET") return json({ error: "Use GET." }, 405);',
        '  if (url.pathname === "/health") return json({ ok: true });',
        '  if (url.pathname === "/hello") {',
        '    const who = (url.searchParams.get("name") ?? "").trim() || "world";',
        "    return json({ message: `Hello, ${who}!` });",
        "  }",
        '  return json({ error: "Not found." }, 404);',
        "}",
      ),
    },
    {
      path: "tests/routes.test.js",
      content: lines(
        'import { test, expect } from "../harness/test.js";',
        'import { route } from "../src/routes.js";',
        "",
        'const get = (path) => route(new Request("https://example.test" + path));',
        "",
        'test("health answers ok", async () => {',
        '  const res = await get("/health");',
        "  expect(res.status).toBe(200);",
        "  expect(await res.json()).toEqual({ ok: true });",
        "});",
        "",
        'test("hello greets the name in the query", async () => {',
        '  const res = await get("/hello?name=Robin");',
        '  expect((await res.json()).message).toBe("Hello, Robin!");',
        "});",
        "",
        'test("hello greets the world without a name", async () => {',
        '  expect((await (await get("/hello")).json()).message).toBe("Hello, world!");',
        "});",
        "",
        'test("an unknown path answers 404", async () => {',
        '  expect((await get("/nope")).status).toBe(404);',
        "});",
        "",
        'test("a POST answers 405", async () => {',
        '  const res = await route(new Request("https://example.test/health", { method: "POST" }));',
        "  expect(res.status).toBe(405);",
        "});",
      ),
    },
  ];
}

function siteFiles(name: string): TemplateFile[] {
  return [
    {
      path: "README.md",
      content: readme(
        name,
        ["A static site: `index.html`, and a small JavaScript module in `src/`."],
        ["## Look at it", "", "Serve the folder with any static server, for example:", "", "```sh", "npx serve .", "```"],
      ),
    },
    { path: ".gitignore", content: GITIGNORE },
    {
      path: "AGENTS.md",
      content: agentsGuide([
        "## Layout",
        "",
        "- `index.html`: the page.",
        "- `src/app.js`: the code that changes the page. It runs only in the browser.",
        "- `src/counter.js`: pure functions. Put logic here, and test it in `tests/counter.test.js`.",
      ]),
    },
    {
      path: "index.html",
      content: lines(
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        `    <title>${escapeHtml(name)}</title>`,
        '    <script type="module" src="./src/app.js"></script>',
        "  </head>",
        "  <body>",
        "    <main>",
        `      <h1>${escapeHtml(name)}</h1>`,
        '      <button type="button" id="add">Add one</button>',
        '      <p id="count" aria-live="polite">No clicks yet.</p>',
        "    </main>",
        "  </body>",
        "</html>",
      ),
    },
    {
      path: "src/counter.js",
      content: lines(
        "/** The text for a number of clicks. */",
        "export function countText(n) {",
        '  if (!Number.isFinite(n) || n <= 0) return "No clicks yet.";',
        '  return n === 1 ? "1 click." : `${n} clicks.`;',
        "}",
      ),
    },
    {
      path: "src/app.js",
      content: lines(
        'import { countText } from "./counter.js";',
        "",
        "/** Connect the button to the text. */",
        "export function start(doc) {",
        "  let n = 0;",
        '  const out = doc.getElementById("count");',
        '  doc.getElementById("add")?.addEventListener("click", () => {',
        "    n += 1;",
        "    if (out) out.textContent = countText(n);",
        "  });",
        "}",
        "",
        'if (typeof document !== "undefined") start(document);',
      ),
    },
    {
      path: "tests/counter.test.js",
      content: lines(
        'import { test, expect } from "../harness/test.js";',
        'import { countText } from "../src/counter.js";',
        "",
        'test("no clicks", () => {',
        '  expect(countText(0)).toBe("No clicks yet.");',
        "});",
        "",
        'test("one click", () => {',
        '  expect(countText(1)).toBe("1 click.");',
        "});",
        "",
        'test("more clicks", () => {',
        '  expect(countText(3)).toBe("3 clicks.");',
        "});",
      ),
    },
  ];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** The files of a template for a project with this name (the name goes into README.md and package.json). */
export function templateFiles(id: TemplateId, opts: { name: string }): TemplateFile[] {
  const name = opts.name.trim() || "New project";
  switch (id) {
    case "empty":
      return emptyFiles(name);
    case "js-library":
      return libraryFiles(name);
    case "worker-api":
      return workerFiles(name);
    case "static-site":
      return siteFiles(name);
  }
}

/** Words in a description that point to a template. */
const SIGNS: Record<Exclude<TemplateId, "empty">, RegExp> = {
  "worker-api": /\b(api|apis|worker|workers|endpoints?|server|backend|http|rest|json|webhooks?|routes?|proxy|service|bot)\b/g,
  "static-site": /\b(site|website|web ?page|pages?|landing|html|css|browser|frontend|front-end|ui|blog|portfolio|game|dashboard)\b/g,
  "js-library": /\b(library|lib|package|module|functions?|utility|utilities|utils|parser|sdk|npm|helpers?|formatter|validator|algorithm)\b/g,
};

/** Other languages: the JavaScript templates do not fit, and an empty project is the best start. */
const OTHER_LANGUAGE = /\b(python|django|flask|golang|go module|rust|cargo|java|kotlin|ruby|rails|php|c\+\+|c#|dotnet|\.net|swift|elixir|haskell)\b/;

/**
 * The template that fits a description best ("A JSON API for a todo list" → worker-api). A description
 * with no sign, or with another language than JavaScript, gets "empty".
 */
export function pickTemplate(description: string): TemplateId {
  const text = ` ${description.toLowerCase()} `;
  if (OTHER_LANGUAGE.test(text)) return "empty";
  let best: TemplateId = "empty";
  let score = 0;
  for (const id of ["worker-api", "static-site", "js-library"] as const) {
    const n = text.match(SIGNS[id])?.length ?? 0;
    if (n > score) {
      best = id;
      score = n;
    }
  }
  return best;
}
