/**
 * The packs and the gate rules: plan validation, the cost reasoning behind the prices, the allowlist,
 * the note and the CSV file.
 */
import { describe, expect, it } from "vitest";
import { fullUseCost, isPlanId, monthlyValue, PLAN_IDS, PLANS, planById, priceLabel, tokenWeight, UNIT_COST } from "../../src/core/plans";
import { cleanAllowEntry, cleanNote, gateOn, listed, NOTE_MAX, parseAllowlist, waitlistCsv, waitlistReport, type WaitlistEntry } from "../../src/core/waitlist";
import { videoExists } from "../../web/src/views/waitlist/video";

describe("plans", () => {
  it("has one plan for each id, in the order of the ids", () => {
    expect(PLANS.map((p) => p.id)).toEqual([...PLAN_IDS]);
    expect(new Set(PLANS.map((p) => p.name)).size).toBe(PLANS.length);
  });

  it("validates ids", () => {
    for (const id of PLAN_IDS) expect(isPlanId(id)).toBe(true);
    for (const bad of ["", "Team", "platinum", null, undefined, 3, {}]) expect(isPlanId(bad)).toBe(false);
    expect(planById("team")?.name).toBe("Team");
    expect(planById("nope")).toBeUndefined();
  });

  it("has prices that go up with the pack and show as planned prices", () => {
    const prices = PLANS.map((p) => p.monthlyUsd);
    expect(prices[0]).toBe(0);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    expect(PLANS.map(priceLabel)).toEqual(["Free", "$15", "$99", "$399", "From $1,500"]);
    expect(monthlyValue("builder")).toBe(15);
    expect(monthlyValue("unknown")).toBe(0);
  });

  it("covers the cost to gitring with a margin at full use, and prices extra use above cost", () => {
    for (const p of PLANS) {
      const cost = fullUseCost(p);
      if (cost === null) continue;
      if (p.monthlyUsd === 0) expect(cost).toBeLessThan(2);
      else expect(p.monthlyUsd / cost, p.id).toBeGreaterThanOrEqual(1.5);
      if (p.overage) {
        expect(p.overage.perMerge).toBeGreaterThanOrEqual(UNIT_COST.merge * 2.5);
        expect(p.overage.perTestRun).toBeGreaterThanOrEqual(UNIT_COST.testRun * 2.5);
        expect(p.overage.perMillionTokens).toBeGreaterThanOrEqual(UNIT_COST.millionTokens * 2.5);
        expect(p.overage.perGb).toBeGreaterThanOrEqual(UNIT_COST.gbMonth * 2.5);
      }
    }
  });

  it("gives larger packs more of everything", () => {
    const keys = ["projects", "people", "merges", "testRuns", "agentTokensM", "storageGb"] as const;
    const sized = PLANS.filter((p) => p.included.merges !== null);
    for (const k of keys) {
      const values = sized.map((p) => p.included[k] as number);
      expect([...values].sort((a, b) => a - b), k).toEqual(values);
    }
  });

  it("counts a token of a dearer model more", () => {
    expect(tokenWeight("@cf/zai-org/glm-5.3-flash")).toBe(1);
    expect(tokenWeight("@cf/zai-org/glm-5.3")).toBe(9);
    expect(tokenWeight("@cf/moonshotai/kimi-k2.7-code")).toBeGreaterThan(1);
  });
});

describe("the gate settings", () => {
  it("is off without settings, so a self-hosted gitring is not gated", () => {
    expect(gateOn({})).toBe(false);
    expect(gateOn({ ALLOWLIST_EMAILS: "  ,, " })).toBe(false);
    expect(gateOn({ WAITLIST_ENABLED: "" })).toBe(false);
  });

  it("is on with an allowlist or with WAITLIST_ENABLED=true, and off with =false", () => {
    expect(gateOn({ ALLOWLIST_EMAILS: "a@example.com" })).toBe(true);
    expect(gateOn({ WAITLIST_ENABLED: "true" })).toBe(true);
    expect(gateOn({ WAITLIST_ENABLED: " TRUE " })).toBe(true);
    expect(gateOn({ WAITLIST_ENABLED: "false", ALLOWLIST_EMAILS: "a@example.com" })).toBe(false);
  });

  it("reads the allowlist in lowercase, without blanks and doubles", () => {
    expect(parseAllowlist(" A@Example.com, b@example.com ,a@example.com;\nC@example.com")).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(listed(["a@example.com"], ["x@example.com", "A@EXAMPLE.COM"])).toBe(true);
    expect(listed(["a@example.com"], [])).toBe(false);
  });

  it("accepts an email or an account id in the owner list, and nothing else", () => {
    expect(cleanAllowEntry(" New@Example.com ")).toBe("new@example.com");
    expect(cleanAllowEntry("user:u_0123456789")).toBe("user:u_0123456789");
    for (const bad of ["", "nobody", "a@b", "a b@example.com", "x@example.com,y@example.com", "user:", "github:me", 5, null]) expect(cleanAllowEntry(bad), String(bad)).toBeNull();
  });

  it("cleans a note", () => {
    expect(cleanNote("  hello\u0000 world  ")).toBe("hello  world");
    expect(cleanNote("x".repeat(NOTE_MAX + 50))).toHaveLength(NOTE_MAX);
    expect(cleanNote(undefined)).toBe("");
  });
});

describe("the report and the CSV file", () => {
  const entry = (pack: WaitlistEntry["pack"], over: Partial<WaitlistEntry> = {}): WaitlistEntry & { allowed: boolean } => ({
    id: `w_${pack}`,
    userId: `u_${pack}`,
    email: `${pack}@example.com`,
    name: pack,
    provider: "google",
    pack,
    note: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    allowed: false,
    ...over,
  });

  it("counts each pack and sums the monthly value", () => {
    const r = waitlistReport([entry("team"), entry("team", { id: "w_2" }), entry("explorer"), entry("scale")]);
    expect(r.total).toBe(4);
    expect(r.byPack).toEqual({ explorer: 1, builder: 0, team: 2, scale: 1, enterprise: 0 });
    expect(r.monthlyValueUsd).toBe(99 * 2 + 399);
  });

  it("writes one line for each person, and quotes cells", () => {
    const csv = waitlistCsv([entry("builder", { note: 'He said "yes", twice\nline two', name: "Ada, Countess" })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("id,email,name,provider,pack,monthly_usd,note,allowed,created,updated");
    expect(csv).toContain('"Ada, Countess"');
    expect(csv).toContain('"He said ""yes"", twice\nline two"');
    expect(csv).toContain(",builder,15,");
  });

  it("stops formulas in a spreadsheet", () => {
    const csv = waitlistCsv([entry("team", { note: "=1+1", name: "@cmd" })]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@cmd");
  });
});

describe("the product video check", () => {
  const stub = (res: () => Response | Promise<Response>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => res()) as typeof fetch;
    return () => {
      globalThis.fetch = real;
    };
  };

  it("finds a file with a video type", async () => {
    const undo = stub(() => new Response(null, { status: 200, headers: { "content-type": "video/mp4" } }));
    expect(await videoExists()).toBe(true);
    undo();
  });

  it("does not take the app page for a video (a missing file answers 200 with HTML)", async () => {
    const undo = stub(() => new Response(null, { status: 200, headers: { "content-type": "text/html" } }));
    expect(await videoExists()).toBe(false);
    undo();
  });

  it("answers false when the request fails", async () => {
    const undo = stub(() => Promise.reject(new Error("offline")));
    expect(await videoExists()).toBe(false);
    undo();
    const undo2 = stub(() => new Response(null, { status: 404 }));
    expect(await videoExists()).toBe(false);
    undo2();
  });
});
