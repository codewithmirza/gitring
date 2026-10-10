/**
 * Private GitHub imports read one commit from its tarball: the top folder goes, modes and links stay,
 * limits hold.
 */
import { describe, expect, it } from "vitest";
import { githubSnapshot, SnapshotTooLarge } from "../../src/platform/github/tarball";
import { gzip, readTar, tar } from "../../src/platform/checks/tar";
import { author, backendOf, FakeGithub } from "./fake";

describe("readTar", () => {
  it("reads what the tar writer wrote, also long and non-ASCII paths (PAX)", async () => {
    const long = `${"deep/".repeat(30)}file.txt`;
    const bytes = tar([
      { path: "a.txt", content: "A" },
      { path: long, content: "L" },
      { path: "ü/naïve.md", content: "U" },
      { path: "bin/run", content: "#!/bin/sh\n", mode: 0o755 },
    ]);
    const out: Record<string, { text: string; mode: number }> = {};
    for await (const item of readTar(new Blob([bytes as unknown as ArrayBuffer]).stream())) {
      if (item.type === "file") out[item.path] = { text: new TextDecoder().decode(item.data), mode: item.mode };
    }
    expect(Object.keys(out).sort()).toEqual(["a.txt", "bin/run", long, "ü/naïve.md"].sort());
    expect(out[long].text).toBe("L");
    expect(out["bin/run"].mode & 0o111).toBeTruthy();
  });

  it("reads a gzip stream in small chunks", async () => {
    const gz = await gzip(tar([{ path: "x/y.txt", content: "y".repeat(5000) }]));
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= gz.length) return c.close();
        c.enqueue(gz.subarray(i, i + 7));
        i += 7;
      },
    }).pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    const items = [];
    for await (const item of readTar(stream)) items.push(item);
    expect(items).toHaveLength(1);
    expect(items[0].data?.length).toBe(5000);
  });
});

describe("githubSnapshot", () => {
  async function repo() {
    const b = backendOf();
    await b.ensureRepo("r");
    const c0 = await b.commit({
      repo: "r",
      branch: "main",
      parent: "",
      message: "x",
      author,
      changes: [
        { path: "README.md", content: "# R\n" },
        { path: "scripts/build.sh", content: "echo\n", mode: "100755" },
        { path: "src/a.js", content: "export const a = 1;\n" },
      ],
    });
    const gh = new FakeGithub("robin/private-r");
    await gh.adopt(b, "r", c0.sha);
    return { gh, sha: c0.sha };
  }

  it("strips the top folder and keeps the executable bit", async () => {
    const { gh, sha } = await repo();
    const snap = await githubSnapshot({ repo: gh.repo, sha, token: "t", fetch: gh.fetch as typeof fetch });
    const byPath = Object.fromEntries(snap.files.map((f) => [f.path, { text: new TextDecoder().decode(f.content as Uint8Array), mode: f.mode }]));
    expect(byPath).toEqual({
      "README.md": { text: "# R\n", mode: "100644" },
      "scripts/build.sh": { text: "echo\n", mode: "100755" },
      "src/a.js": { text: "export const a = 1;\n", mode: "100644" },
    });
  });

  it("stops at the size and file limits with a plain reason", async () => {
    const { gh, sha } = await repo();
    await expect(githubSnapshot({ repo: gh.repo, sha, token: "t", fetch: gh.fetch as typeof fetch, limits: { maxBytes: 10, maxFiles: 100 } })).rejects.toBeInstanceOf(SnapshotTooLarge);
    await expect(githubSnapshot({ repo: gh.repo, sha, token: "t", fetch: gh.fetch as typeof fetch, limits: { maxBytes: 1e6, maxFiles: 2 } })).rejects.toThrow(/more than 2 files/);
  });

  it("says why when GitHub refuses the download", async () => {
    const f = (async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as typeof fetch;
    await expect(githubSnapshot({ repo: "a/b", sha: "f".repeat(40), token: "t", fetch: f })).rejects.toThrow(/could not download a\/b/);
  });
});
