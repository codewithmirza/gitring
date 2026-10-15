/**
 * The real strings of the shop example, each with the file it comes from. They are output of the product, not our words.
 * Used by the scenes. test/web/story-example.test.ts runs the shop story in process and fails when a string drifts.
 * Our own captions are in copy.ts. Read scenes/README.md next.
 */

export const EXAMPLE = {
  /** Chapter 01. Labels: web/src/views/newproject/start-text.ts. Example sentence: the field of StartList.tsx. Template: src/core/templates.ts. Tool: src/worker/mcp-projects.ts. */
  start: {
    describeLabel: "Describe what you want to build",
    describe: "A JSON API for my shop, with tests",
    templateLabel: "Template",
    template: "Worker API",
    tool: "gitring_create_project",
  },

  /** Chapter 02. The address shape of MEET_USAGE in scripts/meet.mjs. The apps: web/src/views/connect/clients.ts and scripts/meet-steps.mjs. */
  connect: {
    url: "https://your-gitring.example.com/mcp",
    apps: ["Claude Code", "Cursor", "Codex"],
  },

  /** Chapter 03. The real plans of agent A and agent B in scripts/meet-steps.mjs. The callsigns come from callsignFor in src/harbor/ids.ts. */
  plans: {
    tool: "gitring_declare",
    first: { callsign: "HERON-2", title: "Show thousands separators in prices", files: "src/price.js, tests/price.test.js", symbols: "src/price.js#formatPrice" },
    second: { callsign: "PETREL-9", title: "Show Free for a price of zero", files: "src/price.js, tests/price.test.js", symbols: "src/price.js#formatPrice" },
  },

  /** Chapter 04. The first change request of PETREL-9 in the real run (src/core/coord/corrections.ts), cut after three sentences. */
  check: {
    distance: "0 same lines",
    clear: "clear",
    reason: "(same lines; HERON-2 continues)",
    request: "HERON-2 also changes formatPrice in src/price.js. Do not rewrite formatPrice. Keep your change to formatPrice small and in a separate block.",
  },

  /** Chapter 05. The answers of gitring_check in the real run, and the label of the third change request ("main moved"). */
  merge: {
    first: "3/3 tests pass",
    second: "4/4 tests pass",
    moved: "main moved",
  },

  /** Chapter 06. The real question of the run (src/core/approvals.ts) and the answer places (web/src/state/inbox.ts). Buttons: ApproveView.tsx. */
  ask: {
    task: "Show euros in the EU",
    facts: "3 files, +7 -4. 5 of 5 tests pass. The code logic changes.",
    why: "The parameters of cartTotal, formatPrice change. Other code can call them.",
    waits: "waits for a person",
    yes: "Yes, merge",
    back: "Send back…",
    places: ["In the agent's chat", "In the gitring app", "In both"],
  },

  /** Chapter 07. The file on main after the three merges (EUROS in scripts/meet-files.mjs) and the answer of /why for line 4. */
  why: {
    line: 4,
    button: "Why line 4?",
    code: [
      'const SIGNS = { USD: "$", EUR: "€" };',
      "",
      'export function formatPrice(cents, currency = "USD") {',
      '  if (cents === 0) return "Free";',
      "  const dollars = (cents / 100).toFixed(2);",
      '  return SIGNS[currency] + dollars.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");',
      "}",
    ],
    task: "Show Free for a price of zero",
    who: "Merged by PETREL-9",
    approach: "Add a check at the top of formatPrice.",
    requests: "2 change requests",
    status: "The agent applied it",
    tests: "4 of 4 tests pass",
  },
} as const;
