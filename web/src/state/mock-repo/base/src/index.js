// Saltmarsh Books: a small Worker web app.
// GET /              the shelf (HTML)
// GET /about         the shop (HTML)
// GET /api/products  every book (JSON)
import { renderPage, renderAbout } from "./render.js";
import { books } from "./products.js";

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/products") {
      return Response.json(books);
    }
    if (url.pathname === "/about") {
      return html(renderAbout());
    }
    if (url.pathname === "/") {
      return html(renderPage(books));
    }
    return html("<h1>Not found</h1>", 404);
  },
};
