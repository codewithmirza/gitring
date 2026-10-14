/**
 * Starter templates: each one passes its own tests in the gitring test runner, has the files that the
 * plan names, and tells agents to use gitring. pickTemplate finds the best fit for a description.
 */
import { afterAll, describe, expect, it } from "vitest";
import { contentKey, runChecks } from "../../src/platform/checks/runner";
import { isTemplateId, packageName, pickTemplate, templateFiles, TEMPLATES, type TemplateId } from "../../src/core/templates";
import { steViolations } from "../coord/ste";
import { nodeLoader } from "../checks/node-loader";

const loader = nodeLoader();
afterAll(() => loader.cleanup());

function filesOf(id: TemplateId, name = "Robin Shop"): Map<string, string> {
  return new Map(templateFiles(id, { name }).map((f) => [f.path, f.content]));
}

describe("templates", () => {
  it("lists four templates, each with a short title and one plain sentence", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["empty", "js-library", "worker-api", "static-site"]);
    for (const t of TEMPLATES) {
      expect(t.title.split(/\s+/).length).toBeLessThanOrEqual(3);
      expect(steViolations(t.summary)).toEqual([]);
    }
    expect(isTemplateId("worker-api")).toBe(true);
    expect(isTemplateId("rails")).toBe(false);
    expect(isTemplateId(undefined)).toBe(false);
  });

  it("gives every template a README, a .gitignore and an AGENTS.md that names the gitring tools", () => {
    for (const t of TEMPLATES) {
      const files = filesOf(t.id);
      expect(files.get("README.md"), t.id).toMatch(/^# Robin Shop\n/);
      expect(files.has(".gitignore"), t.id).toBe(true);
      const agents = files.get("AGENTS.md") ?? "";
      for (const tool of ["gitring_intents", "gitring_declare", "gitring_ack", "gitring_check", "gitring_submit"]) expect(agents, `${t.id}: ${tool}`).toContain(tool);
      expect(agents).toContain('import { test, expect } from "../harness/test.js";');
    }
  });

  it("names the package after the project", () => {
    expect(packageName("Robin Shop!")).toBe("robin-shop");
    expect(packageName("***")).toBe("project");
    expect(JSON.parse(filesOf("js-library").get("package.json")!).name).toBe("robin-shop");
    expect(JSON.parse(filesOf("worker-api").get("wrangler.jsonc")!).main).toBe("src/index.js");
  });

  it("escapes the name in the HTML of the static site", () => {
    expect(filesOf("static-site", "<b>Robin</b>").get("index.html")).toContain("<title>&lt;b&gt;Robin&lt;/b&gt;</title>");
  });

  for (const t of TEMPLATES) {
    it(`${t.id}: passes its own tests in the gitring test runner`, async () => {
      const files = filesOf(t.id);
      const testPaths = [...files.keys()].filter((p) => /^tests\/.+\.test\.(js|mjs)$/.test(p)).sort();
      const run = await runChecks(loader, await contentKey(files), { files, testPaths }, { timeoutMs: 15_000 });
      expect(run.error, `${t.id}: ${run.error}`).toBeUndefined();
      expect(run.cases.filter((c) => !c.ok)).toEqual([]);
      expect(run.ok).toBe(true);
      // Templates with code have real tests: the first merge does not wait for a person ("no test ran").
      if (t.id === "empty") expect(run.ran).toBe(0);
      else expect(run.ran).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("pickTemplate", () => {
  it("finds the template that fits a description", () => {
    expect(pickTemplate("A JSON API for a todo list on Cloudflare Workers")).toBe("worker-api");
    expect(pickTemplate("A landing page for my bakery, with a small blog")).toBe("static-site");
    expect(pickTemplate("A library of date helpers for npm")).toBe("js-library");
  });

  it("starts empty for another language or a description with no sign", () => {
    expect(pickTemplate("A Python API with Flask")).toBe("empty");
    expect(pickTemplate("Something new")).toBe("empty");
    expect(pickTemplate("")).toBe("empty");
  });
});
