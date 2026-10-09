/**
 * Cross-site write guard for browser sessions. Pages with a strict referrer policy make the browser
 * send `Origin: null` on their own posts; Fetch Metadata tells those apart from cross-site posts.
 */
import { describe, expect, it } from "vitest";
import { isCrossSiteWrite } from "../../src/worker/csrf";

const OWN = "https://gitring.example.workers.dev";

describe("isCrossSiteWrite", () => {
  it("lets reads pass", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(isCrossSiteWrite(m, "https://evil.example", "cross-site", OWN)).toBe(false);
  });

  it("lets the app's own fetches and form posts pass", () => {
    expect(isCrossSiteWrite("POST", OWN, "same-origin", OWN)).toBe(false);
    // the setup page form: Origin is "null" (referrer policy), Fetch Metadata says same-origin
    expect(isCrossSiteWrite("POST", "null", "same-origin", OWN)).toBe(false);
    // older browser without Fetch Metadata, real Origin
    expect(isCrossSiteWrite("POST", OWN, undefined, OWN)).toBe(false);
    // non-browser client with a session cookie
    expect(isCrossSiteWrite("DELETE", undefined, undefined, OWN)).toBe(false);
  });

  it("refuses posts from other sites", () => {
    expect(isCrossSiteWrite("POST", "https://evil.example", "cross-site", OWN)).toBe(true);
    expect(isCrossSiteWrite("POST", "null", "cross-site", OWN)).toBe(true); // sandboxed frame or no-referrer attacker page
    expect(isCrossSiteWrite("POST", undefined, "same-site", OWN)).toBe(true);
    expect(isCrossSiteWrite("PUT", "https://evil.example", undefined, OWN)).toBe(true);
    expect(isCrossSiteWrite("POST", "null", undefined, OWN)).toBe(true);
    // a real foreign Origin wins even if a header says same-origin
    expect(isCrossSiteWrite("POST", "https://evil.example", "same-origin", OWN)).toBe(true);
  });
});
