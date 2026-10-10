/**
 * Directory and GitHub (security review, findings 2 and 10):
 *   - the check of a person's rights through the app (no user token) says whether the repository is
 *     private, and a public repository counts as readable;
 *   - a GitHub disconnect is not undone by a token refresh in flight: the disconnect waits for it and
 *     revokes the token it made; a refresh that finishes after a disconnect keeps nothing.
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

describe("githubPermission without the person's token", () => {
  it("answers whether the repository is private, from the app's view", async () => {
    const alice = world.person("alice", 1);
    alice.tokenWorks = false;
    const { userId } = await world.signIn("alice");
    // A public repository: readable, also for a person who is no collaborator.
    let perm = await world.dir.githubPermission(userId, "robin/shop");
    expect(perm).toMatchObject({ installed: true, read: true, push: false, private: false });
    // The same person on the private repository: no.
    world.gh.private_ = true;
    perm = await world.dir.githubPermission(userId, "robin/shop");
    expect(perm).toMatchObject({ installed: true, read: false, push: false, private: true });
    // A collaborator with push rights.
    alice.access.set("robin/shop", { read: true, push: true });
    perm = await world.dir.githubPermission(userId, "robin/shop");
    expect(perm).toMatchObject({ read: true, push: true, private: true });
    // The app cannot read the repository info: privacy stays unknown.
    world.gh.failInfo = 503;
    perm = await world.dir.githubPermission(userId, "robin/shop");
    expect(perm.private).toBeUndefined();
    expect(perm).toMatchObject({ read: true, push: true });
  });
});

describe("a GitHub disconnect during a token refresh", () => {
  it("waits for the refresh and revokes the token it made", async () => {
    world.person("alice", 1);
    const { userId } = await world.signIn("alice");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    world.onRefresh = () => gate;
    // A Worker saw GitHub refuse the token (401) and asks for a fresh one: the refresh is in flight.
    const refreshing = world.dir.githubUserToken(userId, "gho_alice");
    await new Promise((r) => setTimeout(r, 20));
    // The person disconnects GitHub meanwhile: the disconnect waits for the refresh.
    let disconnected = false;
    const disconnecting = world.dir.githubDisconnect(userId).then(() => (disconnected = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(disconnected).toBe(false);
    release();
    const res = await refreshing;
    await disconnecting;
    expect(res.ok).toBe(true);
    expect((await world.dir.githubConnection(userId)).connected).toBe(false);
    const again = await world.dir.githubUserToken(userId);
    expect(again.ok).toBe(false);
    // The refreshed token was revoked at GitHub.
    const revoked = world.fetchLog.filter((l) => l.startsWith("DELETE /applications/"));
    expect(revoked).toHaveLength(1);
  });

  it("keeps nothing from a refresh that finishes after the token was replaced", async () => {
    world.person("alice", 1);
    const { userId } = await world.signIn("alice");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    world.onRefresh = async () => {
      // While GitHub makes the new token, the person signs in again (a new token is stored).
      world.onRefresh = undefined;
      await world.signIn("alice");
      await gate;
    };
    const refreshing = world.dir.githubUserToken(userId, "gho_alice");
    await new Promise((r) => setTimeout(r, 20));
    release();
    const res = await refreshing;
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ state: "expired" });
    expect(world.fetchLog.filter((l) => l.startsWith("DELETE /applications/"))).toHaveLength(1);
    // The sign-in's token stands.
    expect((await world.dir.githubConnection(userId)).connected).toBe(true);
    expect((await world.dir.githubUserToken(userId)).ok).toBe(true);
  });
});
