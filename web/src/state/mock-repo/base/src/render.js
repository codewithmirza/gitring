// Layout for Saltmarsh Books. Plain template strings. No framework.
import { css } from "./styles.js";
import { formatPrice } from "./products.js";

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderPage(books) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Saltmarsh Books</title>
  <style>${css}</style>
</head>
<body>
  ${renderHeader()}
  <main class="shelf">
    ${books.map(renderBookCard).join("\n    ")}
  </main>
  ${renderFooter()}
</body>
</html>`;
}

export function renderHeader() {
  return `<header class="masthead">
    <a class="brand" href="/">Saltmarsh Books</a>
    <p class="tagline">New and second-hand books by the estuary</p>
    <nav class="nav" aria-label="Main">
      <a href="/">Shelf</a>
      <a href="/about">About</a>
      <a href="/api/products">API</a>
    </nav>
  </header>`;
}

export function renderBookCard(book) {
  return `<article class="book">
      <h2 class="book-title">${escape(book.title)}</h2>
      <p class="book-author">${escape(book.author)}</p>
      <p class="book-price">${formatPrice(book.cents)}</p>
    </article>`;
}

export function renderAbout() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>About · Saltmarsh Books</title><style>${css}</style></head>
<body>
  ${renderHeader()}
  <main class="prose">
    <h1>About the shop</h1>
    <p>We sell new and second-hand books about the coast, the weather and the birds.</p>
  </main>
  ${renderFooter()}
</body>
</html>`;
}

export function renderFooter() {
  return `<footer class="colophon">Saltmarsh Books · 4 Harbour Lane · Open Tuesday to Sunday</footer>`;
}
