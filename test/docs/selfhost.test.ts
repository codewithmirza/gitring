/**
 * The pages for a stranger who clones the repository: the self-host guide, the page for judges, the
 * contributing and security pages. They keep plain words (ASD-STE100), and the files that make the repository
 * safe to share stay in place: the license, the example variables, and the ignore rules.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { steViolations } from "../coord/ste";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(root(p), "utf8");

const NOT_VERB_FORMS = new Set(["anything", "binding", "bring", "Bring", "during", "everything", "Merging", "nothing", "something", "string", "thing", "Setting", "setting"]);

function units(markdown: string): string[] {
  const text = markdown
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/`[^`\n]*`/g, (code) => `_${code.slice(1, -1).replace(/\s+/g, "_")}`)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "");
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^\|\s*-+\s*(\|\s*-+\s*)*\|?$/.test(line)) continue;
    if (line.startsWith("|")) {
      for (const cell of line.split("|").map((c) => c.trim()).filter(Boolean)) out.push(cell);
      continue;
    }
    out.push(line.replace(/^#+\s*/, "").replace(/^(?:[-*]|\d+\.)\s+/, ""));
  }
  return out;
}

const PAGES = ["docs/SELF-HOST.md", "docs/FAQ-JUDGES.md", "CONTRIBUTING.md", "SECURITY.md"];

describe("pages for a stranger", () => {
  for (const page of PAGES) {
    it(`${page} uses plain words`, () => {
      const found = units(read(page)).flatMap((u) =>
        steViolations(u).filter((p) => {
          const m = /^"-ing" form "([^"]+)"/.exec(p);
          return !(m && NOT_VERB_FORMS.has(m[1]));
        }),
      );
      expect(found).toEqual([]);
    });
  }

  it("has an MIT license and says so in package.json", () => {
    expect(read("LICENSE")).toMatch(/^MIT License/);
    expect(JSON.parse(read("package.json")).license).toBe("MIT");
  });

  it("lists every secret of the README table in .dev.vars.example", () => {
    const example = read(".dev.vars.example");
    for (const name of ["GITRING_SECRET", "GITRING_SETUP_TOKEN", "GITRING_OWNERS", "GITRING_KEY", "GITRING_CONTACT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "GITHUB_WEBHOOK_SECRET", "SLACK_SIGNING_SECRET"]) {
      expect(example, name).toContain(`${name}=`);
    }
  });

  it("ignores local secrets and private files", () => {
    const ignore = read(".gitignore");
    for (const entry of [".dev.vars", ".env", "private/", "*.pem"]) expect(ignore, entry).toContain(entry);
  });

  it("tracks no secret file", () => {
    if (!existsSync(root(".git"))) return;
    let files: string[];
    try {
      files = execFileSync("git", ["ls-files"], { cwd: root("."), encoding: "utf8" }).split("\n");
    } catch {
      return;
    }
    const bad = files.filter((f) => /(^|\/)(\.dev\.vars|\.env(\..*)?|private\/.*)$/.test(f) && !f.endsWith(".example"));
    expect(bad).toEqual([]);
  });
});
