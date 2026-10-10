/**
 * GitHub settings (security review, findings 3 and 8):
 *   - a change that makes gitring push somewhere else (the mode, the branch, the base) needs the push
 *     rights of the person who makes it, and that person becomes the one whose rights gitring re-checks;
 *   - a person who leaves the project is no longer that person: sync stops until an owner saves the
 *     GitHub settings again;
 *   - branch names follow git's rules ("./main" is not a pull request branch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "./harness";

let world: World;
beforeEach(async () => {
  world = new World();
  vi.stubGlobal("fetch", world.fetch);
  await world.init();
});
afterEach(() => vi.unstubAllGlobals());

/** Alice (push rights) links robin/shop in pull-request mode; Bob is a co-owner without GitHub rights. */
async function twoOwners() {
  const alice = world.person("alice", 1);
  alice.access.set("robin/shop", { read: true, push: true });
  const bob = world.person("bob", 2);
  bob.access.set("robin/shop", null); // Bob cannot see the repository on GitHub at all.
  const made = await world.linkedProject("alice");
  expect((await world.call("POST", `/api/projects/${made.id}/members`, { key: made.key, body: { who: "bob", role: "owner" } })).status).toBe(200);
  const b = await world.signIn("bob");
  return { ...made, alice, bob, bobKey: b.key, bobId: b.userId };
}

describe("who may change where merged work goes", () => {
  it("refuses a mode change by an owner without push rights, and keeps the recorded person", async () => {
    const { id, bobKey, userId } = await twoOwners();
    const branch = await world.call("PUT", `/api/projects/${id}/settings`, { key: bobKey, body: { github: { branch: "other" } } });
    expect(branch.status).toBe(403);
    const mode = await world.call("PUT", `/api/projects/${id}/settings`, { key: bobKey, body: { github: { mode: "main" } } });
    expect(mode.status).toBe(403);
    expect(mode.json.error).toMatch(/cannot see robin\/shop/);
    const settings = await world.call("GET", `/api/projects/${id}/settings`, { key: bobKey });
    expect(settings.json.github.mode).toBe("pull-request");
    expect(world.ghState(id).actor?.userId).toBe(userId);
    // Nothing reaches GitHub main.
    await world.land(id, "evil.js", "steal()\n");
    const before = world.gh.refs.get("heads/main");
    const sync = await world.call("POST", `/api/projects/${id}/github/sync`, { key: bobKey });
    expect(sync.json.state).toBe("ok");
    expect(world.gh.refs.get("heads/main")).toBe(before);
    expect(world.gh.pulls).toHaveLength(1);
  });

  it("lets an owner with push rights change the mode, and makes them the recorded person", async () => {
    const { id, bob, bobKey, bobId, userId } = await twoOwners();
    bob.access.set("robin/shop", { read: true, push: true });
    expect(world.ghState(id).actor?.userId).toBe(userId);
    const mode = await world.call("PUT", `/api/projects/${id}/settings`, { key: bobKey, body: { github: { mode: "main" } } });
    expect(mode.status).toBe(200);
    expect(mode.json.github.mode).toBe("main");
    expect(world.ghState(id).actor?.userId).toBe(bobId);
    await world.settle();
    await world.land(id, "feature.js", "export const f = 1;\n");
    const sync = await world.call("POST", `/api/projects/${id}/github/sync`, { key: bobKey });
    expect(sync.json.state).toBe("ok");
    expect(world.gh.filesAt(world.gh.refs.get("heads/main")!)["feature.js"]).toBe("export const f = 1;\n");
  });

  it("stops the sync when the recorded person leaves the project, until an owner with rights saves the settings", async () => {
    const { id, key, bob, bobKey, bobId, userId } = await twoOwners();
    // Bob removes Alice (the person whose rights gitring checked).
    expect((await world.call("DELETE", `/api/projects/${id}/members/${userId}`, { key: bobKey })).status).toBe(200);
    expect(world.ghState(id).actor?.userId).toBe(userId);
    expect(world.ghState(id).actor?.gone).toMatch(/no longer a member/);
    expect((await world.call("GET", `/api/projects/${id}/github`, { key: bobKey })).json.state).toBe("error");
    await world.land(id, "feature.js", "export const f = 1;\n");
    const sync = await world.call("POST", `/api/projects/${id}/github/sync`, { key: bobKey });
    expect(sync.json.state).toBe("error");
    expect(sync.json.message).toMatch(/no longer a member of this project/);
    expect(world.gh.pulls).toHaveLength(0);
    // Alice's key no longer opens the project.
    expect((await world.call("GET", `/api/projects/${id}/settings`, { key })).status).toBe(404);
    // Bob saves the settings without GitHub rights: refused. With rights: he is the recorded person.
    const same = { github: { repo: "robin/shop", mode: "pull-request", branch: "gitring" } };
    expect((await world.call("PUT", `/api/projects/${id}/settings`, { key: bobKey, body: same })).status).toBe(403);
    bob.access.set("robin/shop", { read: true, push: true });
    expect((await world.call("PUT", `/api/projects/${id}/settings`, { key: bobKey, body: same })).status).toBe(200);
    expect(world.ghState(id).actor).toMatchObject({ userId: bobId, push: true });
    expect(world.ghState(id).actor?.gone).toBeUndefined();
    await world.settle();
    const again = await world.call("POST", `/api/projects/${id}/github/sync`, { key: bobKey });
    expect(again.json.state).toBe("ok");
    expect(world.gh.pulls).toHaveLength(1);
  });

  it("drops the recorded person when they become a viewer", async () => {
    const { id, bobKey, userId } = await twoOwners();
    expect((await world.call("POST", `/api/projects/${id}/members`, { key: bobKey, body: { who: "alice", role: "viewer" } })).status).toBe(200);
    expect(world.ghState(id).actor?.userId).toBe(userId);
    expect(world.ghState(id).actor?.gone).toMatch(/no longer a member/);
  });
});

describe("branch names", () => {
  it("refuses names that git refuses, so a pull request branch is never the base branch in disguise", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { id, key } = await world.linkedProject("alice");
    for (const branch of ["./main", "a/./b", "..", "a..b", "-x", "/x", "x/", "x.lock", "a//b", "x@{1}", "a b", "x~1", "x^", "x:y", "x?", "x*", "x[1]", "a\\b", ".hidden", "a/.b", "x."]) {
      const r = await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { github: { branch } } });
      expect(r.status, branch).toBe(400);
      expect(r.json.error, branch).toMatch(/branch name that git accepts/);
    }
    for (const base of ["./main", "main.lock"]) {
      expect((await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { github: { base } } })).status, base).toBe(400);
    }
    const ok = await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { github: { branch: "feature/v1.2-x" } } });
    expect(ok.status).toBe(200);
    expect(ok.json.github.branch).toBe("feature/v1.2-x");
    // GitHub main never moved: every sync went to the pull request branch.
    const main = world.gh.refs.get("heads/main");
    await world.settle();
    await world.land(id, "x.js", "x\n");
    world.gh.calls = [];
    await world.call("POST", `/api/projects/${id}/github/sync`, { key });
    expect(world.gh.calls).not.toContain("PATCH /git/refs/heads/main");
    expect(world.gh.refs.get("heads/main")).toBe(main);
    expect(world.gh.refs.has("heads/feature/v1.2-x")).toBe(true);
  });
});
