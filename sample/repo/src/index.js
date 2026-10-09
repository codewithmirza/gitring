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
  return json({ error: "Not found" }, 404);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
