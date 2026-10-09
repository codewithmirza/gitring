// The shop page of Saltmarsh Books. Plain template strings: no framework, no build step.
import { formatPrice } from "./products.js";
import { CSS } from "./styles.js";

const SHOP_NAME = "Saltmarsh Books";

// query holds the URL query parameters, for example { q: "tide" }.
export function renderPage({ products, query = {} }) {
  const items = products.map((p) => renderItem(p)).join("\n");
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
${renderHeader()}
<main class="shelf">
  <div class="shelf-head">
    <h1>New on the shelf</h1>
    <p class="lede">Hand-picked books from the edge of the estuary.</p>
  </div>
  <ul class="books">
${items}
  </ul>
</main>
${renderFooter()}
</body>
</html>
`;
}

function renderHeader() {
  return `<header class="masthead">
  <div class="bar">
    <a class="brand" href="./">
      <svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true"><path d="M3 20c3 0 3-2 6-2s3 2 6 2 3-2 6-2 3 2 4 2M9 15V7M13 15V4M17 15V8"/></svg>
      <span>${SHOP_NAME}</span>
    </a>
    <nav class="nav" aria-label="Main">
      <a href="./" aria-current="page">Books</a>
      <a href="api/products">API</a>
      <button class="theme-toggle" type="button" aria-pressed="false"><span aria-hidden="true">◐</span> Dark mode</button>
      <script>
        (function () {
          var button = document.currentScript.previousElementSibling;
          var root = document.documentElement;
          var saved = null;
          try { saved = localStorage.getItem("theme"); } catch (e) {}
          var dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
          function apply() {
            root.setAttribute("data-theme", dark ? "dark" : "light");
            button.setAttribute("aria-pressed", String(dark));
          }
          button.addEventListener("click", function () {
            dark = !dark;
            apply();
            try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (e) {}
          });
          apply();
        })();
      </script>
    </nav>
  </div>
  <p class="tagline">New and second-hand books by the harbour since 1987.</p>
</header>`;
}

function renderItem(p) {
  return `<li class="book">
    <div class="cover" style="--hue: ${(p.id * 47) % 360}" aria-hidden="true">${initial(p.title)}</div>
    <h2 class="title">${escapeHtml(p.title)}</h2>
    <p class="author">${escapeHtml(p.author)}</p>
    <p class="tags">${p.tags.map(renderTag).join("")}</p>
    <p class="price">${formatPrice(p.cents)}</p>
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
