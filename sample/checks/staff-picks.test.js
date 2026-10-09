// Checks for the intent "Mark staff picks".
import { test, expect } from "../harness/test.js";
import { PRODUCTS } from "../src/products.js";
import worker from "../src/index.js";

const PICKS = [1, 6, 8];

async function items() {
  const res = await worker.fetch(new Request("http://shop.test/"));
  const html = await res.text();
  return html.match(/<li\b[^>]*class="[^"]*\bbook\b[^"]*"[^>]*>[\s\S]*?<\/li>/g) || [];
}

function itemFor(list, id) {
  const book = PRODUCTS.find((b) => b.id === id);
  return list.find((item) => item.includes(book.title)) || "";
}

function priceLine(item) {
  const match = item.match(/<p\b[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>[\s\S]*?<\/p>/);
  return match ? match[0] : "";
}

test("exactly three books are staff picks: ids 1, 6 and 8", () => {
  expect(PRODUCTS.filter((book) => book.staffPick).map((book) => book.id)).toEqual(PICKS);
});

test("every book has a staffPick boolean", () => {
  for (const book of PRODUCTS) expect(typeof book.staffPick).toBe("boolean");
});

test("each staff pick shows a Staff pick badge in its price line", async () => {
  const list = await items();
  for (const id of PICKS) {
    expect(priceLine(itemFor(list, id))).toMatch(/<span\b[^>]*class="[^"]*\bbadge\b[^"]*"[^>]*>\s*Staff pick\s*<\/span>/);
  }
});

test("other books show no badge", async () => {
  const list = await items();
  for (const book of PRODUCTS.filter((b) => !PICKS.includes(b.id))) {
    expect(itemFor(list, book.id)).not.toContain("Staff pick");
  }
});

test("the price stays in the price line", async () => {
  const list = await items();
  expect(priceLine(itemFor(list, 1))).toContain("$19.99");
});
