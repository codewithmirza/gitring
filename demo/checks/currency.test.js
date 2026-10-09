// Checks for the intent "Show prices in the reader's currency".
import { test, expect } from "../harness/test.js";
import * as products from "../src/products.js";
import worker from "../src/index.js";

async function home(query = "") {
  const res = await worker.fetch(new Request("http://shop.test/" + query));
  return res.text();
}

test("formatPrice keeps US dollars as the default", () => {
  expect(products.formatPrice(1999)).toBe("$19.99");
  expect(products.formatPrice(1999, "USD")).toBe("$19.99");
});

test("formatPrice converts to euros at 0.92, to the cent", () => {
  expect(products.formatPrice(1999, "EUR")).toBe("€18.39");
  expect(products.formatPrice(1450, "EUR")).toBe("€13.34");
  expect(products.formatPrice(999, "EUR")).toBe("€9.19");
});

test("formatPrice converts to rupees at 83, in whole rupees with a comma for thousands", () => {
  expect(products.formatPrice(1999, "INR")).toBe("₹1,659");
  expect(products.formatPrice(2400, "INR")).toBe("₹1,992");
  expect(products.formatPrice(999, "INR")).toBe("₹829");
});

test("formatPrice falls back to US dollars for an unknown currency", () => {
  expect(products.formatPrice(1999, "XYZ")).toBe("$19.99");
});

test("?currency=EUR shows every price in euros", async () => {
  const html = await home("?currency=EUR");
  expect(html).toContain("€18.39");
  expect(html).toContain("€9.19");
  expect(html).not.toMatch(/\$\d/);
});

test("?currency=INR shows every price in rupees", async () => {
  const html = await home("?currency=INR");
  expect(html).toContain("₹1,659");
  expect(html).not.toMatch(/\$\d/);
});

test("the page shows US dollars when there is no ?currency", async () => {
  expect(await home()).toContain("$19.99");
});

test("the page has links to switch the currency", async () => {
  const html = await home();
  expect(html).toMatch(/href="[^"]*currency=EUR/);
  expect(html).toMatch(/href="[^"]*currency=INR/);
});
