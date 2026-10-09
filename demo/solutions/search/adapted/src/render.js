// The shop page of Saltmarsh Books. Plain template strings: no framework, no build step.
import { CURRENCIES, findProducts, formatPrice } from "./products.js";
import { CSS } from "./styles.js";

const SHOP_NAME = "Saltmarsh Books";

// query holds the URL query parameters, for example { q: "tide" }.
export function renderPage({ products, query = {} }) {
  const currency = pickCurrency(query.currency);
  const shown = findProducts(query.q, products);
  const items = shown.map((p) => renderItem(p, currency)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${SHOP_NAME}</title>
  <link rel="icon" href="data:,">
  <style>${CSS}</style>
</head>
<body>
${renderHeader(query)}
<main class="shelf">
  <div class="shelf-head">
    <h1>New on the shelf</h1>
    <p class="lede">Hand-picked books from the edge of the estuary.</p>
    ${renderCurrencyPicker(query, currency)}
  </div>
  ${renderResults(query.q, shown.length)}
  <ul class="books">
${items}
  </ul>
</main>
${renderFooter()}
</body>
</html>
`;
}

// A known currency code from the query, or "USD".
function pickCurrency(code) {
  const upper = String(code || "").toUpperCase();
  return Object.hasOwn(CURRENCIES, upper) ? upper : "USD";
}

// Links that keep the other query parameters and change only the currency.
function renderCurrencyPicker(query, current) {
  const links = Object.keys(CURRENCIES).map((code) => {
    const href = "?" + new URLSearchParams({ ...query, currency: code });
    const mark = code === current ? ' aria-current="true"' : "";
    return `<a href="${escapeHtml(href)}"${mark}>${code}</a>`;
  });
  return `<nav class="currency" aria-label="Currency">Prices in ${links.join("")}</nav>`;
}

function renderHeader(query) {
  return `<header class="masthead">
  <div class="bar">
    <a class="brand" href="./">
      <svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true"><path d="M3 20c3 0 3-2 6-2s3 2 6 2 3-2 6-2 3 2 4 2M9 15V7M13 15V4M17 15V8"/></svg>
      <span>${SHOP_NAME}</span>
    </a>
    <nav class="nav" aria-label="Main">
      <a href="./" aria-current="page">Books</a>
      <a href="api/products">API</a>
    </nav>
  </div>
  <p class="tagline">New and second-hand books by the harbour since 1987.</p>
  <div class="search">
    <form role="search" action="./" method="get">
      <input type="search" name="q" value="${escapeHtml(query.q || "")}" placeholder="Title or author" aria-label="Search books">
      ${hiddenField("currency", query.currency)}
      <button type="submit">Search</button>
    </form>
  </div>
</header>`;
}

// One line about the search results. Nothing when there is no search.
function renderResults(q, count) {
  const text = String(q || "").trim();
  if (!text) return "";
  if (count === 0) return `<p class="results" role="status">No books match your search.</p>`;
  const noun = count === 1 ? "book matches" : "books match";
  return `<p class="results" role="status">${count} ${noun} “${escapeHtml(text)}”.</p>`;
}

// Keep a query parameter in the search form, so that a search does not reset it.
function hiddenField(name, value) {
  return value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">` : "";
}

function renderItem(p, currency) {
  return `<li class="book">
    <div class="cover" style="--hue: ${(p.id * 47) % 360}" aria-hidden="true">${initial(p.title)}</div>
    <h2 class="title">${escapeHtml(p.title)}</h2>
    <p class="author">${escapeHtml(p.author)}</p>
    <p class="tags">${p.tags.map(renderTag).join("")}</p>
    <p class="price">${formatPrice(p.cents, currency)}</p>
  </li>`;
}

function renderTag(tag) {
  return `<span class="tag">${escapeHtml(tag)}</span>`;
}

// The first letter of the title, without "The", "A" or "An".
function initial(title) {
  return escapeHtml(title.replace(/^(the|a|an)\s+/i, "").charAt(0));
}

function renderFooter() {
  return `<footer class="foot">
  <p>${SHOP_NAME} · 4 Harbour Lane, Saltmarsh · Open Tuesday to Sunday, 10 to 6</p>
  <p>Ask at the counter for books that are not on the shelf.</p>
</footer>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
