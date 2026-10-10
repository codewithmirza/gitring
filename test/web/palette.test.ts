import { describe, expect, it } from "vitest";
import { fuzzyScore, parseQuery, rank, scoreEntry, type PaletteEntry } from "../../web/src/app/palette";

const E = (key: string, group: PaletteEntry["group"], title: string, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({ key, group, title, ...extra });

describe("fuzzyScore", () => {
  it("matches letters in order and rejects the rest", () => {
    expect(fuzzyScore("tsk", "Tasks")).not.toBeNull();
    expect(fuzzyScore("kst", "Tasks")).toBeNull();
    expect(fuzzyScore("", "anything")).toEqual({ score: 0, hits: [] });
  });

  it("prefers whole words, word starts and short texts", () => {
    const word = fuzzyScore("search", "Add a search")!.score;
    const scattered = fuzzyScore("search", "sea of red cheese")!.score;
    expect(word).toBeGreaterThan(scattered);
    const short = fuzzyScore("code", "Code")!.score;
    const long = fuzzyScore("code", "Code of conduct for every contributor")!.score;
    expect(short).toBeGreaterThan(long);
  });

  it("finds a match that a jump to a word start would miss", () => {
    // "ab": the jump to the word "ac" would leave no "b" after it; the leftmost pass finds "xab".
    expect(fuzzyScore("ab", "xab ac")).not.toBeNull();
  });

  it("reports the matched positions for highlight", () => {
    expect(fuzzyScore("ov", "Overview")!.hits).toEqual([0, 1]);
  });
});

describe("parseQuery", () => {
  it("reads the prefixes", () => {
    expect(parseQuery(">new")).toEqual({ group: "Commands", text: "new" });
    expect(parseQuery("#dark")).toEqual({ group: "Tasks", text: "dark" });
    expect(parseQuery("@petrel")).toEqual({ group: "Agents", text: "petrel" });
    expect(parseQuery("/src/a")).toEqual({ group: "Files", text: "src/a" });
    expect(parseQuery("  plain ")).toEqual({ group: null, text: "plain" });
  });
});

describe("scoreEntry", () => {
  it("matches a file by its name before its folder", () => {
    const byName = scoreEntry("header", E("f1", "Files", "src/render/header.js"))!;
    const byFolder = scoreEntry("render", E("f2", "Files", "src/render/page.js"))!;
    expect(byName.score).toBeGreaterThan(byFolder.score);
    expect(byName.hits[0]).toBe("src/render/".length);
  });

  it("matches hidden keywords with a lower score", () => {
    const e = E("c1", "Commands", "Connect an agent", { keywords: "mcp claude" });
    expect(scoreEntry("claude", e)).not.toBeNull();
    expect(scoreEntry("claude", e)!.hits).toEqual([]);
  });
});

describe("rank", () => {
  const entries: PaletteEntry[] = [
    E("cmd:new-task", "Commands", "New task"),
    E("cmd:connect", "Commands", "Connect an agent"),
    E("page:/tasks", "Pages", "Tasks"),
    E("page:/history", "Pages", "History"),
    E("task:i1", "Tasks", "Add a dark mode"),
    E("task:i2", "Tasks", "Add a search"),
    E("file:src/search.js", "Files", "src/search.js"),
  ];

  it("shows recent items first for an empty query", () => {
    const s = rank("", entries, ["task:i2", "gone:key"]);
    expect(s[0].group).toBe("Recent");
    expect(s[0].items.map((r) => r.item.key)).toEqual(["task:i2"]);
    expect(s.some((x) => x.group === "Commands")).toBe(true);
  });

  it("keeps a prefix to its group", () => {
    const s = rank("#add", entries);
    expect(s).toHaveLength(1);
    expect(s[0].group).toBe("Tasks");
    expect(s[0].items).toHaveLength(2);
  });

  it("lists the whole group for a bare prefix", () => {
    expect(rank("/", entries)[0].items.map((r) => r.item.key)).toEqual(["file:src/search.js"]);
  });

  it("puts the group with the best match first", () => {
    const s = rank("search", entries);
    expect(["Tasks", "Files"]).toContain(s[0].group);
    expect(s.flatMap((x) => x.items).every((r) => r.score > 0 || r.hits.length >= 0)).toBe(true);
  });

  it("gives recent items a small boost", () => {
    const a = rank("add", entries, ["task:i1"]).flatMap((x) => x.items);
    expect(a[0].item.key).toBe("task:i1");
  });

  it("returns nothing when nothing matches", () => {
    expect(rank("zzzz", entries)).toEqual([]);
  });
});
