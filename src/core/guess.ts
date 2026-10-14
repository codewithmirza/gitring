/**
 * Guess how a repository installs and tests itself, from its files: lockfiles, manifests and scripts.
 * Pure: the caller gives the file list and a reader, so any tree works (a GitHub repository, or main in
 * Cloudflare Artifacts after an import, an upload or a push). guessChecks uses rules only; guessTree also
 * asks a model (through a function that the caller gives) when the rules find no test command.
 *
 * Check containers run the Cloudflare Node.js 24 image (Debian). Other toolchains come from Debian
 * packages; the container reaches package registries only.
 */

export interface GuessInput {
  /** All file paths of the repository (or as many as the caller has). */
  paths: string[];
  /** Read a small file (package.json, pyproject.toml, …). Null when it is missing or too large. */
  read: (path: string) => Promise<string | null>;
}

export interface ChecksGuess {
  install?: string;
  test?: string;
  /** Main language or tool, for people ("Node.js (pnpm)", "Python", "Go", …). */
  stack?: string;
  /** One plain sentence per guess. */
  reasons: string[];
  /** The rules found a test command. */
  confident: boolean;
  /**
   * "worker": the gitring test runner fits (tests/*.test.js that import the gitring harness), with no
   * container and no install. Absent: a container runs the install and test commands.
   */
  runner?: "worker";
  /** A model gave the commands (guessTree): people check them. */
  guessed?: boolean;
}

/** npm writes this test script into a new package.json. It is not a test. */
const NPM_PLACEHOLDER = /no test specified/;

const APT = "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq";

export async function guessChecks(input: GuessInput): Promise<ChecksGuess> {
  const set = new Set(input.paths);
  const has = (p: string) => set.has(p);
  const reasons: string[] = [];
  const pkg = has("package.json") ? parseJson(await input.read("package.json")) : null;
  const scripts = (pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, string>;

  /* ───── the gitring test runner (gitring templates, and repositories that use its harness) ───── */
  if ((!scripts.test || NPM_PLACEHOLDER.test(scripts.test)) && (await usesHarness(input))) {
    reasons.push("tests/*.test.js import the gitring harness: the gitring test runner runs them, with no container and no install.");
    return { runner: "worker", stack: "JavaScript (gitring test runner)", reasons, confident: true };
  }

  /* ───── JavaScript / TypeScript ───── */
  if (has("package.json")) {
    const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) } as Record<string, string>;
    const pmField = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
    const pm = packageManager(pmField, has);
    let install: string;
    switch (pm.name) {
      case "pnpm":
        install = has("pnpm-lock.yaml") ? "corepack enable && pnpm install --frozen-lockfile" : "corepack enable && pnpm install";
        break;
      case "yarn":
        install = pm.berry ? "corepack enable && yarn install --immutable" : has("yarn.lock") ? "corepack enable && yarn install --frozen-lockfile" : "corepack enable && yarn install";
        break;
      case "bun":
        install = "npm install -g bun && bun install --frozen-lockfile";
        break;
      default:
        install = has("package-lock.json") || has("npm-shrinkwrap.json") ? "npm ci" : "npm install";
    }
    reasons.push(pm.reason);
    const run = (script: string) => (pm.name === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : pm.name === "bun" ? `bun run ${script}` : `${pm.name} ${script === "test" ? "test" : `run ${script}`}`);
    const ts = has("tsconfig.json") || "typescript" in deps;
    const stack = `${ts ? "TypeScript" : "JavaScript"} (${pm.name})`;
    if (scripts.test && !NPM_PLACEHOLDER.test(scripts.test)) {
      reasons.push(`Test command from package.json: scripts.test is "${clip(scripts.test)}".`);
      return { install, test: run("test"), stack, reasons, confident: true };
    }
    for (const name of ["test:unit", "test:ci", "tests", "check"]) {
      if (scripts[name]) {
        reasons.push(`Test command from package.json: scripts["${name}"].`);
        return { install, test: run(name), stack, reasons, confident: true };
      }
    }
    if ("vitest" in deps) {
      reasons.push("package.json has vitest but no test script: gitring runs vitest.");
      return { install, test: "npx vitest run", stack, reasons, confident: true };
    }
    if ("jest" in deps) {
      reasons.push("package.json has jest but no test script: gitring runs jest.");
      return { install, test: "npx jest --ci", stack, reasons, confident: true };
    }
    if (input.paths.some((p) => /(^|\/)[^/]+\.test\.(m?js|cjs)$/.test(p) && !p.includes("node_modules/"))) {
      reasons.push("No test script, but the repository has *.test.js files: gitring runs node --test.");
      return { install, test: "node --test", stack, reasons, confident: true };
    }
    if (scripts.build) {
      reasons.push("No test script. gitring runs the build as the check, so that merged code still builds.");
      return { install, test: run("build"), stack, reasons, confident: false };
    }
    reasons.push("package.json has no test script. Write the test command.");
    return { install, stack, reasons, confident: false };
  }

  /* ───── Deno ───── */
  if (has("deno.json") || has("deno.jsonc")) {
    reasons.push("deno.json: a Deno project.");
    return { install: "npm install -g deno", test: "deno test -A", stack: "Deno", reasons, confident: true };
  }

  /* ───── Python ───── */
  const pyproject = has("pyproject.toml") ? ((await input.read("pyproject.toml")) ?? "") : "";
  const requirements = ["requirements-dev.txt", "requirements_dev.txt", "requirements-test.txt", "requirements.txt"].filter(has);
  if (pyproject || requirements.length || has("setup.py") || has("setup.cfg") || has("Pipfile")) {
    const venv = `${APT} python3-venv python3-pip > /dev/null && python3 -m venv .venv`;
    const pip = ".venv/bin/pip install -q";
    const steps = [venv];
    if (requirements.length) {
      steps.push(`${pip} ${requirements.map((r) => `-r ${r}`).join(" ")}`);
      reasons.push(`Install from ${requirements.join(" and ")}.`);
    }
    const buildable = /\[build-system\]|\[project\]|\[tool\.poetry\]/.test(pyproject) || has("setup.py") || has("setup.cfg");
    if (buildable) {
      const optional = /\[project\.optional-dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(pyproject)?.[1] ?? "";
      const group = ["test", "tests", "testing", "dev"].find((g) => new RegExp(`^\\s*${g}\\s*=`, "m").test(optional));
      steps.push(`${pip} -e '.${group ? `[${group}]` : ""}'`);
      reasons.push(`Install the package itself${group ? ` with its "${group}" extras` : ""} (pyproject.toml or setup.py).`);
    }
    const all = `${pyproject}\n${(await Promise.all(requirements.map((r) => input.read(r)))).join("\n")}`;
    const pytest = /\bpytest\b/i.test(all) || has("pytest.ini") || has("conftest.py") || input.paths.some((p) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(p));
    if (pytest) {
      if (!/\bpytest\b/i.test(all)) steps.push(`${pip} pytest`);
      reasons.push("pytest finds the tests (test_*.py files or a pytest setting).");
      return { install: steps.join(" && "), test: ".venv/bin/python -m pytest -q", stack: "Python", reasons, confident: true };
    }
    if (input.paths.some((p) => /(^|\/)tests?\/[^/]+\.py$/.test(p))) {
      reasons.push("A tests folder without pytest: gitring runs unittest.");
      return { install: steps.join(" && "), test: ".venv/bin/python -m unittest discover -v", stack: "Python", reasons, confident: true };
    }
    reasons.push("No Python tests found. Write the test command.");
    return { install: steps.join(" && "), stack: "Python", reasons, confident: false };
  }

  /* ───── Go ───── */
  if (has("go.mod")) {
    reasons.push("go.mod: a Go module. Go comes from Debian; a newer Go in go.mod downloads itself.");
    return { install: `${APT} golang-go git > /dev/null && go mod download`, test: "go test ./...", stack: "Go", reasons, confident: true };
  }

  /* ───── Rust ───── */
  if (has("Cargo.toml")) {
    reasons.push("Cargo.toml: a Rust crate. Cargo comes from Debian.");
    return { install: `${APT} cargo > /dev/null && cargo fetch`, test: "cargo test", stack: "Rust", reasons, confident: true };
  }

  /* ───── Ruby ───── */
  if (has("Gemfile")) {
    const rspec = input.paths.some((p) => p.startsWith("spec/"));
    reasons.push(`Gemfile: a Ruby project; ${rspec ? "spec/ uses RSpec" : "gitring runs rake test"}.`);
    return { install: `${APT} ruby-full ruby-bundler build-essential > /dev/null && bundle install`, test: rspec ? "bundle exec rspec" : "bundle exec rake test", stack: "Ruby", reasons, confident: true };
  }

  /* ───── Java / Kotlin ───── */
  if (has("pom.xml")) {
    reasons.push("pom.xml: a Maven project.");
    return { install: `${APT} default-jdk-headless maven > /dev/null`, test: has("mvnw") ? "./mvnw -q -B test" : "mvn -q -B test", stack: "Java (Maven)", reasons, confident: true };
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    reasons.push("build.gradle: a Gradle project.");
    return { install: `${APT} default-jdk-headless > /dev/null`, test: has("gradlew") ? "./gradlew test --no-daemon" : "gradle test --no-daemon", stack: "Java (Gradle)", reasons, confident: has("gradlew") };
  }

  /* ───── Make ───── */
  if (has("Makefile")) {
    const mk = (await input.read("Makefile")) ?? "";
    if (/^test\s*:/m.test(mk)) {
      reasons.push("The Makefile has a test target.");
      return { install: undefined, test: "make test", stack: "Make", reasons, confident: true };
    }
  }

  reasons.push("gitring found no manifest that it knows. Write the install and test commands.");
  return { reasons, confident: false };
}

/** Test files of the gitring test runner: tests/*.test.js that import "../harness/test.js" (gitring adds the file). */
async function usesHarness(input: GuessInput): Promise<boolean> {
  const tests = input.paths.filter((p) => /^tests\/.+\.test\.m?js$/.test(p)).sort().slice(0, 5);
  for (const path of tests) {
    if (/from\s+["'](\.\.\/)+harness\/test\.js["']/.test((await input.read(path)) ?? "")) return true;
  }
  return false;
}

function packageManager(field: string, has: (p: string) => boolean): { name: "npm" | "pnpm" | "yarn" | "bun"; berry?: boolean; reason: string } {
  const m = /^(npm|pnpm|yarn|bun)@(\d+)/.exec(field);
  if (m) {
    const name = m[1] as "npm" | "pnpm" | "yarn" | "bun";
    return { name, berry: name === "yarn" && Number(m[2]) >= 2, reason: `package.json says packageManager "${clip(field)}".` };
  }
  if (has("pnpm-lock.yaml")) return { name: "pnpm", reason: "pnpm-lock.yaml: pnpm installs the dependencies." };
  if (has("yarn.lock")) return { name: "yarn", berry: has(".yarnrc.yml"), reason: "yarn.lock: yarn installs the dependencies." };
  if (has("bun.lock") || has("bun.lockb")) return { name: "bun", reason: "bun.lock: bun installs the dependencies." };
  if (has("package-lock.json")) return { name: "npm", reason: "package-lock.json: npm ci installs the exact versions." };
  return { name: "npm", reason: "No lockfile: npm install." };
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clip(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** A project name from a repository or folder name: as it is, at most 80 characters. */
export function projectNameOf(raw: string): string {
  const base = raw.split("/").pop() ?? raw;
  return base.replace(/\.git$/, "").trim().slice(0, 80) || "project";
}

/** The slug that project ids start with (lowercase letters, digits and dashes). */
export function projectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "project";
}

/** Commands from a model are checked before people see them: one line, no control characters, short. */
export function cleanCommand(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s.length > 300 || /[\r\n\0]/.test(s)) return undefined;
  return s;
}

/* ───────────── a model for the cases that the rules do not know ───────────── */

/** The model that guesses the commands when the rules find none (small, fast, a large context). */
export const GUESS_MODEL = "@cf/zai-org/glm-5.3-flash";

export interface GuessMessage {
  role: "system" | "user";
  content: string;
}

/** Ask the model; the answer is its text, or null when it did not answer. */
export type AskModel = (messages: GuessMessage[]) => Promise<string | null>;

/** The README of a tree (root only), if it has one. */
export function readmeOf(paths: string[]): string | undefined {
  return paths.find((p) => /^readme(\.md|\.rst|\.txt)?$/i.test(p));
}

/** What the model reads: the name, the file list (at most 300 paths) and the start of the README. */
export function guessMessages(label: string, paths: string[], readme: string): GuessMessage[] {
  return [
    {
      role: "system",
      content:
        'You read a repository and answer how a CI machine installs its dependencies and runs its tests. The machine runs Debian with Node.js 24; other tools come from apt-get. Answer JSON only: {"install": "<one shell line or empty>", "test": "<one shell line>", "why": "<at most 12 words>"}. If you cannot tell, answer {"test": ""}.',
    },
    { role: "user", content: `Repository ${label}.\nFiles:\n${paths.slice(0, 300).join("\n")}\n\nREADME:\n${readme.slice(0, 6000)}` },
  ];
}

/** The commands in a model answer, checked (cleanCommand). Null when the answer has no test command. */
export function parseModelGuess(text: string | null | undefined): { install?: string; test: string; why?: string } | null {
  const m = /\{[\s\S]*\}/.exec(text ?? "");
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const test = cleanCommand(o.test);
    if (!test) return null;
    const install = cleanCommand(o.install);
    return { test, ...(install ? { install } : {}), ...(typeof o.why === "string" && o.why.trim() ? { why: o.why.trim().slice(0, 80) } : {}) };
  } catch {
    return null;
  }
}

/**
 * The guess for any tree: the rules first; when they find no test command and `ask` is given, a model
 * reads the README and the file list. A failed model call keeps the guess of the rules.
 */
export async function guessTree(input: GuessInput & { label: string; ask?: AskModel }): Promise<ChecksGuess> {
  const rules = await guessChecks(input);
  if (rules.confident || !input.ask) return rules;
  const readme = readmeOf(input.paths);
  const text = readme ? ((await input.read(readme).catch(() => null)) ?? "") : "";
  const answer = parseModelGuess(await input.ask(guessMessages(input.label, input.paths, text)).catch(() => null));
  if (!answer) return rules;
  return {
    ...rules,
    install: answer.install ?? rules.install,
    test: answer.test,
    guessed: true,
    reasons: [...rules.reasons, `Guess: a model read the README and the file list${answer.why ? ` (${answer.why})` : ""}. Check the commands.`],
  };
}
