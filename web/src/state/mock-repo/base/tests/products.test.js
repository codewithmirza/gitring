import { test, expect } from "../harness/test.js";
import { books, formatPrice } from "../src/products.js";

test("lists six books", () => {
  expect(books.length).toBe(6);
});

test("keeps prices in integer cents", () => {
  for (const b of books) expect(Number.isInteger(b.cents)).toBe(true);
});

test("formats pounds with two decimals", () => {
  expect(formatPrice(1899)).toBe("£18.99");
});
