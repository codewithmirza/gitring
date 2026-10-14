/**
 * The planned paid packs and their prices: one source for the waitlist page, the admin view and docs/PRICING.md.
 *
 * These are planned prices. Nothing is charged: gitring has no payment code.
 * The waitlist only learns which pack people would use. This is not the plan of an agent (see `types/plan-and-changes.ts`).
 * No runtime dependencies.
 */

export const PLAN_IDS = ["explorer", "builder", "team", "scale", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** What a pack includes in each month. `null`: no fixed limit (a talk decides it). */
export interface PlanIncluded {
  projects: number | null;
  /** People with a login. Agents are free: they are not people. */
  people: number | null;
  /** Merges into main. */
  merges: number | null;
  /** Test runs in a container. Tests in the worker runner are free. */
  testRuns: number | null;
  /** Built-in agent tokens, in millions (GLM 5.3 Flash counts 1 per token; see TOKEN_WEIGHT). */
  agentTokensM: number | null;
  /** Gigabytes of code and history. */
  storageGb: number | null;
}

/** The price of use above the included amount. */
export interface PlanOverage {
  perMerge: number;
  perTestRun: number;
  perMillionTokens: number;
  perGb: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Dollars each month. 0: free. */
  monthlyUsd: number;
  /** The price is a start price ("from"): a talk sets the final price. */
  from?: boolean;
  /** One line for the card. */
  tagline: string;
  /** Who the pack is for. */
  forWho: string;
  included: PlanIncluded;
  /** `null`: no use above the included amount (the pack stops at its limit, or a talk decides). */
  overage: PlanOverage | null;
  /** Short points for the card, in plain words. */
  points: string[];
}

export const PLANS: readonly Plan[] = [
  {
    id: "explorer",
    name: "Explorer",
    monthlyUsd: 0,
    tagline: "Try gitring with a small project.",
    forWho: "One person who wants to see many agents work on one codebase.",
    included: { projects: 1, people: 3, merges: 50, testRuns: 50, agentTokensM: 0.5, storageGb: 0.5 },
    overage: null,
    points: ["1 project, 3 people, any number of agents", "50 merges and 50 container test runs each month", "0.5 million built-in agent tokens", "Stops at the limit. It never charges."],
  },
  {
    id: "builder",
    name: "Builder",
    monthlyUsd: 15,
    tagline: "For one builder with a few projects.",
    forWho: "A solo builder who lets agents write most of the code.",
    included: { projects: 5, people: 3, merges: 500, testRuns: 500, agentTokensM: 5, storageGb: 5 },
    overage: { perMerge: 0.02, perTestRun: 0.015, perMillionTokens: 0.6, perGb: 1.5 },
    points: ["5 projects, 3 people, any number of agents", "500 merges and 500 container test runs each month", "5 million built-in agent tokens", "Extra use at a small price for each unit"],
  },
  {
    id: "team",
    name: "Team",
    monthlyUsd: 99,
    tagline: "For a team where people and agents share code.",
    forWho: "A team of up to 10 people with many agents at work.",
    included: { projects: 25, people: 10, merges: 3000, testRuns: 3000, agentTokensM: 30, storageGb: 25 },
    overage: { perMerge: 0.02, perTestRun: 0.015, perMillionTokens: 0.6, perGb: 1.5 },
    points: ["25 projects, 10 people, any number of agents", "3,000 merges and 3,000 container test runs each month", "30 million built-in agent tokens", "Rules by folder and approvals by kind of change"],
  },
  {
    id: "scale",
    name: "Scale",
    monthlyUsd: 399,
    tagline: "For a company with a large fleet of agents.",
    forWho: "A company where hundreds of agents change the code each day.",
    included: { projects: 100, people: 50, merges: 15000, testRuns: 15000, agentTokensM: 150, storageGb: 100 },
    overage: { perMerge: 0.018, perTestRun: 0.013, perMillionTokens: 0.5, perGb: 1.25 },
    points: ["100 projects, 50 people, any number of agents", "15,000 merges and 15,000 container test runs each month", "150 million built-in agent tokens", "Help with set-up by email"],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyUsd: 1500,
    from: true,
    tagline: "For a company with its own needs.",
    forWho: "A company that needs its own limits, its own contract or its own Cloudflare account.",
    included: { projects: null, people: null, merges: null, testRuns: null, agentTokensM: null, storageGb: null },
    overage: null,
    points: ["Limits that fit your company", "Runs in your own Cloudflare account, if you want", "A contract and a named contact", "Price from $1,500 each month"],
  },
];

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);
}

export function planById(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** The monthly value of one choice in dollars (an Enterprise choice counts its start price). */
export function monthlyValue(id: string): number {
  return planById(id)?.monthlyUsd ?? 0;
}

/**
 * How many tokens of the pack one token of a model costs. GLM 5.3 Flash is the unit. The other models cost
 * more at Cloudflare, so each of their tokens counts more.
 */
export function tokenWeight(model: string): number {
  if (/glm-5\.3-flash|glm-4\.7-flash/i.test(model)) return 1;
  if (/glm-5\.3/i.test(model)) return 9;
  if (/kimi/i.test(model)) return 7;
  return 1;
}

/** What a unit of use costs gitring at Cloudflare list prices (dollars). docs/PRICING.md shows the sums. */
export const UNIT_COST = {
  merge: 0.006,
  testRun: 0.005,
  millionTokens: 0.2,
  gbMonth: 0.5,
} as const;

/** The cost to gitring of a pack when all of its included use is spent (dollars each month). */
export function fullUseCost(p: Plan): number | null {
  const i = p.included;
  if (i.merges === null || i.testRuns === null || i.agentTokensM === null || i.storageGb === null) return null;
  return i.merges * UNIT_COST.merge + i.testRuns * UNIT_COST.testRun + i.agentTokensM * UNIT_COST.millionTokens + i.storageGb * UNIT_COST.gbMonth;
}

/** A price for people: "Free", "$15", "From $1,500". */
export function priceLabel(p: Plan): string {
  if (p.monthlyUsd === 0) return "Free";
  const n = `$${p.monthlyUsd.toLocaleString("en-US")}`;
  return p.from ? `From ${n}` : n;
}
