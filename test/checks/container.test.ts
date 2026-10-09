/**
 * Check containers: the tar writer (checked with the system tar), the run script's markers, and the
 * Seawall host list.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gzip, modeFor, tar } from "../../src/platform/checks/tar";
import { packTree, parseRun, registryAllowed, runScript } from "../../src/drydock/drydock";

describe("tar writer", () => {
  it("writes a tree that GNU tar extracts byte for byte, long and non-ASCII paths included", async () => {
    const long = `src/${"deep/".repeat(30)}file.js`;
    const files = new Map<string, string>([
      ["package.json", '{ "name": "x", "scripts": { "test": "node --test" } }\n'],
      ["src/index.js", "export const a = 1;\n"],
      [long, "// long path\n"],
      ["docs/café ünïcode.md", "# héllo\n"],
      ["scripts/run.sh", "#!/bin/sh\necho ok\n"],
      ["empty.txt", ""],
    ]);
    const dir = mkdtempSync(join(tmpdir(), "gitring-tar-"));
    const file = join(dir, "tree.tgz");
    writeFileSync(file, await packTree(files));
    const out = join(dir, "out");
    execFileSync("mkdir", ["-p", out]);
    execFileSync("tar", ["-xzf", file, "-C", out]);
    for (const [path, content] of files) expect(readFileSync(join(out, path), "utf8")).toBe(content);
    expect(statSync(join(out, "scripts/run.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(out, "src/index.js")).mode & 0o777).toBe(0o644);
    const listed = execFileSync("tar", ["--quoting-style=literal", "-tzf", file], { encoding: "utf8" }).trim().split("\n").sort();
    expect(listed).toEqual([...files.keys()].sort());
  });

  it("drops paths that climb out of the tree", () => {
    const bytes = tar([
      { path: "../evil.js", content: "x" },
      { path: "a//b.js", content: "x" },
      { path: "ok.js", content: "y" },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "gitring-tar-"));
    writeFileSync(join(dir, "t.tar"), bytes);
    expect(execFileSync("tar", ["-tf", join(dir, "t.tar")], { encoding: "utf8" }).trim()).toBe("ok.js");
  });

  it("gzips with the platform CompressionStream", async () => {
    const z = await gzip(new TextEncoder().encode("hello hello hello"));
    expect([z[0], z[1]]).toEqual([0x1f, 0x8b]);
  });

  it("marks scripts executable", () => {
    expect(modeFor("bin/cli")).toBe(0o755);
    expect(modeFor("tools/build.sh")).toBe(0o755);
    expect(modeFor("src/bin.js")).toBe(0o644);
  });
});

describe("run script and result", () => {
  it("runs install then test, with markers, under bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitring-run-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: "node -e \"console.log('tests ran'); process.exit(0)\"" } }));
    // No lockfile and no dependencies: npm install is quick and offline.
    const script = runScript().replace("W=/workspace", `W=${dir}`).replaceAll("/cache", join(dir, ".cache"));
    let output = "";
    let code = 0;
    try {
      output = execFileSync("bash", ["-c", script], { cwd: dir, encoding: "utf8", env: { ...process.env, GITRING_INSTALL: "true", GITRING_TEST: "" } });
    } catch (e) {
      const err = e as { status: number; stdout: string };
      code = err.status;
      output = err.stdout;
    }
    const res = parseRun(output, code);
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.log).toContain("tests ran");
    expect(res.log).not.toContain("@@gitring");
  });

  it("tells install failures, missing tests and timeouts apart", () => {
    expect(parseRun("@@gitring stage=install\nnpm ERR! 404\n@@gitring install-failed=1\n", 91).stage).toBe("install");
    expect(parseRun("@@gitring no-test\n", 92).stage).toBe("no-test");
    expect(parseRun("…", 124).stage).toBe("timeout");
    const failed = parseRun("@@gitring reused=1\n@@gitring install-ms=5\n✗ adds numbers\n@@gitring test-ms=40\n", 1);
    expect(failed).toMatchObject({ ok: false, stage: "test", reused: true, installMs: 5, testMs: 40 });
    expect(failed.log).toContain("✗ adds numbers");
  });

  it("keeps only the end of a long log", () => {
    const res = parseRun("x".repeat(20_000), 1);
    expect(res.log.length).toBeLessThanOrEqual(8_001);
    expect(res.log.startsWith("…")).toBe(true);
  });
});

describe("Seawall", () => {
  it("lets package registries pass and refuses other hosts", () => {
    expect(registryAllowed("registry.npmjs.org")).toBe(true);
    expect(registryAllowed("REGISTRY.NPMJS.ORG.")).toBe(true);
    expect(registryAllowed("pypi.org")).toBe(true);
    expect(registryAllowed("evil.example")).toBe(false);
    expect(registryAllowed("registry.npmjs.org.evil.example")).toBe(false);
    expect(registryAllowed("api.github.com")).toBe(false);
  });
});
