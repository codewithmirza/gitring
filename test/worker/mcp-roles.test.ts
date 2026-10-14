/**
 * MCP tools check the role of the caller on a project with the same isolate cache as REST (15 s): a burst of
 * tool calls asks the Directory once, and a role change through REST reaches the MCP tools at once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { World } from "../harbor/world";
import { ROLE_TTL_MS } from "../../src/worker/roles";

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

describe("MCP role checks", () => {
  it("ask the Directory once per person and project, and see a REST role change at once", async () => {
    const world = new World();
    worlds.push(world);
    await world.init();
    const robin = await world.signIn("robin", 1);
    const kim = await world.signIn("kim", 2);
    const p = await world.createProject(robin.key, "books", { "src/a.js": "export const a = 1;\n" });
    expect((await world.call("POST", `/api/projects/${p.id}/members`, { key: robin.key, body: { who: "kim", role: "member" } })).status).toBe(200);

    const dir = world.dir as unknown as { role: (project: string, user: string | null) => Promise<unknown> };
    const real = dir.role.bind(dir);
    const asked: string[] = [];
    dir.role = async (project, user) => (asked.push(`${project}:${user}`), real(project, user));

    for (let i = 0; i < 3; i++) expect((await world.tool(kim.key, "gitring_intents", { project: p.id })).ok).toBe(true);
    expect(asked.filter((a) => a === `${p.id}:${kim.userId}`)).toHaveLength(1);
    expect(ROLE_TTL_MS).toBe(15_000);

    // The owner removes Kim through REST: the next tool call of Kim fails at once, not after 15 s.
    expect((await world.call("DELETE", `/api/projects/${p.id}/members/kim`, { key: robin.key })).status).toBe(200);
    const after = await world.tool(kim.key, "gitring_intents", { project: p.id });
    expect(after.ok).toBe(false);
    expect(after.text).toMatch(/no access/);
  });
});
