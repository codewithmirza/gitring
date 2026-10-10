import { describe, expect, it } from "vitest";
import { place } from "../../web/src/design/components/placement";

const viewport = { width: 1280, height: 800 };

describe("popover placement", () => {
  it("opens under the trigger, aligned to its start, with the tail at its middle", () => {
    const p = place({ anchor: { left: 100, top: 10, width: 80, height: 32 }, pop: { width: 300, height: 200 }, viewport });
    expect(p.side).toBe("bottom");
    expect(p.top).toBe(10 + 32 + 10);
    expect(p.left).toBe(100);
    expect(p.tailX).toBe(40);
    expect(p.sheet).toBe(false);
  });

  it("aligns to the end of the trigger", () => {
    const p = place({ anchor: { left: 1100, top: 10, width: 120, height: 32 }, pop: { width: 300, height: 200 }, viewport, align: "end" });
    expect(p.left).toBe(1100 + 120 - 300);
    expect(p.tailX).toBe(300 - 60);
  });

  it("stays 8 px inside the viewport and keeps the tail over the trigger", () => {
    const p = place({ anchor: { left: 1240, top: 10, width: 32, height: 32 }, pop: { width: 300, height: 200 }, viewport });
    expect(p.left).toBe(1280 - 300 - 8);
    // Trigger middle 1256 → 1256 - 972 = 284, inside the 14 px corner guard.
    expect(p.tailX).toBe(284);
  });

  it("flips above when there is no room under the trigger", () => {
    const p = place({ anchor: { left: 100, top: 700, width: 80, height: 32 }, pop: { width: 300, height: 300 }, viewport });
    expect(p.side).toBe("top");
    expect(p.top).toBe(700 - 10 - 300);
  });

  it("takes the larger side and scrolls when the popover fits on neither side", () => {
    const p = place({ anchor: { left: 100, top: 300, width: 80, height: 32 }, pop: { width: 300, height: 900 }, viewport });
    expect(p.side).toBe("bottom");
    expect(p.maxHeight).toBe(800 - 332 - 10 - 8);
  });

  it("becomes a full-width sheet under the trigger on a phone", () => {
    const p = place({ anchor: { left: 300, top: 8, width: 40, height: 40 }, pop: { width: 360, height: 300 }, viewport: { width: 375, height: 760 } });
    expect(p.sheet).toBe(true);
    expect(p.left).toBe(8);
    expect(p.width).toBe(375 - 16);
    expect(p.top).toBe(8 + 40 + 10);
    expect(p.tailX).toBe(320 - 8);
  });
});
