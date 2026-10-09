import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/types";

describe("smoke", () => {
  it("loads core types", () => {
    expect(DEFAULT_SETTINGS.fanout).toBe(1);
    expect(typeof globalThis.crypto.subtle.digest).toBe("function");
  });
});
