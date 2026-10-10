/**
 * A tiny project for the tests of the check runner and the preview loader: a greeter Worker in plain
 * ES modules, one test file for the gitring harness, and a .mjs helper. It has no harness/test.js of its
 * own, so gitring injects its harness (as it does for any tree that has none).
 *
 * The files are plain data (path → text), with no imports, so Vitest and the workerd probe in
 * test/workers/checks can both use them.
 */
export type Tree = Record<string, string>;

const lines = (...rows: string[]): string => rows.join("\n") + "\n";

/** The test file of the greeter, and how many tests it registers. */
export const GREETER_TEST_FILE = "tests/greet.test.js";
export const GREETER_TEST_COUNT = 4;

export const GREETER: Tree = {
  "README.md": lines("# Greeter", "", "Says hello. Plain ES modules, no dependencies."),
  "package.json": lines("{", '  "name": "greeter",', '  "private": true,', '  "type": "module"', "}"),
  "src/greet.js": lines(
    'export const GREETINGS = ["Hello", "Hi", "Hey"];',
    "",
    'export function greet(name = "world", greeting = GREETINGS[0]) {',
    '  return greeting + ", " + name + "!";',
    "}",
  ),
  "src/index.js": lines(
    'import { GREETINGS, greet } from "./greet.js";',
    "",
    "function escapeHtml(text) {",
    '  return String(text).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");',
    "}",
    "",
    "export default {",
    "  async fetch(request) {",
    "    const url = new URL(request.url);",
    '    if (url.pathname === "/api/greetings") return Response.json(GREETINGS);',
    "    const one = url.pathname.match(/^\\/api\\/greetings\\/(\\d+)$/);",
    "    if (one) {",
    "      const greeting = GREETINGS[Number(one[1])];",
    '      if (greeting === undefined) return Response.json({ error: "No such greeting." }, { status: 404 });',
    "      return Response.json({ greeting });",
    "    }",
    '    const text = greet(url.searchParams.get("name") ?? undefined, url.searchParams.get("greeting") ?? undefined);',
    '    return new Response("<!doctype html><title>Greeter</title><h1>" + escapeHtml(text) + "</h1>", {',
    '      headers: { "content-type": "text/html; charset=utf-8" },',
    "    });",
    "  },",
    "};",
  ),
  [GREETER_TEST_FILE]: lines(
    'import { test, expect } from "../harness/test.js";',
    'import { greet } from "../src/greet.js";',
    'import { get } from "./helpers.mjs";',
    "",
    'test("greets the world by default", () => {',
    '  expect(greet()).toBe("Hello, world!");',
    "});",
    "",
    'test("greets a name with a chosen greeting", () => {',
    '  expect(greet("Ada", "Hey")).toBe("Hey, Ada!");',
    "});",
    "",
    'test("serves the greeting as a page", async () => {',
    '  const res = await get("/?name=Ada");',
    "  expect(res.status).toBe(200);",
    '  expect(await res.text()).toContain("Hello, Ada!");',
    "});",
    "",
    'test("lists the greetings as JSON", async () => {',
    '  const res = await get("/api/greetings");',
    '  expect(await res.json()).toEqual(["Hello", "Hi", "Hey"]);',
    "});",
  ),
  "tests/helpers.mjs": lines(
    'import worker from "../src/index.js";',
    "",
    "export function get(path) {",
    '  return worker.fetch(new Request("https://greeter.test" + path));',
    "}",
  ),
};
