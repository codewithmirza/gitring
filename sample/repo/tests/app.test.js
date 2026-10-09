// Baseline tests for the shop. Every intent must keep these green.
import { test, expect } from "../harness/test.js";
import worker from "../src/index.js";
import { PRODUCTS, formatPrice } from "../src/products.js";

function get(path) {
  return worker.fetch(new Request("http://shop.test" + path));
}

test("the home page renders the shop name", async () => {
  const res = await get("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("Saltmarsh Books");
});

test("the home page lists every title", async () => {
  const html = await (await get("/")).text();
  for (const book of PRODUCTS) expect(html).toContain(book.title);
});

test("links and forms on the page are relative", async () => {
  const html = await (await get("/")).text();
  expect(html).not.toMatch(/(href|action|src)="\//);
});

test("/api/products returns all 8 books as JSON", async () => {
  const res = await get("/api/products");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const books = await res.json();
  expect(books.length).toBe(8);
  expect(books.map((b) => b.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("formatPrice shows dollars and cents", () => {
  expect(formatPrice(1999)).toBe("$19.99");
  expect(formatPrice(999)).toBe("$9.99");
});

test("unknown paths return 404", async () => {
  const res = await get("/no-such-page");
  expect(res.status).toBe(404);
});
