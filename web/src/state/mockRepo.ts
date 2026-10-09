/**
 * The demo repo for the mock harbor: "Saltmarsh Books", a small Worker web app.
 * Base files and attempt patches are real files, imported as text.
 */
import indexJs from "./mock-repo/base/src/index.js?raw";
import renderJs from "./mock-repo/base/src/render.js?raw";
import productsJs from "./mock-repo/base/src/products.js?raw";
import stylesJs from "./mock-repo/base/src/styles.js?raw";
import harnessJs from "./mock-repo/base/harness/test.js?raw";
import productsTest from "./mock-repo/base/tests/products.test.js?raw";
import renderTest from "./mock-repo/base/tests/render.test.js?raw";
import indexTest from "./mock-repo/base/tests/index.test.js?raw";
import readme from "./mock-repo/base/README.md?raw";
import agentsMd from "./mock-repo/base/AGENTS.md?raw";
import openShop from "./mock-repo/base/.bearing/intents/open-the-shop.md?raw";

import json1 from "./mock-repo/patches/json-1.patch?raw";
import currency1 from "./mock-repo/patches/currency-1.patch?raw";
import dark1 from "./mock-repo/patches/dark-1.patch?raw";
import dark2 from "./mock-repo/patches/dark-2.patch?raw";
import search1 from "./mock-repo/patches/search-1.patch?raw";
import search2 from "./mock-repo/patches/search-2.patch?raw";
import picks1 from "./mock-repo/patches/picks-1.patch?raw";
import picks2 from "./mock-repo/patches/picks-2.patch?raw";

import { parsePatch, type PatchFile, type Tree } from "./patchkit";

export function baseTree(): Tree {
  return new Map<string, string>([
    ["src/index.js", indexJs],
    ["src/render.js", renderJs],
    ["src/products.js", productsJs],
    ["src/styles.js", stylesJs],
    ["harness/test.js", harnessJs],
    ["tests/products.test.js", productsTest],
    ["tests/render.test.js", renderTest],
    ["tests/index.test.js", indexTest],
    ["README.md", readme],
    ["AGENTS.md", agentsMd],
    [".bearing/intents/open-the-shop.md", openShop],
  ]);
}

const RAW_PATCHES: Record<string, string> = {
  "json-1": json1,
  "currency-1": currency1,
  "dark-1": dark1,
  "dark-2": dark2,
  "search-1": search1,
  "search-2": search2,
  "picks-1": picks1,
  "picks-2": picks2,
};

const parsed = new Map<string, PatchFile[]>();
export function patch(key: string): PatchFile[] {
  let p = parsed.get(key);
  if (!p) {
    p = parsePatch(RAW_PATCHES[key] ?? "");
    parsed.set(key, p);
  }
  return p;
}

/** Test names in a test file, in order. */
export function testNames(source: string): string[] {
  return [...source.matchAll(/\btest\(\s*"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
}

/* ───────────── preview runtime ───────────── */

/**
 * A preview document for an attempt. It runs the attempt's real modules inside a
 * sandboxed iframe (opaque origin): each file becomes a blob module, the Worker's
 * fetch handler answers the request, and the HTML replaces the document. Links and
 * forms inside the preview go through the same handler.
 */
export function previewDocument(files: Tree, path = "/", label = "preview"): string {
  const payload: Record<string, string> = {};
  for (const [p, c] of files) if (/\.(m?js)$/.test(p) && !p.startsWith("tests/")) payload[p] = c;
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const boot = `
const files = JSON.parse(document.getElementById("bearing-files").textContent);
const urls = new Map();
const resolve = (from, spec) => {
  const parts = from.split("/"); parts.pop();
  for (const seg of spec.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
  return parts.join("/");
};
const build = (path) => {
  if (urls.has(path)) return urls.get(path);
  const src = files[path];
  if (src == null) throw new Error("Module not found: " + path);
  const code = src.replace(/(from\\s*|import\\s*\\(\\s*|import\\s+)(["'])(\\.{1,2}\\/[^"']+)\\2/g,
    (m, pre, q, spec) => pre + q + build(resolve(path, spec)) + q);
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  urls.set(path, url);
  return url;
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const ORIGIN = "https://saltmarsh-books.preview";
let current = ${JSON.stringify(path)};
let mod = null;
function render(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.replaceChild(document.adoptNode(doc.documentElement), document.documentElement);
  for (const old of document.querySelectorAll("script")) {
    const s = document.createElement("script");
    s.textContent = old.textContent;
    old.replaceWith(s);
  }
}
async function go(href) {
  try {
    mod = mod || (await import(build("src/index.js")));
    const url = new URL(href, ORIGIN + current);
    const res = await mod.default.fetch(new Request(url.href, { headers: { "accept-language": navigator.language || "en-GB" } }));
    const type = res.headers.get("content-type") || "";
    let body = await res.text();
    if (type.includes("json")) {
      let pretty = body;
      try { pretty = JSON.stringify(JSON.parse(body), null, 2); } catch (e) {}
      body = '<!doctype html><meta charset="utf-8"><title>' + esc(url.pathname) + '</title>' +
        '<pre style="margin:0;padding:16px;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap">' + esc(pretty) + '</pre>';
    }
    current = url.pathname + url.search;
    render(body);
    parent.postMessage({ type: "bearing-preview", label: ${JSON.stringify(label)}, path: current, status: res.status }, "*");
  } catch (err) {
    render('<!doctype html><meta charset="utf-8"><pre style="padding:16px;color:#a32;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap">' +
      'The preview failed to run.\\n\\n' + esc(err && err.stack || err) + '</pre>');
    parent.postMessage({ type: "bearing-preview", label: ${JSON.stringify(label)}, path: current, status: 500 }, "*");
  }
}
addEventListener("click", (e) => {
  const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (/^([a-z]+:|\\/\\/|#)/i.test(href)) return;
  e.preventDefault();
  go(href);
}, true);
addEventListener("submit", (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  e.preventDefault();
  const action = f.getAttribute("action") || current.split("?")[0];
  const q = new URLSearchParams(new FormData(f)).toString();
  go(action + (q ? "?" + q : ""));
}, true);
addEventListener("message", (e) => {
  if (e.data && e.data.type === "bearing-preview-go") go(e.data.path || current);
});
go(current);
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${label}</title>
<style>html,body{margin:0;font:14px/1.5 Georgia,serif;color:#5f6b76;background:#fbfaf7}</style></head>
<body><p style="padding:16px">Starting the preview…</p>
<script type="application/json" id="bearing-files">${json}</script>
<script type="module">${boot}</script></body></html>`;
}
