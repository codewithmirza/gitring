/** Guesses of install and test commands from the files of a repository. */
import { describe, expect, it } from "vitest";
import { cleanCommand, GUESS_MODEL, guessChecks, guessMessages, guessTree, parseModelGuess, projectNameOf, projectSlug, readmeOf, type GuessMessage } from "../../src/core/guess";
import { templateFiles } from "../../src/core/templates";
import { GUESS_CALL, guessModel } from "../../src/platform/ai/guess";

function repo(files: Record<string, string>) {
  return { paths: Object.keys(files), read: async (p: string) => files[p] ?? null };
}

describe("guessChecks", () => {
  it("npm with a lockfile and a test script", async () => {
    const g = await guessChecks(repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "package-lock.json": "{}" }));
    expect(g).toMatchObject({ install: "npm ci", test: "npm test", stack: "JavaScript (npm)", confident: true });
    expect(g.reasons.join(" ")).toMatch(/package-lock\.json/);
  });

  it("pnpm and yarn berry from packageManager, TypeScript from tsconfig", async () => {
    const pnpm = await guessChecks(repo({ "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0", scripts: { test: "jest" } }), "pnpm-lock.yaml": "", "tsconfig.json": "{}" }));
    expect(pnpm).toMatchObject({ install: "corepack enable && pnpm install --frozen-lockfile", test: "pnpm test", stack: "TypeScript (pnpm)" });
    const yarn = await guessChecks(repo({ "package.json": JSON.stringify({ packageManager: "yarn@4.2.0", scripts: { "test:unit": "x" } }), "yarn.lock": "" }));
    expect(yarn).toMatchObject({ install: "corepack enable && yarn install --immutable", test: "yarn run test:unit" });
    const classic = await guessChecks(repo({ "package.json": JSON.stringify({ scripts: { test: "x" } }), "yarn.lock": "" }));
    expect(classic.install).toBe("corepack enable && yarn install --frozen-lockfile");
  });

  it("ignores npm's placeholder test script and falls back to vitest, node --test or the build", async () => {
    const placeholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' }, devDependencies: { vitest: "^3" } });
    expect((await guessChecks(repo({ "package.json": placeholder }))).test).toBe("npx vitest run");
    const nodeTest = await guessChecks(repo({ "package.json": "{}", "tests/a.test.js": "" }));
    expect(nodeTest.test).toBe("node --test");
    const build = await guessChecks(repo({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) }));
    expect(build).toMatchObject({ test: "npm run build", confident: false });
    const none = await guessChecks(repo({ "package.json": "{}" }));
    expect(none.confident).toBe(false);
    expect(none.test).toBeUndefined();
  });

  it("Python with pytest and test extras", async () => {
    const g = await guessChecks(
      repo({
        "pyproject.toml": '[project]\nname = "x"\n\n[project.optional-dependencies]\ntest = ["pytest"]\n\n[build-system]\nrequires = ["hatchling"]\n',
        "tests/test_a.py": "",
      }),
    );
    expect(g.stack).toBe("Python");
    expect(g.install).toContain("python3 -m venv .venv");
    expect(g.install).toContain(".venv/bin/pip install -q -e '.[test]'");
    expect(g.test).toBe(".venv/bin/python -m pytest -q");
  });

  it("requirements.txt without pytest installs pytest when test files exist", async () => {
    const g = await guessChecks(repo({ "requirements.txt": "flask\n", "app/test_views.py": "" }));
    expect(g.install).toMatch(/-r requirements\.txt && \.venv\/bin\/pip install -q pytest$/);
    expect(g.test).toBe(".venv/bin/python -m pytest -q");
  });

  it("Go, Rust, Ruby, Java, Make", async () => {
    expect((await guessChecks(repo({ "go.mod": "module x" }))).test).toBe("go test ./...");
    expect((await guessChecks(repo({ "Cargo.toml": "" }))).test).toBe("cargo test");
    expect((await guessChecks(repo({ Gemfile: "", "spec/a_spec.rb": "" }))).test).toBe("bundle exec rspec");
    expect((await guessChecks(repo({ "pom.xml": "", mvnw: "" }))).test).toBe("./mvnw -q -B test");
    expect((await guessChecks(repo({ Makefile: "build:\n\tcc\ntest:\n\t./run\n" }))).test).toBe("make test");
  });

  it("says when it knows nothing", async () => {
    const g = await guessChecks(repo({ "notes.txt": "" }));
    expect(g).toMatchObject({ confident: false });
    expect(g.install).toBeUndefined();
  });
});

describe("names", () => {
  it("makes names and slugs from repository names", () => {
    expect(projectNameOf("robin/My-Shop.git")).toBe("My-Shop");
    expect(projectSlug("My Shop!")).toBe("my-shop");
    expect(projectSlug("???")).toBe("project");
  });

  it("checks model commands", () => {
    expect(cleanCommand(" npm test ")).toBe("npm test");
    expect(cleanCommand("a\nb")).toBeUndefined();
    expect(cleanCommand("x".repeat(400))).toBeUndefined();
    expect(cleanCommand(3)).toBeUndefined();
  });
});

describe("the gitring test runner", () => {
  const harnessTest = 'import { test, expect } from "../harness/test.js";\ntest("a", () => expect(1).toBe(1));\n';

  it("fits tests that import the gitring harness, with no container and no install", async () => {
    const g = await guessChecks(repo({ "package.json": JSON.stringify({ name: "x", type: "module" }), "src/index.js": "", "tests/index.test.js": harnessTest }));
    expect(g).toMatchObject({ runner: "worker", confident: true });
    expect(g.install).toBeUndefined();
    expect(g.test).toBeUndefined();
    // Every template with code is such a repository: a pushed copy of a template keeps its runner.
    for (const id of ["js-library", "worker-api", "static-site"] as const) {
      const files = Object.fromEntries(templateFiles(id, { name: "Robin" }).map((f) => [f.path, f.content]));
      expect((await guessChecks(repo(files))).runner, id).toBe("worker");
    }
  });

  it("keeps a real test script of package.json", async () => {
    const g = await guessChecks(repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "tests/index.test.js": harnessTest }));
    expect(g.runner).toBeUndefined();
    expect(g.test).toBe("npm test");
  });
});

describe("guessTree", () => {
  const unknown = { "README.md": "# Tool\n\nRun the tests with make check.\n", "src/main.c": "int main() {}\n" };

  it("asks the model with the README and the file list when the rules find no test command", async () => {
    let asked: GuessMessage[] = [];
    const g = await guessTree({
      ...repo(unknown),
      label: "robin/tool",
      ask: async (m) => {
        asked = m;
        return 'Here: {"install": "apt-get install -y make", "test": "make check", "why": "The README says make check."}';
      },
    });
    expect(g).toMatchObject({ install: "apt-get install -y make", test: "make check", guessed: true, confident: false });
    expect(g.reasons.at(-1)).toBe("Guess: a model read the README and the file list (The README says make check.). Check the commands.");
    expect(asked[1].content).toContain("Repository robin/tool.");
    expect(asked[1].content).toContain("src/main.c");
    expect(asked[1].content).toContain("Run the tests with make check.");
    expect(GUESS_MODEL).toBe("@cf/zai-org/glm-5.3-flash");
  });

  it("keeps the rules when the model has no answer, a bad answer or an error", async () => {
    for (const ask of [async () => null, async () => '{"test": "a\nb"}', async () => "no json", async () => Promise.reject(new Error("down"))]) {
      const g = await guessTree({ ...repo(unknown), label: "x", ask });
      expect(g.test).toBeUndefined();
      expect(g.guessed).toBeUndefined();
    }
  });

  it("does not ask the model when the rules know the answer", async () => {
    let calls = 0;
    const g = await guessTree({ ...repo({ "go.mod": "module x" }), label: "x", ask: async () => (calls++, null) });
    expect(g.test).toBe("go test ./...");
    expect(calls).toBe(0);
  });

  it("reads the commands of a model answer", () => {
    expect(parseModelGuess('{"test": " npm test ", "install": "", "why": " short "}')).toEqual({ test: "npm test", why: "short" });
    expect(parseModelGuess('{"test": ""}')).toBeNull();
    expect(parseModelGuess(null)).toBeNull();
    expect(readmeOf(["docs/README.md", "Readme.rst"])).toBe("Readme.rst");
    expect(guessMessages("x", ["a"], "")[0].content).toMatch(/Answer JSON only/);
  });

  it("asks GLM 5.3 Flash for a short answer, with a low reasoning effort and time for it", async () => {
    expect(GUESS_CALL).toMatchObject({ reasoning: "low", timeoutMs: 15_000, json: true, temperature: 0 });
    let model = "";
    const ask = guessModel({
      run: async (m: string) => {
        model = m;
        return { choices: [{ message: { content: '{"test": "make check"}' } }] };
      },
    })!;
    expect(await ask([{ role: "user", content: "Repository x." }])).toBe('{"test": "make check"}');
    expect(model).toBe("@cf/zai-org/glm-5.3-flash");
    expect(guessModel(undefined)).toBeUndefined();
  });
});
