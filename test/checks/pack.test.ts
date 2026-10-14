/**
 * The tree for the test container keeps what git keeps: bytes, the executable bit and symlinks. Read back
 * with gitring's own tar reader, so this test needs no GNU tar.
 */
import { describe, expect, it } from "vitest";
import { packTree } from "../../src/drydock/drydock";
import { readTar, tar, type TarItem } from "../../src/platform/checks/tar";

async function items(gz: Uint8Array): Promise<Map<string, TarItem>> {
  const stream = new Blob([gz as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const out = new Map<string, TarItem>();
  for await (const item of readTar(stream)) out.set(item.path, item);
  return out;
}

describe("packTree", () => {
  it("keeps binary bytes, git modes and symlinks, and guesses the mode of plain text", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const long = `docs/${"deep/".repeat(30)}target.md`;
    const got = await items(
      await packTree(
        new Map<string, string | { content: string | Uint8Array; mode?: string }>([
          ["src/a.js", "export const a = 1;\n"],
          ["scripts/build.sh", "echo plain\n"],
          ["img/logo.png", { content: png, mode: "100644" }],
          ["tools/gen", { content: "#!/bin/sh\n", mode: "100755" }],
          ["link.js", { content: "src/a.js", mode: "120000" }],
          ["far", { content: long, mode: "120000" }],
        ]),
      ),
    );
    expect(got.get("img/logo.png")?.data).toEqual(png);
    expect(got.get("tools/gen")?.mode).toBe(0o755);
    expect(got.get("scripts/build.sh")?.mode).toBe(0o755);
    expect(got.get("src/a.js")?.mode).toBe(0o644);
    expect(got.get("link.js")).toMatchObject({ type: "symlink", linkname: "src/a.js" });
    // A target longer than 100 bytes goes in a PAX record.
    expect(got.get("far")).toMatchObject({ type: "symlink", linkname: long });
  });

  it("writes a symlink entry with no data", () => {
    const bytes = tar([{ path: "l", content: "ignored", link: "target" }]);
    // One header block for the link, then the two zero blocks at the end.
    expect(bytes.length).toBe(512 * 3);
    expect(String.fromCharCode(bytes[156])).toBe("2");
  });
});
