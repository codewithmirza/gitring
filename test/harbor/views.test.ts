/**
 * The work of a work copy as the harbor sees it (src/harbor/views.ts): text changes, changes without text,
 * and the contribution that a person says yes to.
 */
import { describe, expect, it } from "vitest";
import { changedVersions, contributionRows, opaqueChanges, overlaySnapshot } from "../../src/harbor/views";
import { hashObject, utf8 } from "../../src/core/git/objects";
import type { Snapshot } from "../../src/core/git/snapshot";
import { merge3 } from "../../src/core/text/merge3";

const blob = (text: string) => hashObject("blob", utf8.encode(text));

describe("changedVersions with the real trees", () => {
  it("does not take a file that lost its text (binary now, or too large) as a delete", async () => {
    const base: Snapshot = new Map([
      ["src/a.js", { sha: await blob("a\n"), mode: "100644" }],
      ["big.txt", { sha: await blob("small\n"), mode: "100644" }],
      ["gone.js", { sha: await blob("x\n"), mode: "100644" }],
    ]);
    // The head: big.txt has no text now (more than 1 MB), gone.js is deleted, src/a.js changed.
    const head: Snapshot = new Map([
      ["src/a.js", { sha: await blob("a2\n"), mode: "100644" }],
      ["big.txt", { sha: "f".repeat(40), mode: "100644" }],
    ]);
    const baseText = new Map([["src/a.js", "a\n"], ["big.txt", "small\n"], ["gone.js", "x\n"]]);
    const headText = new Map([["src/a.js", "a2\n"]]);
    const paths = ["src/a.js", "big.txt", "gone.js"];
    // Without the trees (the old reading): big.txt looks deleted.
    expect(changedVersions(baseText, headText, paths).map((c) => [c.path, c.head])).toEqual([
      ["big.txt", null],
      ["gone.js", null],
      ["src/a.js", "a2\n"],
    ]);
    const changed = changedVersions(baseText, headText, paths, { base, head });
    expect(changed.map((c) => [c.path, c.head])).toEqual([
      ["gone.js", null],
      ["src/a.js", "a2\n"],
    ]);
    expect(opaqueChanges(base, head, changed).map((c) => [c.path, c.status])).toEqual([["big.txt", "M"]]);
  });

  it("lists a mode change as a change without text", async () => {
    const sha = await blob("#!/bin/sh\n");
    const base: Snapshot = new Map([["bin/run", { sha, mode: "100644" }]]);
    const head: Snapshot = new Map([["bin/run", { sha, mode: "100755" }]]);
    const text = new Map([["bin/run", "#!/bin/sh\n"]]);
    const changed = changedVersions(text, text, ["bin/run"], { base, head });
    expect(changed).toEqual([]);
    expect(opaqueChanges(base, head, changed)).toEqual([{ path: "bin/run", status: "M", oldSha: sha, newSha: sha, mode: "100755" }]);
  });
});

describe("overlaySnapshot", () => {
  it("gives each written text its blob id, deletes, and keeps a path that git cannot hold out", async () => {
    const base: Snapshot = new Map([
      ["img/logo.png", { sha: "a".repeat(40), mode: "100644" }],
      ["bin/run", { sha: "b".repeat(40), mode: "100755" }],
    ]);
    const { snapshot, textBlobs } = await overlaySnapshot(
      base,
      new Map<string, string | null>([
        ["img/logo.png", null],
        ["bin/run", "#!/bin/sh\necho hi\n"],
        ["src/new.js", "export const n = 1;\n"],
        ["a//b.js", "x"],
      ]),
    );
    expect(snapshot.has("img/logo.png")).toBe(false);
    expect(snapshot.get("bin/run")).toEqual({ sha: await blob("#!/bin/sh\necho hi\n"), mode: "100755" });
    expect(snapshot.has("a//b.js")).toBe(false);
    expect(textBlobs.get(snapshot.get("src/new.js")!.sha)).toBe("export const n = 1;\n");
  });
});

describe("contributionRows (what a person says yes to)", () => {
  const base = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((l) => `${l}\n`).join("");
  const agent = base.replace("b\n", "B by the agent\n");
  const mainMoved = base.replace("i\n", "I on main\n");

  it("stays the same when gitring merges main into the work, and changes when the agent changes its work", () => {
    const before = contributionRows([{ path: "src/x.js", base, head: agent }], []);
    // A re-plot: the base is the new main, and the work carries both changes.
    const merged = merge3(base, mainMoved, agent);
    expect(merged.clean).toBe(true);
    const after = contributionRows([{ path: "src/x.js", base: mainMoved, head: merged.content }], []);
    expect(after).toEqual(before);
    // The agent changes one more line: a new contribution.
    const more = contributionRows([{ path: "src/x.js", base: mainMoved, head: merged.content.replace("e\n", "E\n") }], []);
    expect(more).not.toEqual(before);
    // The same lines in another place of the file count as another contribution too.
    expect(contributionRows([{ path: "src/x.js", base, head: base.replace("c\n", "B by the agent\n") }], [])).not.toEqual(before);
  });

  it("holds whole files that the agent adds or deletes, and changes without text", () => {
    const rows = contributionRows(
      [
        { path: "new.js", base: null, head: "n\n" },
        { path: "old.js", base: "o\n", head: null },
      ],
      [
        { path: "logo.png", status: "A", newSha: "c".repeat(40), mode: "100644" },
        { path: "gone.png", status: "D", oldSha: "d".repeat(40), mode: "100644" },
      ],
    );
    expect(rows).toEqual(["new.js\0add\0n\n", "old.js\0delete", "gone.png\0delete", `logo.png\u0000100644\u0000${"c".repeat(40)}`]);
  });
});
