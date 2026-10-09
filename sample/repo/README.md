# Saltmarsh Books

A small bookshop on Cloudflare Workers. Plain ES modules, no dependencies, no build step.

| File | Role |
|---|---|
| `src/index.js` | Fetch handler. `/` is the shop page. `/api/products` is the list of books as JSON. |
| `src/products.js` | The books (`PRODUCTS`) and `formatPrice(cents)`. |
| `src/render.js` | The HTML page: header, book list, footer. |
| `src/styles.js` | The CSS. One const for each region of the page. |
| `harness/test.js` | A tiny test API. It runs in Node and in workerd. |
| `tests/*.test.js` | The tests. `tests/run.mjs` runs them in Node. |

## Run the tests

```sh
node tests/run.mjs                      # every tests/*.test.js file
node tests/run.mjs tests/app.test.js    # one file
```

## Run the shop

```sh
npx wrangler dev
```

Links and forms are relative (`href="api/products"`, `action="./"`). The shop also works under a path prefix, for example in a gitring preview.

Agents: read [AGENTS.md](AGENTS.md) before you change the code.
