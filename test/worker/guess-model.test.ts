/**
 * The guess of the test command of a repository (when the rules find none): gitring asks GLM 5.3 Flash
 * (SHORT_JOB_MODEL), with little reasoning, through the real Worker route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../github/harness";
import { SHORT_JOB_MODEL } from "../../src/platform/ai/models";

let world: World;
let asked: { model: string; input: Record<string, unknown> }[];

/** A public repository of Robin with no test command that the rules know: a README and one Python file. */
async function notesRepo(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.github.com" || !url.pathname.startsWith("/repos/robin/notes")) return world.fetch(input, init);
  const path = url.pathname.slice("/repos/robin/notes".length);
  if (path === "") return Response.json({ full_name: "robin/notes", private: false, default_branch: "main", html_url: "https://github.com/robin/notes", permissions: { pull: true, push: false } });
  if (path.startsWith("/git/trees/")) {
    return Response.json({ sha: "a".repeat(40), tree: [{ path: "README.md", type: "blob", size: 60 }, { path: "notes.py", type: "blob", size: 20 }] });
  }
  if (path === "/contents/README.md") return new Response("Robin's notes. Run the tests with pytest.");
  return Response.json({ message: "Not Found" }, { status: 404 });
}

beforeEach(async () => {
  world = new World();
  asked = [];
  vi.stubGlobal("fetch", notesRepo);
  const reply = '{"install": "pip install pytest", "test": "pytest", "why": "The README names pytest."}';
  await world.init({
    AI: {
      run: async (model: string, input: Record<string, unknown>) => {
        asked.push({ model, input });
        return { choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }] };
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the guess of the test command", () => {
  it("asks GLM 5.3 Flash with low reasoning when the rules find no test command", async () => {
    world.person("robin", 7);
    const { key } = await world.signIn("robin");
    const res = await world.call("GET", "/api/github/guess?repo=robin/notes", { key });
    expect(res.status).toBe(200);
    expect(SHORT_JOB_MODEL).toBe("@cf/zai-org/glm-5.3-flash");
    expect(asked.map((a) => a.model)).toEqual([SHORT_JOB_MODEL]);
    expect(asked[0].input).toMatchObject({ reasoning_effort: "low", response_format: { type: "json_object" } });
    expect(res.json.checks.test).toBe("pytest");
  });
});
