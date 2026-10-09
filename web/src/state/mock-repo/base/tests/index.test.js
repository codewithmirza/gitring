import { test, expect } from "../harness/test.js";
import worker from "../src/index.js";

test("serves the shelf", async () => {
  const res = await worker.fetch(new Request("https://shop.test/"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Saltmarsh Books");
});

test("serves every book as JSON", async () => {
  const res = await worker.fetch(new Request("https://shop.test/api/products"));
  expect((await res.json()).length).toBe(6);
});

test("returns 404 for an unknown path", async () => {
  const res = await worker.fetch(new Request("https://shop.test/nowhere"));
  expect(res.status).toBe(404);
});
