import { describe, expect, it } from "vitest";
import { splitTask } from "../../web/src/app/taskText";

describe("splitTask", () => {
  it("keeps a title and a goal", () => {
    expect(splitTask("Add a dark mode", "Readers can switch to a dark theme.")).toEqual({ title: "Add a dark mode", goal: "Readers can switch to a dark theme." });
  });

  it("uses the title as the goal when the goal is empty", () => {
    expect(splitTask("  Fix the footer links ", "")).toEqual({ title: "Fix the footer links", goal: "Fix the footer links" });
  });

  it("takes the title from the first line of a pasted text", () => {
    expect(splitTask("Add a search\nMatch titles and authors.\nShow 20 results.", "")).toEqual({
      title: "Add a search",
      goal: "Match titles and authors.\nShow 20 results.",
    });
  });

  it("takes the title from the first sentence of the goal when there is no title", () => {
    expect(splitTask("", "Show the stock count on each book. Read it from products.js.")).toEqual({
      title: "Show the stock count on each book.",
      goal: "Show the stock count on each book. Read it from products.js.",
    });
  });

  it("returns an empty title when both are empty", () => {
    expect(splitTask(" ", "  ").title).toBe("");
  });
});
