/**
 * The text of the shop story: the files that the scripted agents of scripts/meet.mjs write, as strings.
 * Called by scripts/meet-steps.mjs. The starting files are the files of examples/shop.
 * Never change a text without a run of the story. test/load/meet-run.test.ts reads the report of the story.
 */
import { readFileSync } from "node:fs";

const SHOP = new URL("../examples/shop/", import.meta.url);
export const read = (path) => readFileSync(new URL(path, SHOP), "utf8");
const lines = (...l) => `${l.join("\n")}\n`;

export const PRICE_TEST = () => read("tests/price.test.js");
const COMMAS_LINE = '  return "$" + dollars.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");';
export const COMMAS = lines("export function formatPrice(cents) {", "  const dollars = (cents / 100).toFixed(2);", COMMAS_LINE, "}");
export const FREE = lines("export function formatPrice(cents) {", '  if (cents === 0) return "Free";', '  return "$" + (cents / 100).toFixed(2);', "}");
export const BOTH = lines("export function formatPrice(cents) {", '  if (cents === 0) return "Free";', "  const dollars = (cents / 100).toFixed(2);", COMMAS_LINE, "}");
export const EUROS = lines(
  'const SIGNS = { USD: "$", EUR: "€" };',
  "",
  'export function formatPrice(cents, currency = "USD") {',
  '  if (cents === 0) return "Free";',
  "  const dollars = (cents / 100).toFixed(2);",
  `  return SIGNS[currency] + dollars.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");`,
  "}",
);
export const CART_EUROS = lines(
  'import { formatPrice } from "./price.js";',
  "",
  'export function cartTotal(items, currency = "USD") {',
  "  return formatPrice(items.reduce((sum, item) => sum + item.cents, 0), currency);",
  "}",
);
export const T_COMMAS = 'test("adds commas", () => expect(formatPrice(123456)).toBe("$1,234.56"));\n';
export const T_FREE = 'test("shows Free", () => expect(formatPrice(0)).toBe("Free"));\n';
export const T_EUROS = 'test("shows euros", () => expect(formatPrice(1999, "EUR")).toBe("€19.99"));\n';
