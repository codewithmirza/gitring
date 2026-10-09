---
intent: open-the-shop
title: Open the shop
status: landed
landed: a1f03c9
agent: seed
method: seed
---

# Open the shop

List the books on one page with the title, the author and the price. Serve the same list as JSON at `/api/products`.

## Checks

- `tests/products.test.js`: six books, integer cents, prices in pounds.
- `tests/render.test.js`: one card per book, escaped titles.
- `tests/index.test.js`: the shelf, the JSON list, 404 for an unknown path.
