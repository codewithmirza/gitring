# Saltmarsh Books

A small bookshop on Cloudflare Workers. Plain ES modules, no build step, no dependencies.

## Files

| Path | What it does |
|---|---|
| `src/index.js` | The fetch handler: `/`, `/about`, `/api/products` |
| `src/render.js` | Page layout as template strings |
| `src/products.js` | The books and `formatPrice(cents)` |
| `src/styles.js` | One stylesheet |
| `harness/test.js` | A very small test API |
| `tests/*.test.js` | Checks. Bearing runs them for every attempt. |

## Run the checks

Bearing runs the checks in an isolate when an agent submits an attempt. To run them by hand, import `harness/test.js`, import each test file, then call `__run()`.

## Work on this repo

Read `AGENTS.md` first. Every agent declares a course with Bearing before it writes code.
