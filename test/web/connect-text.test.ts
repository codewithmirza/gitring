/**
 * The Connect page: the three MCP addresses, the tool list, the flow text and the short blocks of words.
 * The list stays equal to the tools of the Worker, and the words stay plain (ASD-STE100).
 */
import { describe, expect, it } from "vitest";
import { APPROVAL_WORD, approvalPath } from "../../src/core/approvals";
import { GITRING_TOOLS } from "../../src/worker/mcp";
import { GITHUB_TOOLS } from "../../src/worker/mcp-github";
import { FLOW_STAGES, GITHUB_SWAP, MERGE_QUESTION, READ_ONLY, TOOLS, approvalExample, flowText, mcpEndpoints, toolNames } from "../../web/src/views/connect-text";
import { steViolations } from "../coord/ste";

/** A word in `backticks` shows as code on the page: the checker reads the plain text. */
const plain = (text: string) => text.replace(/`/g, "");

/** "Bring" (gitring_update) is a verb, not an "-ing" form. The checker cannot tell the two apart. */
const NOT_VERB_FORMS = /"-ing" form "Bring"/;
const steProblems = (text: string) => steViolations(plain(text)).filter((p) => !NOT_VERB_FORMS.test(p));

describe("mcpEndpoints", () => {
  it("adds the GitHub-style and the read-only address to the main one", () => {
    expect(mcpEndpoints("https://gitring.example/mcp")).toEqual({
      origin: "https://gitring.example",
      main: "https://gitring.example/mcp",
      github: "https://gitring.example/mcp/github",
      readonly: "https://gitring.example/mcp/readonly",
    });
  });

  it("ignores a slash at the end, and works on a local address", () => {
    expect(mcpEndpoints("http://127.0.0.1:8822/mcp/")).toEqual({
      origin: "http://127.0.0.1:8822",
      main: "http://127.0.0.1:8822/mcp",
      github: "http://127.0.0.1:8822/mcp/github",
      readonly: "http://127.0.0.1:8822/mcp/readonly",
    });
  });
});

describe("the tool list", () => {
  it("has every tool of the Worker, each name once", () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(GITRING_TOOLS.map((t) => t.name).sort());
  });

  it("lists the status tool, and says that it does not change the work copy", () => {
    const status = TOOLS.find(([name]) => name === "gitring_status");
    expect(status).toBeDefined();
    expect(status![1]).toContain("with a person, sent back, in the merge queue, or merged");
    expect(status![1]).toContain("It does not change the work copy.");
  });

  it("says that a merge waits for a person when the project asks", () => {
    const submit = TOOLS.find(([name]) => name === "gitring_submit")![1];
    expect(submit).toContain("merges it when the tests pass");
    expect(submit).toContain("A person says yes first when the project asks.");
    expect(submit).not.toMatch(/by itself/);
  });

  it("gives every tool one line in plain words", () => {
    for (const [name, line] of TOOLS) {
      expect(line.length, name).toBeGreaterThan(0);
      expect(steProblems(line), name).toEqual([]);
    }
  });
});

describe("the flow", () => {
  it("runs the tests, then asks a person, then merges", () => {
    const labels = FLOW_STAGES.map((s) => s.label);
    expect(labels).toEqual(["Conflict check", "Change requests", "Rebase", "Tests", "Approval", "Merge", "History"]);
    expect(FLOW_STAGES.find((s) => s.label === "Approval")?.note).toBe("a person, if the project asks");
  });

  it("gives every stage an icon and a note", () => {
    for (const s of FLOW_STAGES) {
      expect(s.icon.length, s.label).toBeGreaterThan(0);
      expect(s.note.length, s.label).toBeGreaterThan(0);
    }
  });

  it("tells a screen reader that the work merges when the tests pass, and that a person says yes when the project asks", () => {
    const text = flowText({ inputs: { githubIssues: false, slack: false } } as Parameters<typeof flowText>[0], false);
    expect(text).toContain("It merges the work when the tests pass, and a person says yes when the project asks.");
    expect(text).not.toMatch(/by itself/);
    expect(steProblems("It runs the tests. It merges the work when the tests pass, and a person says yes when the project asks. A merge is a fast-forward, a 3-way merge or a redo.")).toEqual([]);
  });

  it("names GitHub as an output only when GitHub is on", () => {
    const info = { inputs: { githubIssues: true, slack: true } } as Parameters<typeof flowText>[0];
    expect(flowText(info, true)).toContain("GitHub (a pull request or main)");
    expect(flowText(info, false)).not.toContain("GitHub (a pull request or main)");
    expect(flowText(info, false)).toContain("GitHub issues with the label gitring open tasks");
  });
});

describe("the blocks under the connector", () => {
  it("names tools that the GitHub address has", () => {
    const github = new Set(GITHUB_TOOLS.map((t) => t.name));
    const named = GITHUB_SWAP.lines.flatMap((line) => [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
    expect(named).toEqual(["get_file_contents", "create_pull_request"]);
    for (const name of named) expect(github.has(name), name).toBe(true);
  });

  it("says that nothing writes to main, and that a person says yes when the project asks", () => {
    const text = GITHUB_SWAP.lines.join(" ");
    expect(text).toContain("No tool writes to main directly.");
    expect(text).toContain("a person says yes when the project asks");
    expect(GITHUB_SWAP.summary).toBe("Already use the GitHub connector? Replace it.");
    expect(GITHUB_SWAP.lines).toHaveLength(4);
  });

  it("names the read-only scope", () => {
    expect(READ_ONLY.summary).toBe("Read-only access");
    expect(READ_ONLY.text).toContain("`mcp:read`");
  });

  it("keeps the labels of the new URL fields apart from the main one (a test finds the main field by its label)", () => {
    expect(GITHUB_SWAP.label).not.toMatch(/MCP URL/i);
    expect(READ_ONLY.label).not.toMatch(/MCP URL/i);
  });

  it("asks about a merge in three short lines", () => {
    expect(MERGE_QUESTION.title).toBe("When an agent asks for a merge");
    expect(MERGE_QUESTION.lines).toHaveLength(3);
  });

  it("uses plain words", () => {
    const words = [
      ...GITHUB_SWAP.lines,
      GITHUB_SWAP.summary,
      READ_ONLY.text,
      READ_ONLY.summary,
      MERGE_QUESTION.title,
      ...MERGE_QUESTION.lines,
      `${MERGE_QUESTION.settings} ${MERGE_QUESTION.settingsLink}.`,
      `${MERGE_QUESTION.slack} ${MERGE_QUESTION.slackLink}.`,
    ];
    for (const line of words) {
      expect(steProblems(line), line).toEqual([]);
      for (const bad of [/harbor/i, /vessel/i, /footprint/i, /digest/i]) expect(line, line).not.toMatch(bad);
    }
  });
});

describe("approvalExample", () => {
  it("is JSON with the keys of the message that the Worker posts, in the same order", () => {
    const body = JSON.parse(approvalExample("gitring-web-ab12", "https://gitring.example"));
    expect(Object.keys(body)).toEqual(["event", "project", "at", "attemptId", "approval", "task", "agent", "line", "link"]);
    expect(body.event).toBe("approval");
    expect(body.project).toBe("gitring-web-ab12");
  });

  it("links to the page where a person answers", () => {
    const body = JSON.parse(approvalExample("gitring-web-ab12", "http://127.0.0.1:8822"));
    expect(body.link).toBe(`http://127.0.0.1:8822${approvalPath("gitring-web-ab12", body.attemptId)}`);
    expect(body.link).toBe(`http://127.0.0.1:8822/approve/${body.attemptId}?project=gitring-web-ab12`);
  });

  it("shows a question that waits, with a reason that the Worker uses", () => {
    const body = JSON.parse(approvalExample("p", "https://x.example"));
    expect(Object.keys(APPROVAL_WORD)).toContain(body.approval.status);
    expect(body.approval.status).toBe("waiting");
    expect(["no-test-ran", "competing", "project-asks", "looks-risky", "merge-stopped"]).toContain(body.approval.reason);
    expect(body.approval.why.length).toBeGreaterThan(0);
    for (const why of body.approval.why) expect(steProblems(why)).toEqual([]);
  });
});
