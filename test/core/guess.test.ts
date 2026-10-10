/** Guesses of install and test commands from the files of a repository. */
import { describe, expect, it } from "vitest";
import { cleanCommand, guessChecks, projectNameOf, projectSlug } from "../../src/core/guess";

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
