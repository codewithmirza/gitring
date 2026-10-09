// Checks for the intent "Add a dark mode".
import { test, expect } from "../harness/test.js";
import { CSS } from "../src/styles.js";
import worker from "../src/index.js";

async function home() {
  const res = await worker.fetch(new Request("http://shop.test/"));
  return res.text();
}

function headerOf(html) {
  const match = html.match(/<header[\s\S]*?<\/header>/);
  return match ? match[0] : "";
}

function toggleOf(html) {
  const match = headerOf(html).match(/<button[^>]*theme-toggle[^>]*>/);
  return match ? match[0] : "";
}

function darkBlock() {
  const match = CSS.match(/\[data-theme=["']?dark["']?\][^{]*\{([^}]*)\}/);
  return match ? match[1] : "";
}

test("the header has a theme toggle button", async () => {
  expect(toggleOf(await home())).toMatch(/class="[^"]*\btheme-toggle\b/);
});

test("the toggle reports its state with aria-pressed", async () => {
  expect(toggleOf(await home())).toMatch(/aria-pressed="(true|false)"/);
});

test("an inline script switches data-theme and aria-pressed", async () => {
  const scripts = (await home()).match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
  const code = scripts.join("\n");
  expect(code).toMatch(/data-theme|dataset\.theme/);
  expect(code).toContain("aria-pressed");
});

test("the styles set dark colour tokens under [data-theme=\"dark\"]", () => {
  expect(darkBlock()).toMatch(/--bg\s*:/);
  expect(darkBlock()).toMatch(/--ink\s*:/);
});

test("the styles follow prefers-color-scheme: dark", () => {
  expect(CSS).toMatch(/prefers-color-scheme:\s*dark/);
});

test("colours still come from CSS custom properties", () => {
  expect(CSS).toMatch(/background:\s*var\(--bg\)/);
  expect(CSS).toMatch(/color:\s*var\(--ink\)/);
});
