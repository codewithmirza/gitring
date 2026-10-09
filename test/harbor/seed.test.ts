/** Folder uploads: clean paths, bytes from base64, limits. */
import { describe, expect, it } from "vitest";
import { seedChanges } from "../../src/harbor/harbor";

describe("seedChanges", () => {
  it("keeps text and bytes, drops unsafe paths and .git", () => {
    const out = seedChanges([
      { path: "src/a.js", text: "export const a = 1;\n" },
      { path: "img/logo.png", base64: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47)) },
      { path: "bin/run", text: "#!/bin/sh\n", executable: true },
      { path: "../escape.js", text: "x" },
      { path: ".git/config", text: "x" },
      { path: "a//b.js", text: "x" },
      { path: "\\windows\\style.txt", text: "w" },
      { path: "nothing.txt" },
    ]);
    expect(out.map((c) => c.path).sort()).toEqual(["bin/run", "img/logo.png", "src/a.js", "windows/style.txt"]);
    const png = out.find((c) => c.path === "img/logo.png")!;
    expect(png.content).toBeInstanceOf(Uint8Array);
    expect([...(png.content as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(out.find((c) => c.path === "bin/run")!.mode).toBe("100755");
  });

  it("refuses folders over 20 MB", () => {
    const big = "x".repeat(1_000_000);
    const files = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.txt`, text: big }));
    expect(() => seedChanges(files)).toThrow(/larger than 20 MB/);
  });
});
