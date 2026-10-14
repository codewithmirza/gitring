import { describe, expect, it } from "vitest";
import type { Intent } from "../../src/core/types";
import { matchFilter, splitByDay, SPLIT_BY_DAY_FROM } from "../../web/src/views/intents/rail-groups";
import type { IntentGroup } from "../../web/src/state/selectors";

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();
const DAY = 86_400_000;

function task(title: string, createdAt: number, goal = ""): Intent {
  return { id: `i_${title}`, title, goal, createdAt, updatedAt: createdAt } as unknown as Intent;
}
function group(id: string, intents: Intent[]): IntentGroup {
  return { id, label: id, intents } as unknown as IntentGroup;
}

describe("matchFilter", () => {
  it("needs every word, in the title or the goal, with any case", () => {
    const t = task("Add note search", NOW, "Match titles and tags.");
    expect(matchFilter(t, ["search"])).toBe(true);
    expect(matchFilter(t, ["add", "tags"])).toBe(true);
    expect(matchFilter(t, ["add", "export"])).toBe(false);
    expect(matchFilter(t, [])).toBe(true);
  });
});

describe("splitByDay", () => {
  it("keeps a short group whole, with no day label", () => {
    const g = group("open", [task("a", NOW), task("b", NOW - 3 * DAY)]);
    expect(splitByDay(g, NOW)).toEqual([{ key: "open", intents: g.intents }]);
  });

  it("splits a long group by the day of each task, newest first", () => {
    const many = Array.from({ length: SPLIT_BY_DAY_FROM + 1 }, (_, n) => task(`t${n}`, n < 15 ? NOW - 1000 * n : NOW - DAY - 1000 * n));
    const parts = splitByDay(group("open", many), NOW);
    expect(parts.map((p) => p.label)).toEqual(["Today", "Yesterday"]);
    expect(parts.map((p) => p.intents.length)).toEqual([15, SPLIT_BY_DAY_FROM + 1 - 15]);
  });

  it("uses the day of the merge for merged tasks", () => {
    const many = Array.from({ length: SPLIT_BY_DAY_FROM + 1 }, (_, n) => ({ ...task(`t${n}`, NOW - 9 * DAY), updatedAt: NOW - 1000 * n }));
    expect(splitByDay(group("landed", many), NOW).map((p) => p.label)).toEqual(["Today"]);
  });
});
