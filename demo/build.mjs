#!/usr/bin/env node
// Build demo/intents.json and demo/bundle.json from the sources in demo/.
//
//   node demo/build.mjs           write both files
//   node demo/build.mjs --check   exit 1 if a file is out of date
//
// Sources: the intent metadata below, the check files in demo/checks/, the seed repo in demo/repo/
// and the reference solutions in demo/solutions/. bundle.json holds all of it in one JSON file,
// so a Worker can import the demo (seed, intents, solutions, landed tree) without file access.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEMO_DIR, LANDING_ORDER, land, loadDemo } from "./tools/compose.mjs";

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
    collisions: [
      { with: "search", kind: "interface", why: "Changes formatPrice(cents) to formatPrice(cents, currency) and edits renderPage, where search filters the list." },
      { with: "staff-picks", kind: "interface", why: "Edits the price line of renderItem, where staff-picks adds its badge, and changes the formatPrice call on it." },
    ],
  },
  {
    slug: "dark-mode",
    title: "Add a dark mode",
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
    collisions: [
      { with: "search", kind: "region", why: "Both change renderHeader in src/render.js and the HEADER styles in src/styles.js." },
    ],
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
    collisions: [
      { with: "currency", kind: "interface", why: "Renders the filtered list with renderItem and formatPrice, whose signature currency changes; both edit renderPage." },
      { with: "dark-mode", kind: "region", why: "Both put new controls into the header: renderHeader and the HEADER styles." },
    ],
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
    collisions: [
      { with: "currency", kind: "interface", why: "Edits the price line of renderItem, which calls formatPrice; currency changes that call and the signature." },
    ],
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
    collisions: [],
  },
];

/** demo/intents.json: the seed intents with the full source of each check file. */
export async function buildIntents(dir = DEMO_DIR) {
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

/** demo/bundle.json: everything a Worker needs for the demo, in one importable file. */
export async function buildBundle(dir = DEMO_DIR, intents) {
  const demo = await loadDemo(dir, intents);
  const landed = land(demo, LANDING_ORDER);
  if (!landed.ok) throw new Error("The landing order does not compose: " + JSON.stringify(landed.log));
  return {
    schema: "bearing.demo/v1",
    name: "Saltmarsh Books",
    repo: demo.seed,
    intents,
    solutions: demo.solutions,
    landing: { order: LANDING_ORDER, adaptedAfter: "currency", tree: landed.tree },
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
    ["bundle.json", json(await buildBundle(DEMO_DIR, intents))],
  ];
  let stale = 0;
  for (const [name, content] of outputs) {
    const file = path.join(DEMO_DIR, name);
    if (check) {
      const current = await readFile(file, "utf8").catch(() => "");
      if (current !== content) {
        stale += 1;
        console.error(`demo/${name} is out of date. Run: node demo/build.mjs`);
      }
    } else {
      await writeFile(file, content);
      console.log(`wrote demo/${name} (${content.length} bytes)`);
    }
  }
  process.exitCode = stale > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(DEMO_DIR, "build.mjs")) await main();
