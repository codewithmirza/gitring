// Saltmarsh Books on Cloudflare Workers.
// Routes: "/" is the shop page. "/api/products" is the list of books as JSON.
import { PRODUCTS } from "./products.js";
import { renderPage } from "./render.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return pageResponse(url);
    if (url.pathname.startsWith("/api/")) return apiResponse(url);
    return new Response("Not found", { status: 404 });
  },
};

function pageResponse(url) {
  const query = Object.fromEntries(url.searchParams);
  const html = renderPage({ products: PRODUCTS, query });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function apiResponse(url) {
  if (url.pathname === "/api/products") return json(PRODUCTS);
  const match = url.pathname.match(/^\/api\/products\/([^/]+)$/);
  if (match) return productResponse(match[1]);
  return json({ error: "Not found" }, 404);
}

function productResponse(id) {
  const product = PRODUCTS.find((p) => String(p.id) === id);
  if (!product) return json({ error: `No book with id ${id}` }, 404);
  return json(product);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
