/**
 * What a merge carries of a work copy (core/land/carry): every change, except a few parts that stay out
 * and that gitring names to the agent.
 */
import { describe, expect, it } from "vitest";
import { MAX_NEW_FOLDER_FILES, notCarriedText, planCarry, withoutChanges } from "../../src/core/land/carry";
import type { Snapshot } from "../../src/core/git/snapshot";
import { opaqueFolder } from "../../src/core/repo-rules";
import { steViolations } from "../coord/ste";

const sha = (n: number) => n.toString(16).padStart(40, "0");

function tree(entries: Record<string, number | [number, string]>): Snapshot {
  return new Map(Object.entries(entries).map(([path, v]) => [path, Array.isArray(v) ? { sha: sha(v[0]), mode: v[1] } : { sha: sha(v), mode: "100644" }]));
}

describe("opaqueFolder", () => {
  it("names the folder and tells tool output from vendored or built files", () => {
    expect(opaqueFolder("src/a.js")).toBeNull();
    expect(opaqueFolder("node_modules/x/index.js")).toEqual({ folder: "node_modules/", generated: true });
    expect(opaqueFolder("packages/web/node_modules/x.js")).toEqual({ folder: "packages/web/node_modules/", generated: true });
    expect(opaqueFolder("dist/app.js")).toEqual({ folder: "dist/", generated: false });
    expect(opaqueFolder("vendor/lib/a.go")).toEqual({ folder: "vendor/", generated: false });
  });
});

describe("planCarry", () => {
  const base = tree({ "src/a.js": 1, "vendor/lib.go": 2, "bin/run": 3 });

  it("carries binary files, modes, symlinks, and changes in a folder that main has", () => {
    const work = tree({ "src/a.js": 10, "vendor/lib.go": 11, "vendor/new.go": 12, "bin/run": [3, "100755"], "img/logo.png": 13, "link": [14, "120000"] });
    const plan = planCarry(base, work);
    expect(plan.notCarried).toEqual([]);
    expect(plan.work).toBe(work);
  });

  it("leaves out a new folder of tool output, whatever its size", () => {
    const work = new Map(base);
    work.set("node_modules/left-pad/index.js", { sha: sha(20), mode: "100644" });
    work.set("src/b.js", { sha: sha(21), mode: "100644" });
    const plan = planCarry(base, work);
    expect(plan.notCarried).toEqual([{ path: "node_modules/", why: "generated", files: 1 }]);
    expect(plan.work.has("node_modules/left-pad/index.js")).toBe(false);
    expect(plan.work.get("src/b.js")).toEqual({ sha: sha(21), mode: "100644" });
  });

  it("carries a small new built folder, and leaves out one with too many files", () => {
    const small = new Map(base);
    small.set("dist/app.js", { sha: sha(30), mode: "100644" });
    expect(planCarry(base, small).notCarried).toEqual([]);

    const big = new Map(base);
    for (let i = 0; i <= MAX_NEW_FOLDER_FILES; i++) big.set(`build/f${i}.js`, { sha: sha(1000 + i), mode: "100644" });
    const plan = planCarry(base, big);
    expect(plan.notCarried).toEqual([{ path: "build/", why: "many", files: MAX_NEW_FOLDER_FILES + 1 }]);
    expect([...plan.work.keys()].some((p) => p.startsWith("build/"))).toBe(false);
  });

  it("carries a folder of tool output that main already has", () => {
    const tracked = tree({ "node_modules/a.js": 1 });
    const work = tree({ "node_modules/a.js": 2, "node_modules/b.js": 3 });
    expect(planCarry(tracked, work).notCarried).toEqual([]);
  });

  it("always carries a path that the agent wrote one by one", () => {
    const work = new Map(base);
    work.set("node_modules/patch.js", { sha: sha(40), mode: "100644" });
    expect(planCarry(base, work, new Set(["node_modules/patch.js"])).notCarried).toEqual([]);
  });

  it("leaves out a submodule entry, and keeps the base entry in its place", () => {
    const withLink = tree({ "src/a.js": 1, ext: [50, "160000"] });
    const work = tree({ "src/a.js": 1, ext: [51, "160000"], "lib/x": [52, "160000"] });
    const plan = planCarry(withLink, work);
    expect(plan.notCarried).toEqual([
      { path: "ext", why: "submodule" },
      { path: "lib/x", why: "submodule" },
    ]);
    expect(plan.work.get("ext")).toEqual({ sha: sha(50), mode: "160000" });
    expect(plan.work.has("lib/x")).toBe(false);
  });

  it("withoutChanges puts back the base entry, or removes a path that the base does not have", () => {
    const work = tree({ "src/a.js": 9, "src/new.js": 8 });
    const out = withoutChanges(base, work, ["src/a.js", "src/new.js"]);
    expect(out.get("src/a.js")).toEqual(base.get("src/a.js"));
    expect(out.has("src/new.js")).toBe(false);
    expect(work.get("src/a.js")?.sha).toBe(sha(9)); // the input does not change
  });
});

describe("notCarriedText", () => {
  it("names each part in short sentences, and says what the agent can do", () => {
    const text = notCarriedText([
      { path: "node_modules/", why: "generated", files: 3412 },
      { path: "build/", why: "many", files: 250 },
      { path: "assets/movie.mp4", why: "large", bytes: 41_200_000 },
      { path: "ext", why: "submodule" },
    ]);
    expect(text).toContain("gitring does not merge node_modules/ (3412 files).");
    expect(text).toContain("gitring does not merge assets/movie.mp4 (41.2 MB).");
    expect(text).toContain("gitring does not merge the submodule ext.");
    expect(text.endsWith("Remove these paths from your work if you do not need them.")).toBe(true);
    expect(steViolations(text)).toEqual([]);
    expect(notCarriedText([])).toBe("");
    expect(notCarriedText([{ path: "ext", why: "submodule" }], false)).toBe("gitring does not merge the submodule ext.");
  });
});
