// Checks for the intent "Search books by title or author".
import { test, expect } from "../harness/test.js";
import * as products from "../src/products.js";
import worker from "../src/index.js";

function find(query) {
  if (typeof products.findProducts !== "function") throw new Error("src/products.js must export findProducts(query)");
  return products.findProducts(query);
}

function ids(books) {
  return books.map((book) => book.id);
}

async function home(query = "") {
  const res = await worker.fetch(new Request("http://shop.test/" + query));
  return res.text();
}

function headerOf(html) {
  const match = html.match(/<header[\s\S]*?<\/header>/);
  return match ? match[0] : "";
}

test("findProducts matches titles, in any case", () => {
  expect(ids(find("TIDEWATER"))).toEqual([1]);
  expect(ids(find("tide"))).toEqual([1, 8]);
});

test("findProducts matches authors", () => {
  expect(ids(find("quill"))).toEqual([1]);
  expect(ids(find("Moss"))).toEqual([8]);
});

test("findProducts trims the query", () => {
  expect(ids(find("  marram  "))).toEqual([6]);
});

test("an empty or missing query returns every book", () => {
  expect(find("").length).toBe(products.PRODUCTS.length);
  expect(find(undefined).length).toBe(products.PRODUCTS.length);
});

test("the header has a search form with a q field", async () => {
  const header = headerOf(await home());
  expect(header).toMatch(/<form\b[^>]*role="search"/);
  expect(header).toMatch(/<input\b[^>]*name="q"/);
});

test("?q= filters the list and keeps the prices", async () => {
  const html = await home("?q=tide");
  expect(html).toContain("The Tidewater Almanac");
  expect(html).toContain("A Small Book of Tides");
  expect(html).not.toContain("Knots for Small Boats");
  expect(html).toContain("$19.99");
  expect(html).toContain("$9.99");
});

test("the search box keeps the query", async () => {
  expect(await home("?q=marram")).toMatch(/<input\b[^>]*value="marram"/);
});

test("a search with no match says so", async () => {
  const html = await home("?q=zzzz");
  expect(html).toContain("No books match your search.");
  for (const book of products.PRODUCTS) expect(html).not.toContain(book.title);
});

test("the page escapes the query", async () => {
  const html = await home("?q=" + encodeURIComponent('<script>"x"'));
  expect(html).not.toContain('<script>"x"');
});
