/**
 * Fixtures: a tiny Worker app that lists products (plain ES modules, no build step).
 * Line numbers matter in the tests; keep these texts stable.
 */

/** Replace exactly one occurrence (throws otherwise, so fixtures cannot drift silently). */
export function replaceOnce(text: string, find: string, replacement: string): string {
  const first = text.indexOf(find);
  if (first < 0) throw new Error(`fixture text not found: ${find}`);
  if (text.indexOf(find, first + 1) >= 0) throw new Error(`fixture text is not unique: ${find}`);
  return text.slice(0, first) + replacement + text.slice(first + find.length);
}

export const toCRLF = (text: string): string => text.replace(/\n/g, "\r\n");

// 1  export const PRODUCTS = [
// 7  export function formatPrice(cents) {
// 11 export function findProduct(id) {
export const PRODUCTS_JS = `export const PRODUCTS = [
  { id: "kettle", title: "Enamel kettle", cents: 2400 },
  { id: "lantern", title: "Brass lantern", cents: 1500 },
  { id: "mug", title: "Stoneware mug", cents: 1800 },
];

export function formatPrice(cents) {
  return "$" + (cents / 100).toFixed(2);
}

export function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}
`;

// 4  function escapeHtml(text) {
// 8  function renderItem(p) {
// 12 export function renderPage({ products, query }) {
export const RENDER_JS = `import { formatPrice } from "./products.js";
import { STYLES } from "./styles.js";

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => \`&#\${c.charCodeAt(0)};\`);
}

function renderItem(p) {
  return \`<li><span class="title">\${escapeHtml(p.title)}</span> <span class="price">\${formatPrice(p.cents)}</span></li>\`;
}

export function renderPage({ products, query }) {
  const items = products.map(renderItem).join("\\n");
  const heading = query ? \`Results for "\${escapeHtml(query)}"\` : "All products";
  return \`<!doctype html>
<html>
  <head><title>Catalog</title><style>\${STYLES}</style></head>
  <body>
    <h1>\${heading}</h1>
    <ul>\${items}</ul>
  </body>
</html>\`;
}
`;

export const STYLES_JS = `export const STYLES = \`
body { font-family: system-ui, sans-serif; margin: 2rem; }
.price { color: #0a6; }
\`;
`;

// 4  export default {
export const INDEX_JS = `import { renderPage } from "./render.js";
import { PRODUCTS } from "./products.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/products") {
      return Response.json(PRODUCTS);
    }
    const query = url.searchParams.get("q") ?? "";
    const products = PRODUCTS.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()));
    return new Response(renderPage({ products, query }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
`;

export const HARNESS_JS = `const tests = [];
export function test(name, fn) {
  tests.push({ name, fn });
}
`;

export const RENDER_TEST_JS = `import { test } from "../harness/test.js";
import { renderPage } from "../src/render.js";

test("renders a heading", () => {
  renderPage({ products: [], query: "" });
});
`;

export const README_MD = `# Catalog

A tiny Worker app.
`;

/** The app tree: path → text. */
export function appFiles(): Map<string, string> {
  return new Map([
    ["src/products.js", PRODUCTS_JS],
    ["src/render.js", RENDER_JS],
    ["src/styles.js", STYLES_JS],
    ["src/index.js", INDEX_JS],
    ["harness/test.js", HARNESS_JS],
    ["tests/render.test.js", RENDER_TEST_JS],
    ["README.md", README_MD],
  ]);
}

export const ALL_FILES = new Set(appFiles().keys());
