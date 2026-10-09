// Checks for the intent "Add a JSON endpoint for one book".
import { test, expect } from "../harness/test.js";
import { PRODUCTS } from "../src/products.js";
import worker from "../src/index.js";

async function get(path) {
  const res = await worker.fetch(new Request("http://shop.test" + path));
  const type = res.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, type, body };
}

test("GET /api/products/3 returns that book as JSON", async () => {
  const res = await get("/api/products/3");
  expect(res.status).toBe(200);
  expect(res.type).toContain("application/json");
  expect(res.body).toEqual(PRODUCTS.find((book) => book.id === 3));
});

test("every book has its own URL", async () => {
  for (const book of PRODUCTS) {
    const res = await get("/api/products/" + book.id);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe(book.title);
  }
});

test("an unknown id returns 404 with a JSON error", async () => {
  const res = await get("/api/products/999");
  expect(res.status).toBe(404);
  expect(res.type).toContain("application/json");
  expect(typeof res.body.error).toBe("string");
});

test("an id that is not a number returns 404 with a JSON error", async () => {
  const res = await get("/api/products/tidewater");
  expect(res.status).toBe(404);
  expect(typeof res.body.error).toBe("string");
});

test("the list endpoint still returns every book", async () => {
  const res = await get("/api/products");
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(PRODUCTS.length);
});
