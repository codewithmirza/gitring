/**
 * The truth test of the landing story: every quoted string in its drawings is real output of the product.
 * It runs the shop story of scripts/meet.mjs in this process (as test/load/meet-run.test.ts does) and reads what the agents read,
 * then asks the same server why a line is there. When a string of the product changes, this test fails: update example.ts and the picture.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVAL_WORD } from "../../src/core/approvals";
import { TEMPLATES } from "../../src/core/templates";
import { callsignFor } from "../../src/harbor/ids";
import worker from "../../src/worker/index";
import { EUROS } from "../../scripts/meet-files.mjs";
import { prepareMeet, runMeet } from "../../scripts/meet.mjs";
import { plural, RANGE_TEXT } from "../../web/src/state/format";
import { APPROVALS_IN_TEXT } from "../../web/src/state/inbox";
import { toolNames } from "../../web/src/views/connect-text";
import { requestStatusText, stepWho, testsText } from "../../web/src/views/code/history";
import { DESCRIBE_LABEL, SOURCES } from "../../web/src/views/newproject/start-text";
import { CAPTIONS } from "../../web/src/views/story/copy";
import { EXAMPLE } from "../../web/src/views/story/example";
import { World } from "../harbor/world";

const source = (path: string) => readFileSync(path, "utf8");

interface WhyAnswer {
  text: string;
  step: { kind: string; at: number; merge?: { callsign: string } };
  record: { task: { title: string }; plan: { approach: string }; changeRequests: { status: string }[]; tests: { passed: number; failed: number } };
}

let world: World;
let report = "";
let why: WhyAnswer;

beforeAll(async () => {
  world = new World();
  await world.init();
  const { key } = await world.signIn("robin", 1);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const ctx = { waitUntil: (p: Promise<unknown>) => void world.pending.push(p.catch(() => undefined)), passThroughOnException() {}, props: {} };
    return worker.fetch(new Request(input, init), world.env as never, ctx as never);
  };
  const said: string[] = [];
  // The third agent needs a person's yes. The run does not wait for it, so main holds two merges and the Free line is line 2.
  const result = await runMeet({ endpoint: new URL("https://gitring.test/mcp"), key, options: { approval: true, waitSec: 0, keep: true }, say: (line: string) => said.push(line), fetchImpl, pollMs: 20 });
  await world.settle();
  report = said.join("\n");
  const answer = await fetchImpl(`https://gitring.test/api/projects/${result.project}/why?path=${encodeURIComponent("src/price.js")}&ref=main&line=2`, { headers: { authorization: `Bearer ${key}` } });
  why = (await answer.json()) as WhyAnswer;
}, 120_000);

afterAll(async () => {
  await world?.close();
});

describe("chapters 01 and 02: starting and connecting", () => {
  it("uses the real labels of the new-project page, a real template and a real tool name", () => {
    expect(EXAMPLE.start.describeLabel).toBe(DESCRIBE_LABEL);
    expect(SOURCES.map((s) => s.title)).toContain(EXAMPLE.start.templateLabel);
    expect(TEMPLATES.map((t) => t.title)).toContain(EXAMPLE.start.template);
    expect(source("web/src/views/newproject/StartList.tsx")).toContain(`placeholder="${EXAMPLE.start.describe}"`);
    expect(toolNames()).toContain(EXAMPLE.start.tool);
    expect(source("src/worker/mcp-projects.ts")).toContain(EXAMPLE.start.tool);
  });

  it("uses the address shape of the script and the apps of the connect page", () => {
    expect(prepareMeet([], { GITRING_URL: "https://your-gitring.example.com", GITRING_KEY: "gk_example" }).endpoint?.href).toBe(EXAMPLE.connect.url);
    const clients = source("web/src/views/connect/clients.ts");
    for (const app of EXAMPLE.connect.apps) {
      expect(clients).toContain(`"${app}"`);
      expect(report).toContain(`(${app})`);
    }
  });
});

describe("chapter 03: the plans", () => {
  it("gives the first agents the callsigns of the story, in order", () => {
    expect([1, 2, 3].map(callsignFor)).toEqual([EXAMPLE.plans.first.callsign, EXAMPLE.plans.second.callsign, "TERN-7"]);
  });

  it("names the real tool, the real tasks and the real files and function", () => {
    expect(toolNames()).toContain(EXAMPLE.plans.tool);
    expect(report).toContain(`calls ${EXAMPLE.plans.tool}`);
    expect(report).toContain(`You are ${EXAMPLE.plans.first.callsign} on the task "${EXAMPLE.plans.first.title}"`);
    expect(report).toContain(`You are ${EXAMPLE.plans.second.callsign} on the task "${EXAMPLE.plans.second.title}"`);
    const steps = source("scripts/meet-steps.mjs");
    for (const plan of [EXAMPLE.plans.first, EXAMPLE.plans.second]) {
      for (const file of plan.files.split(", ")) expect(steps).toContain(`"${file}"`);
      expect(steps).toContain(`"${plan.symbols}"`);
      expect(steps).toContain(`title: "${plan.title}"`);
    }
  });
});

describe("chapter 04: the check", () => {
  it("quotes the first change request of the second agent, word for word", () => {
    expect(report).toContain(`${EXAMPLE.check.reason} ${EXAMPLE.check.request}`);
    // The request goes to the agent that sent its plan second. The first agent continues, and is told that it is clear.
    expect(report).toContain(`You are ${EXAMPLE.plans.first.callsign} on the task "${EXAMPLE.plans.first.title}"`);
    expect(report).toMatch(new RegExp(`You are ${EXAMPLE.plans.first.callsign}[^\\n]*Conflict check: ${EXAMPLE.check.clear}\\.`));
    expect(CAPTIONS.request).toBe(`Change request to ${EXAMPLE.plans.second.callsign}`);
  });

  it("names distance 0 the way the product does", () => {
    expect(EXAMPLE.check.distance).toBe(`0 ${RANGE_TEXT[0]}`);
    expect(EXAMPLE.check.reason.startsWith(`(${RANGE_TEXT[0]};`)).toBe(true);
  });
});

describe("chapter 05: tests and merges", () => {
  it("shows the real answers of the tests, and main moving after the first merge", () => {
    expect(report).toMatch(new RegExp(`Agent A \\(Claude Code\\) calls gitring_check[^\\n]*\\n  │ ${EXAMPLE.merge.first}\\.`));
    expect(report).toMatch(new RegExp(`Agent B \\(Cursor\\) calls gitring_check[^\\n]*\\n  │ ${EXAMPLE.merge.second}\\.`));
    expect(report).toContain(`(${EXAMPLE.merge.moved}; ${EXAMPLE.plans.first.callsign} continues)`);
    // The label of main moving comes after the first merge in the report, as in the picture.
    expect(report.indexOf("calls gitring_check", report.indexOf("Agent A (Claude Code)"))).toBeLessThan(report.indexOf(EXAMPLE.merge.moved));
  });
});

describe("chapter 06: the question that waits for a person", () => {
  it("quotes the real question and its reason", () => {
    expect(report).toContain(`to this work: "${EXAMPLE.ask.task}". ${EXAMPLE.ask.facts}`);
    // The product names the changed functions in one order or the other. The picture uses one of the two.
    const names = /Why: The parameters of (\w+), (\w+) change\. Other code can call them\./.exec(report);
    expect(names).not.toBeNull();
    expect([names![1], names![2]].sort()).toEqual(["cartTotal", "formatPrice"]);
    expect(EXAMPLE.ask.why).toBe(`The parameters of ${names![1]}, ${names![2]} change. Other code can call them.`);
    expect(report).toContain(`You are TERN-7 on the task "${EXAMPLE.ask.task}"`);
  });

  it("uses the real words of the question, the buttons and the three places to answer", () => {
    expect(EXAMPLE.ask.waits).toBe(APPROVAL_WORD.waiting);
    expect(EXAMPLE.ask.places).toEqual([APPROVALS_IN_TEXT.agent.label, APPROVALS_IN_TEXT.app.label, APPROVALS_IN_TEXT.both.label]);
    expect(APPROVALS_IN_TEXT.app.help).toContain(CAPTIONS.noAgent);
    for (const file of ["web/src/views/ApproveView.tsx", "web/src/app/ApprovalCard.tsx"]) {
      expect(source(file)).toContain(EXAMPLE.ask.yes);
      expect(source(file)).toContain(EXAMPLE.ask.back);
    }
  });
});

describe("chapter 07: the merge record of a line", () => {
  it("shows the file of the story, line for line", () => {
    expect(`${EXAMPLE.why.code.join("\n")}\n`).toBe(EUROS);
    expect(EXAMPLE.why.code[EXAMPLE.why.line - 1]).toBe('  if (cents === 0) return "Free";');
  });

  it("answers why the Free line is there with the record that the picture shows", () => {
    // In this run the Free line is line 2 (the third merge, which adds three lines above it, waits for a person).
    expect(why.text).toBe(EXAMPLE.why.code[EXAMPLE.why.line - 1]);
    expect(why.record.task.title).toBe(EXAMPLE.why.task);
    expect(why.record.plan.approach).toBe(EXAMPLE.why.approach);
    expect(stepWho(why.step as never, why.step.at)).toMatch(new RegExp(`^${EXAMPLE.why.who},`));
    expect(plural(why.record.changeRequests.length, "change request")).toBe(EXAMPLE.why.requests);
    for (const request of why.record.changeRequests) expect(requestStatusText(request.status)).toBe(EXAMPLE.why.status);
    expect(testsText(why.record.tests)).toBe(EXAMPLE.why.tests);
  });

  it("uses the label of the real button", () => {
    expect(source("web/src/views/code/LineHistory.tsx")).toContain("`Why line ${line}?`");
    expect(EXAMPLE.why.button).toBe(`Why line ${EXAMPLE.why.line}?`);
  });
});
