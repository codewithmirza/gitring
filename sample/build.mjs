#!/usr/bin/env node
// Build sample/intents.json and sample/bundle.json from the sources in sample/.
//
//   node sample/build.mjs           write both files
//   node sample/build.mjs --check   exit 1 if a file is out of date
//
// Sources: the intent metadata below, the check files in sample/checks/ and the seed repo in
// sample/repo/. bundle.json holds the seed and the intents in one JSON file, so the Worker can
// create a sample project without file access.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const INTENTS = [
  {
    slug: "currency",
    title: "Show prices in the reader's currency",
    goal: [
      "Let readers see prices in US dollars, euros or Indian rupees with `?currency=USD`, `?currency=EUR` or `?currency=INR`.",
      'Change `formatPrice(cents)` in `src/products.js` to `formatPrice(cents, currency = "USD")`, with fixed rates: 1 USD = 0.92 EUR = 83 INR.',
      "The amount is `Math.round(cents * rate) / 100` in the new currency: euros keep two decimals (`€18.39`), rupees show whole rupees with a comma for thousands (1999 cents → `₹1,659`), dollars stay `$19.99`, and an unknown code falls back to USD.",
      'Pass the currency from `renderPage` through `renderItem` to `formatPrice`, and add relative links that switch the currency (for example `href="?currency=EUR"`).',
    ].join(" "),
    checks: [
      {
        path: "tests/currency.test.js",
        description: "formatPrice(cents, currency) converts and formats USD, EUR and INR; ?currency= changes every price on the page; the page links to each currency.",
      },
    ],
    expect: {
      files: ["src/products.js", "src/render.js", "src/styles.js"],
      symbols: [
        "src/products.js#CURRENCIES",
        "src/products.js#formatPrice",
        "src/products.js#groupThousands",
        "src/render.js#renderPage",
        "src/render.js#pickCurrency",
        "src/render.js#renderCurrencyPicker",
        "src/render.js#renderItem",
        "src/styles.js#SHELF",
      ],
    },
  },
  {
    slug: "dark-mode",
    title: "Add a dark mode",
    fanout: 2,
    goal: [
      "Add a dark mode that readers can switch on and off.",
      'Put a `<button class="theme-toggle">` with `aria-pressed` at the end of the nav in the page header (`src/render.js`), with a tiny inline script that sets `data-theme` on `<html>`, updates `aria-pressed` and remembers the choice in `localStorage`.',
      'In `src/styles.js`, keep colours in CSS custom properties and override `--bg`, `--ink` and the other tokens under `[data-theme="dark"]`.',
      "Follow `prefers-color-scheme: dark` until the reader makes a choice.",
    ].join(" "),
    checks: [
      {
        path: "tests/dark-mode.test.js",
        description: 'The header has a theme toggle with aria-pressed and an inline script; the CSS sets dark tokens under [data-theme="dark"] and follows prefers-color-scheme.',
      },
    ],
    expect: {
      files: ["src/render.js", "src/styles.js"],
      symbols: ["src/render.js#renderHeader", "src/styles.js#TOKENS", "src/styles.js#HEADER"],
    },
  },
  {
    slug: "search",
    title: "Search books by title or author",
    goal: [
      "Let readers search the books by title or author.",
      "Add `export function findProducts(query)` to `src/products.js`: it returns the books whose title or author contains the trimmed query, in any case, and every book for an empty or missing query.",
      'Add a search form to the page header (`role="search"`, a field `name="q"`, a relative `action="./"`) and filter the list with `?q=`.',
      "Keep the prices on the results, keep the query in the search box, and show `No books match your search.` when nothing matches.",
    ].join(" "),
    checks: [
      {
        path: "tests/search.test.js",
        description: "findProducts(query) matches title or author in any case; the header has a search form; ?q= filters the list, keeps prices and the query, and handles no match.",
      },
    ],
    expect: {
      files: ["src/products.js", "src/render.js", "src/styles.js"],
      symbols: [
        "src/products.js#findProducts",
        "src/products.js#matchesQuery",
        "src/render.js#renderPage",
        "src/render.js#renderHeader",
        "src/render.js#renderResults",
        "src/styles.js#HEADER",
        "src/styles.js#SHELF",
      ],
    },
  },
  {
    slug: "staff-picks",
    title: "Mark staff picks",
    goal: [
      "Mark three books as staff picks: The Tidewater Almanac (id 1), Fog over Marram Point (id 6) and A Small Book of Tides (id 8).",
      "Set `staffPick: true` on them in `PRODUCTS` (`src/products.js`).",
      'In `renderItem` (`src/render.js`), show `<span class="badge">Staff pick</span>` next to the price, inside the price line of each staff pick.',
      "Other books show no badge.",
    ].join(" "),
    checks: [
      {
        path: "tests/staff-picks.test.js",
        description: "Books 1, 6 and 8 are staff picks and show a Staff pick badge in the price line; other books show none.",
      },
    ],
    expect: {
      files: ["src/products.js", "src/render.js", "src/styles.js"],
      symbols: ["src/products.js#PRODUCTS", "src/render.js#renderItem", "src/render.js#renderBadge", "src/styles.js#BOOK"],
    },
  },
  {
    slug: "api-item",
    title: "Add a JSON endpoint for one book",
    goal: [
      "Add `GET /api/products/:id` to `src/index.js`, so that other apps can fetch one book.",
      'Return the book as JSON with status 200, or `{ "error": "…" }` as JSON with status 404 when no book has that id.',
      "Keep `/api/products` unchanged.",
    ].join(" "),
    checks: [
      {
        path: "tests/api-item.test.js",
        description: "GET /api/products/:id returns one book as JSON, or a 404 JSON error for an unknown id.",
      },
    ],
    expect: {
      files: ["src/index.js"],
      symbols: ["src/index.js#apiResponse", "src/index.js#productResponse"],
    },
  },
];

/** sample/intents.json: the sample intents with the full source of each check file. */
export async function buildIntents(dir = SAMPLE_DIR) {
  const intents = [];
  for (const intent of INTENTS) {
    const checks = [];
    for (const check of intent.checks) {
      const content = await readFile(path.join(dir, "checks", path.basename(check.path)), "utf8");
      checks.push({ path: check.path, description: check.description, content });
    }
    intents.push({ ...intent, checks });
  }
  return intents;
}

async function readTree(dir) {
  const tree = {};
  async function walk(rel) {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else tree[child] = await readFile(path.join(dir, child), "utf8");
    }
  }
  await walk("");
  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** sample/bundle.json: the seed repo and the intents of the sample project, in one importable file. */
export async function buildBundle(dir = SAMPLE_DIR, intents) {
  return {
    schema: "bearing.sample/v1",
    name: "Saltmarsh Books",
    repo: await readTree(path.join(dir, "repo")),
    intents,
  };
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function main() {
  const check = process.argv.includes("--check");
  const intents = await buildIntents();
  const outputs = [
    ["intents.json", json(intents)],
    ["bundle.json", json(await buildBundle(SAMPLE_DIR, intents))],
  ];
  let stale = 0;
  for (const [name, content] of outputs) {
    const file = path.join(SAMPLE_DIR, name);
    if (check) {
      const current = await readFile(file, "utf8").catch(() => "");
      if (current !== content) {
        stale += 1;
        console.error(`sample/${name} is out of date. Run: node sample/build.mjs`);
      }
    } else {
      await writeFile(file, content);
      console.log(`wrote sample/${name} (${content.length} bytes)`);
    }
  }
  process.exitCode = stale > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(SAMPLE_DIR, "build.mjs")) await main();
