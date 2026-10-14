/**
 * The code check of gitring_ack (src/harbor/ack-check.ts): an agent says "done", and gitring reads the code of
 * the work copy against the lines and the signatures of the change request.
 */
import { describe, expect, it } from "vitest";
import { callArgCounts, checkAck, keepsValid, paramsOf, takes, type AckWork } from "../../src/harbor/ack-check";
import type { Correction, Footprint, LineRange } from "../../src/core/types";
import { steViolations } from "../coord/ste";

const PRICE = "src/price.js#formatPrice";

function work(opts: { hunks?: Record<string, LineRange[]>; files?: Record<string, string>; signatures?: AckWork["signatures"]; symbols?: Partial<Footprint["symbols"]> } = {}): AckWork {
  const footprint: Footprint = {
    files: Object.fromEntries(Object.entries(opts.hunks ?? {}).map(([path, hunks]) => [path, { status: "M" as const, hunks, additions: 1, deletions: hunks.length }])),
    symbols: { defined: [], modified: [], removed: [], signatureChanged: [], referenced: [], ...opts.symbols },
    computedAt: 0,
  };
  return { footprint, files: new Map(Object.entries(opts.files ?? {})), signatures: opts.signatures ?? {} };
}

const request = (constraints: Correction["constraints"]): Pick<Correction, "constraints"> => ({ constraints });
const regions = request({ avoidRegions: [{ path: "src/price.js", lines: [10, 14] }] });
const signature = request({ useSignatures: [{ symbol: PRICE, signature: "formatPrice(cents, currency)" }] });

describe("the lines of a change request", () => {
  it("fails while the code still replaces lines of the region, and names the lines", () => {
    const res = checkAck(regions, work({ hunks: { "src/price.js": [[12, 20]] } }));
    expect(res).toEqual({ applied: false, reason: "Your code still edits lines 12–14 of src/price.js." });
    expect(steViolations(res.reason)).toEqual([]);
  });

  it("passes when the code keeps out of the region", () => {
    const res = checkAck(regions, work({ hunks: { "src/price.js": [[1, 3], [20, 22]], "src/cart.js": [[10, 14]] } }));
    expect(res).toEqual({ applied: true, reason: "Your code keeps the lines of the change request." });
    expect(steViolations(res.reason)).toEqual([]);
  });

  it("does not count the lines when the work that holds them left the traffic", () => {
    const res = checkAck(regions, work({ hunks: { "src/price.js": [[12, 20]] } }), { regions: false });
    expect(res.applied).toBeNull();
  });
});

describe("the signatures of a change request", () => {
  it("fails when the code changes the function, and calls of the asked form do not work", () => {
    const res = checkAck(signature, work({ signatures: { [PRICE]: { before: "formatPrice(cents)", after: "formatPrice(value)" } } }));
    expect(res).toEqual({ applied: false, reason: "Your code changes formatPrice in src/price.js to formatPrice(value). Calls of the form formatPrice(cents, currency) must still work." });
    expect(steViolations(res.reason)).toEqual([]);
  });

  it("passes when the changed function still takes calls of the asked form", () => {
    const res = checkAck(signature, work({ signatures: { [PRICE]: { before: "formatPrice(cents)", after: "formatPrice(cents, currency, locale = 'en')" } } }));
    expect(res).toEqual({ applied: true, reason: "Your code keeps the signatures of the change request." });
  });

  it("fails when the code removes the function", () => {
    const res = checkAck(signature, work({ signatures: { [PRICE]: { before: "formatPrice(cents)" } } }));
    expect(res).toEqual({ applied: false, reason: "Your code removes formatPrice from src/price.js." });
  });

  it("fails when the changed code still calls the old form, and names the file", () => {
    const cart = "import { formatPrice } from './price.js';\nexport const total = (c) => formatPrice(c);\n";
    const res = checkAck(signature, work({ hunks: { "src/cart.js": [[2, 2]] }, files: { "src/cart.js": cart }, symbols: { referenced: [PRICE], referencedIn: { [PRICE]: ["src/cart.js"] } } }));
    expect(res).toEqual({ applied: false, reason: "Your code in src/cart.js still calls formatPrice with 1 argument. Call formatPrice(cents, currency)." });
    expect(steViolations(res.reason)).toEqual([]);
  });

  it("passes when the changed code calls the new form", () => {
    const cart = "import { formatPrice } from './price.js';\nexport const total = (c, cur) => formatPrice(c, cur);\n";
    const res = checkAck(signature, work({ hunks: { "src/cart.js": [[2, 2]] }, files: { "src/cart.js": cart }, symbols: { referenced: [PRICE], referencedIn: { [PRICE]: ["src/cart.js"] } } }));
    expect(res.applied).toBe(true);
  });

  it("has nothing to check when the code neither changes nor calls the function", () => {
    const res = checkAck(signature, work({ hunks: { "src/other.js": [[1, 1]] }, files: { "src/other.js": "export const x = 1;\n" } }));
    expect(res).toEqual({ applied: null, reason: "The change request has no lines or signatures that gitring can check." });
    expect(steViolations(res.reason)).toEqual([]);
  });
});

it("checks the lines and the signatures together, and gives the first two problems", () => {
  const both = request({ avoidRegions: [{ path: "src/price.js", lines: [10, 14] }], useSignatures: [{ symbol: PRICE, signature: "formatPrice(cents, currency)" }] });
  expect(checkAck(both, work({ hunks: { "src/price.js": [[30, 31]] }, signatures: { [PRICE]: { before: "formatPrice(cents)", after: "formatPrice(cents, currency)" } } }))).toEqual({
    applied: true,
    reason: "Your code keeps the lines and the signatures of the change request.",
  });
  const res = checkAck(both, work({ hunks: { "src/price.js": [[10, 10]] }, signatures: { [PRICE]: { before: "formatPrice(cents)" } } }));
  expect(res).toEqual({ applied: false, reason: "Your code still edits line 10 of src/price.js. Your code removes formatPrice from src/price.js." });
});

it("has nothing to check in a change request with notes only", () => {
  expect(checkAck(request({ notes: ["Talk to the other agent."] }), work()).applied).toBeNull();
});

describe("parameter lists and calls", () => {
  it("reads optional, rest and typed parameters", () => {
    expect(paramsOf("f(a: Map<string, number>, b?: number, c = [1, 2], ...d)")).toEqual([
      { rest: false, optional: false },
      { rest: false, optional: true },
      { rest: false, optional: true },
      { rest: true, optional: false },
    ]);
    expect(paramsOf("f")).toBeUndefined();
  });

  it("counts the arguments a function takes", () => {
    expect(takes("f(a, b = 1)", 1)).toBe(true);
    expect(takes("f(a, b = 1)", 2)).toBe(true);
    expect(takes("f(a, b = 1)", 3)).toBe(false);
    expect(takes("f(a, b = 1)", 0)).toBe(false);
    expect(takes("f(a, ...rest)", 9)).toBe(true);
  });

  it("keeps calls of the asked form valid, or not", () => {
    expect(keepsValid("f(a, b, c = 0)", "f(a, b)")).toBe(true);
    expect(keepsValid("f(a, ...rest)", "f(a, b, c)")).toBe(true);
    expect(keepsValid("f(a)", "f(a, b)")).toBe(false);
    expect(keepsValid("f(a, b, c)", "f(a, b)")).toBe(false);
    expect(keepsValid("f(a, b)", "f(a, b = 1)")).toBe(false);
    expect(keepsValid("g(a, b)", "f(a, b)")).toBe(false);
  });

  it("counts the arguments of calls, not of definitions, comments or spread calls", () => {
    const src = [
      "function formatPrice(cents, currency) { return cents; }",
      "// formatPrice(1, 2, 3)",
      "/* formatPrice(1, 2, 3, 4) */",
      "const a = formatPrice(1, 'EUR');",
      "const b = formatPrice(fn(1, 2), [3, 4]);",
      "const c = formatPrice(...args);",
      "const d = obj.formatPrice(5);",
      "const e = myformatPrice(6, 7, 8);",
      "class X { formatPrice(a) { return a; } }",
    ].join("\n");
    expect(callArgCounts(src, "formatPrice")).toEqual([2, 2, 1]);
  });
});
