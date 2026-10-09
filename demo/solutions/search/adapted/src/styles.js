// Styles for Saltmarsh Books: a calm, light page, like paper by the sea.
// There is one const for each region of the page. Edit the const of the region that you change.

const TOKENS = `
:root {
  color-scheme: light;
  --bg: #f6f3ec;
  --surface: #fffdf8;
  --ink: #1c2a2e;
  --ink-soft: #52615f;
  --line: #e4ddcd;
  --accent: #1f6b66;
  --accent-ink: #ffffff;
  --accent-soft: #e2eeeb;
  --sand: #efe6d2;
  --shadow: 0 1px 2px rgb(28 42 46 / 0.06), 0 6px 18px rgb(28 42 46 / 0.08);
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
`;

const BASE = `
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  color: var(--ink);
  background: var(--bg);
  font: 16px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
a {
  color: var(--accent);
  text-underline-offset: 3px;
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
`;

const HEADER = `
.masthead {
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.bar {
  max-width: 1040px;
  margin: 0 auto;
  padding: 18px 20px 6px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--ink);
  text-decoration: none;
  font: 600 1.4rem/1.2 var(--serif);
}
.brand-mark {
  width: 28px;
  height: 28px;
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.6;
  stroke-linecap: round;
}
.nav {
  display: flex;
  align-items: center;
  gap: 18px;
  font-size: 0.95rem;
}
.nav a {
  padding: 4px 0;
  color: var(--ink-soft);
  text-decoration: none;
  border-bottom: 2px solid transparent;
}
.nav a:hover,
.nav a[aria-current="page"] {
  color: var(--ink);
  border-bottom-color: var(--accent);
}
.tagline {
  max-width: 1040px;
  margin: 0 auto;
  padding: 0 20px 16px;
  color: var(--ink-soft);
  font: italic 1rem/1.4 var(--serif);
}
.search {
  max-width: 1040px;
  margin: 0 auto;
  padding: 0 20px 18px;
}
.search form {
  display: flex;
  gap: 8px;
  max-width: 520px;
}
.search input[type="search"] {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  background: var(--bg);
  font: inherit;
}
.search button {
  padding: 8px 16px;
  border: 0;
  border-radius: 8px;
  color: var(--accent-ink);
  background: var(--accent);
  font: inherit;
  cursor: pointer;
}
`;

const SHELF = `
.shelf {
  max-width: 1040px;
  margin: 0 auto;
  padding: 28px 20px 56px;
}
.shelf-head h1 {
  margin: 0;
  font: 500 1.9rem/1.2 var(--serif);
}
.lede {
  margin: 6px 0 0;
  color: var(--ink-soft);
}
.currency {
  margin: 14px 0 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--ink-soft);
  font-size: 0.9rem;
}
.currency a {
  padding: 1px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-soft);
  text-decoration: none;
}
.currency a[aria-current="true"] {
  color: var(--accent-ink);
  background: var(--accent);
  border-color: var(--accent);
}
.books {
  list-style: none;
  margin: 28px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 28px 22px;
}
@media (max-width: 520px) {
  .books {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 22px 14px;
  }
}
.results {
  margin: 18px 0 0;
  color: var(--ink-soft);
}
`;

const BOOK = `
.book {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cover {
  aspect-ratio: 3 / 4;
  margin-bottom: 10px;
  display: grid;
  place-items: center;
  border-radius: 3px 8px 8px 3px;
  background:
    linear-gradient(90deg, rgb(0 0 0 / 0.16) 0 7px, transparent 7px),
    linear-gradient(160deg, hsl(var(--hue) 40% 45%), hsl(var(--hue) 46% 28%));
  color: rgb(255 253 248 / 0.92);
  font: italic 500 3.2rem/1 var(--serif);
  box-shadow: var(--shadow);
}
.title {
  margin: 0;
  font: 600 1.05rem/1.3 var(--serif);
}
.author {
  margin: 0;
  color: var(--ink-soft);
  font-size: 0.92rem;
}
.tags {
  margin: 4px 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--ink-soft);
  background: var(--sand);
  font-size: 0.75rem;
}
.price {
  margin: 6px 0 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
`;

const FOOTER = `
.foot {
  padding: 22px 20px 32px;
  border-top: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: 0.88rem;
  text-align: center;
}
.foot p {
  margin: 4px 0;
}
`;

export const CSS = [TOKENS, BASE, HEADER, SHELF, BOOK, FOOTER].join("");
