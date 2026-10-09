import { test, expect } from "../harness/test.js";
import { renderPage } from "../src/render.js";
import { books } from "../src/products.js";

test("renders one card per book", () => {
  const html = renderPage(books);
  expect(html.split('class="book"').length - 1).toBe(books.length);
});

test("escapes titles", () => {
  const html = renderPage([{ id: "x", title: "<b>", author: "A", cents: 100 }]);
  expect(html).toContain("&lt;b&gt;");
});
