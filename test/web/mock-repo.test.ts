/**
 * The mock harbor shows real code: attempt patches compose on main as the scenario says,
 * and every composed app passes the checks that the mock reports as passing.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyPatchFile, computeFootprint, parsePatch, unifiedDiff, type Tree } from "../../web/src/state/patchkit";
import { reduce } from "../../web/src/state/store";
import type { ProjectState } from "../../src/core/types";

const ROOT = join(__dirname, "../../web/src/state/mock-repo");

function walk(dir: string, rel = ""): [string, string][] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    return statSync(p).isDirectory() ? walk(p, r) : ([[r, readFileSync(p, "utf8")]] as [string, string][]);
  });
}

const base: Tree = new Map(walk(join(ROOT, "base")));
const patch = (k: string) => parsePatch(readFileSync(join(ROOT, "patches", `${k}.patch`), "utf8"));

function apply(tree: Tree, key: string) {
  const t = new Map(tree);
  const conflicts: string[] = [];
  for (const pf of patch(key)) if (!applyPatchFile(t, pf).ok) conflicts.push(pf.path);
  return { tree: t, conflicts };
}

let n = 0;
async function runChecks(tree: Tree): Promise<{ passed: number; failed: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), `bearing-mock-${n++}-`));
  for (const [p, c] of tree) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const h = await import(pathToFileURL(join(dir, "harness/test.js")).href);
  for (const f of [...tree.keys()].filter((p) => p.startsWith("tests/")).sort()) {
    h.__setFile(f);
    await import(pathToFileURL(join(dir, f)).href);
  }
  const results: { ok: boolean; name: string }[] = await h.__run();
  return { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.name) };
}

describe("mock repo patches", () => {
  const main1 = apply(base, "json-1");
  const main2 = apply(main1.tree, "currency-1");
  const main3 = apply(main2.tree, "picks-2");

  it("compose on main in the scenario order", () => {
    expect(main1.conflicts).toEqual([]);
    expect(main2.conflicts).toEqual([]);
    expect(main3.conflicts).toEqual([]);
  });

  it("stale the first staff-picks attempt on the new main (the re-derive story)", () => {
    expect(apply(main2.tree, "picks-1").conflicts).toEqual(["src/render.js"]);
  });

  it("let a human land either search and either dark mode, in any order", () => {
    for (const s of ["search-1", "search-2"])
      for (const d of ["dark-1", "dark-2"]) {
        expect(apply(apply(main3.tree, s).tree, d).conflicts).toEqual([]);
        expect(apply(apply(main3.tree, d).tree, s).conflicts).toEqual([]);
      }
  });

  it("pass every check the mock reports as passing", async () => {
    expect((await runChecks(main3.tree)).failed).toEqual([]);
    const full = apply(apply(main3.tree, "search-1").tree, "dark-1").tree;
    const r = await runChecks(full);
    expect(r.failed).toEqual([]);
    expect(r.passed).toBe(36);
  });

  it("computes real footprints and unified diffs", () => {
    const head = apply(base, "currency-1").tree;
    const fp = computeFootprint(base, head, ["src/products.js", "src/render.js"], 0);
    expect(fp.symbols.signatureChanged).toContain("src/products.js#formatPrice");
    expect(fp.files["src/render.js"].additions).toBe(4);
    expect(unifiedDiff("src/render.js", base.get("src/render.js")!, head.get("src/render.js")!)).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
  });
});

describe("store reducer", () => {
  const empty = {
    project: { id: "demo", name: "x", repo: { backend: "emulator", namespace: "n", name: "r", defaultBranch: "main" }, mainSha: "a", mainTree: "t", createdAt: 0, settings: {} },
    intents: [],
    attempts: [],
    agents: [],
    corrections: [],
    checks: [],
    landings: [],
    decisions: [],
    logs: [],
    radar: [],
    files: [],
    imports: [],
    stats: {},
  } as unknown as ProjectState;

  it("upserts by id and keeps unchanged slices", () => {
    const i = { id: "in-1", title: "A" } as ProjectState["intents"][number];
    const s1 = reduce(empty, { type: "intent", intent: i });
    const s2 = reduce(s1, { type: "intent", intent: { ...i, title: "B" } });
    expect(s2.intents).toHaveLength(1);
    expect(s2.intents[0].title).toBe("B");
    expect(s2.attempts).toBe(empty.attempts);
  });

  it("merges radar pairs regardless of order", () => {
    const s1 = reduce(empty, { type: "radar", pairs: [{ a: "x", b: "y", range: 3, closing: false, updatedAt: 1 }] });
    const s2 = reduce(s1, { type: "radar", pairs: [{ a: "y", b: "x", range: 2, closing: true, updatedAt: 2 }] });
    expect(s2.radar).toHaveLength(1);
    expect(s2.radar[0].range).toBe(2);
  });

  it("moves main", () => {
    const s = reduce(empty, { type: "main", sha: "b", tree: "t2", files: [{ path: "a.js", size: 1, lang: "javascript" }], imports: [] });
    expect(s.project.mainSha).toBe("b");
    expect(s.files).toHaveLength(1);
  });
});
