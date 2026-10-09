import { afterAll, describe, expect, it } from "vitest";
import { PREVIEW_HEADER, previewModules, servePreview } from "../../src/platform/checks/preview";
import { land, loadSample } from "../fixtures/compose.mjs";
import { nodeLoader, treeMap } from "./node-loader";

const demo = await loadSample();
const seed = treeMap(demo.seed);
const landed = treeMap(land(demo).tree);
const loader = nodeLoader();
afterAll(() => loader.cleanup());

const BASE = "/preview/demo/a_123";

function get(path: string, init?: RequestInit): Request {
  return new Request(`https://gitring.test${path}`, init);
}

// A tiny app that echoes what it receives.
const ECHO = treeMap({
  "src/index.js": `export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/go") return new Response(null, { status: 302, headers: { location: "/api/products" } });
    if (url.pathname === "/away") return new Response(null, { status: 302, headers: { location: "https://example.com/x" } });
    if (url.pathname === "/no-content") return new Response(null, { status: 204 });
    const body = request.method === "GET" ? "" : await request.text();
    return Response.json({ path: url.pathname, search: url.search, method: request.method, body, headers: Object.fromEntries(request.headers) });
  },
};
`,
});

describe("previewModules", () => {
  it("returns null without src/index.js", () => {
    expect(previewModules(new Map([["index.js", "export default {}"]]))).toBeNull();
  });

  it("takes every .js/.mjs file, with src/index.js as the main module", () => {
    const code = previewModules(seed)!;
    expect(code.mainModule).toBe("src/index.js");
    expect(Object.keys(code.modules).sort()).toEqual(["harness/test.js", "src/index.js", "src/products.js", "src/render.js", "src/styles.js", "tests/app.test.js", "tests/run.mjs"]);
    expect(code.modules["src/products.js"]).toBe(demo.seed["src/products.js"]);
  });
});

describe("servePreview", () => {
  it("serves the shop page under the prefix and marks the response", async () => {
    const res = await servePreview(loader, "seed-key", seed, get(`${BASE}/`), BASE);
    expect(res.status).toBe(200);
    expect(res.headers.get(PREVIEW_HEADER)).toBe("seed-key");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Saltmarsh Books");
    expect(html).toContain("The Tidewater Almanac");
    expect(loader.ids).toContain("app:seed-key");
  });

  it("strips the prefix from deeper paths: the JSON API", async () => {
    const res = await servePreview(loader, "seed-key", seed, get(`${BASE}/api/products`), BASE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(8);
  });

  it("keeps the query string (landed tree: search + currency)", async () => {
    const res = await servePreview(loader, "landed-key", landed, get(`${BASE}/?q=tide&currency=EUR`), BASE);
    const html = await res.text();
    expect(html).toContain("€18.39");
    expect(html).toContain("A Small Book of Tides");
    expect(html).not.toContain("Knots for Small Boats");
    expect(html).toContain('name="currency" value="EUR"');
  });

  it("accepts a base path with a trailing slash", async () => {
    const res = await servePreview(loader, "echo", ECHO, get(`${BASE}/x/y?z=1`), `${BASE}/`);
    expect(await res.json()).toMatchObject({ path: "/x/y", search: "?z=1" });
  });

  it("redirects the bare prefix to the prefix with a slash, so relative links work", async () => {
    const res = await servePreview(loader, "seed-key", seed, get(`${BASE}?currency=INR`), BASE);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE}/?currency=INR`);
    expect(res.headers.get(PREVIEW_HEADER)).toBe("seed-key");
  });

  it("forwards the method and the body, and drops the credentials of the Gitring origin", async () => {
    const request = get(`${BASE}/form`, { method: "POST", body: "q=salt", headers: { cookie: "session=secret", authorization: "Bearer key", "x-test": "1" } });
    const echoed = (await (await servePreview(loader, "echo", ECHO, request, BASE)).json()) as { headers: Record<string, string> };
    expect(echoed).toMatchObject({ path: "/form", method: "POST", body: "q=salt" });
    expect(echoed.headers["x-test"]).toBe("1");
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.headers.authorization).toBeUndefined();
  });

  it("puts the prefix on root-relative redirects and leaves other redirects alone", async () => {
    const inside = await servePreview(loader, "echo", ECHO, get(`${BASE}/go`), BASE);
    expect(inside.status).toBe(302);
    expect(inside.headers.get("location")).toBe(`${BASE}/api/products`);
    const outside = await servePreview(loader, "echo", ECHO, get(`${BASE}/away`), BASE);
    expect(outside.headers.get("location")).toBe("https://example.com/x");
  });

  it("passes a response with no body through", async () => {
    const res = await servePreview(loader, "echo", ECHO, get(`${BASE}/no-content`), BASE);
    expect(res.status).toBe(204);
    expect(res.headers.get(PREVIEW_HEADER)).toBe("echo");
  });

  it("forwards the whole path when the base path is empty", async () => {
    const res = await servePreview(loader, "echo", ECHO, get("/a/b"), "");
    expect(await res.json()).toMatchObject({ path: "/a/b" });
  });

  it("shows a friendly 500 page when the app throws, with the message escaped", async () => {
    const files = treeMap({ "src/index.js": 'export default { async fetch() { throw new Error("<b>boom</b> & more"); } };' });
    const res = await servePreview(loader, "throws", files, get(`${BASE}/`), BASE);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get(PREVIEW_HEADER)).toBe("throws");
    const html = await res.text();
    expect(html).toContain("The preview did not start.");
    expect(html).toContain("&lt;b&gt;boom&lt;/b&gt; &amp; more");
    expect(html).not.toContain("<b>boom</b>");
  });

  it("shows a friendly 500 page when the app does not load", async () => {
    const files = treeMap({ "src/index.js": 'import { nope } from "./lib.js";\nexport default { fetch() { return new Response(nope); } };', "src/lib.js": "export const yes = 1;" });
    const res = await servePreview(loader, "link-error", files, get(`${BASE}/`), BASE);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Uncaught SyntaxError: .*nope/);
  });

  it("answers 404 when the tree has no src/index.js", async () => {
    const res = await servePreview(loader, "empty", new Map([["README.md", "# hi"]]), get(`${BASE}/`), BASE);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This attempt has no app to preview.");
  });

  it("answers 504 when the app does not answer in time", async () => {
    const files = treeMap({ "src/index.js": "export default { fetch() { return new Promise(() => {}); } };" });
    const res = await servePreview(loader, "hang", files, get(`${BASE}/`), BASE, { timeoutMs: 200 });
    expect(res.status).toBe(504);
    expect(await res.text()).toContain("The preview did not answer in time.");
  });

  it("adds a CSP sandbox only when asked", async () => {
    const plain = await servePreview(loader, "seed-key", seed, get(`${BASE}/`), BASE);
    expect(plain.headers.get("content-security-policy")).toBeNull();
    const boxed = await servePreview(loader, "seed-key", seed, get(`${BASE}/`), BASE, { sandbox: true });
    expect(boxed.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts allow-forms/);
  });

  it("loads the app with no network and the compatibility date of Gitring", async () => {
    await servePreview(loader, "seed-key", seed, get(`${BASE}/`), BASE);
    expect(loader.codes.get("app:seed-key")).toMatchObject({ compatibilityDate: "2026-10-01", mainModule: "src/index.js", globalOutbound: null });
    expect(loader.codes.get("app:seed-key")!.modules["tests/run.mjs"]).toEqual({ js: demo.seed["tests/run.mjs"] });
  });
});
