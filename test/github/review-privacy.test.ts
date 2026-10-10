/**
 * Private GitHub code stays private (security review, findings 1 and 2):
 *   - a repository that turns private feeds code only to a person who can read it now (GitHub is asked
 *     on every pull of a private repository; the answer from link time does not count);
 *   - a project that holds private code stays private, also after an unlink or a relink;
 *   - an issue of a private repository goes only to private projects whose link holder reads it now;
 *   - a rate-limited read of a repository is not proof that it is public.
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

const pushEvent = (n: number) => world.hook("push", `p-${n}`, { ref: "refs/heads/main", repository: { full_name: "robin/shop", default_branch: "main" } });

describe("a repository that turns private", () => {
  it("stops feeding a project whose link holder cannot read it any more, from the first pull on", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    // The link is a year old: the last rights answer is far older than the daily re-check.
    const actor = world.ghState(id).actor!;
    world.setGhState(id, { actor: { ...actor, checkedAt: Date.now() - 400 * 24 * 3600_000 } });
    // The repository becomes private and the person who linked it loses access at the same time.
    world.gh.private_ = true;
    alice.access.set("robin/shop", null);
    world.gh.push({ "secret.txt": "internal\n" }, "Internal change");
    const before = world.fetchLog.length;
    const pulled = await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect(pulled.json.pull.state).toBe("error");
    expect(pulled.json.pull.message).toMatch(/can no longer read/);
    expect(await h.file("main", "secret.txt")).toBeNull();
    // GitHub was asked about the person before anything was merged.
    expect(world.fetchLog.slice(before).some((l) => l.includes("gho_alice"))).toBe(true);
    // The privacy flag follows what GitHub said.
    expect(world.ghState(id).private).toBe(true);
    const facts = await h.githubFacts();
    expect(facts.privateCode).toBe(false);
  });

  it("asks GitHub on every pull of a private repository, also minutes after a good answer", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    world.gh.private_ = true;
    world.gh.push({ "a.txt": "a\n" }, "One");
    const first = await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect(first.json.pull.state).toBe("merged");
    expect(await h.file("main", "a.txt")).toBe("a\n");
    // Minutes later alice loses access: the link-time answer (read: true) does not count.
    alice.access.set("robin/shop", null);
    world.gh.push({ "b.txt": "b\n" }, "Two");
    const second = await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect(second.json.pull.state).toBe("error");
    expect(second.json.pull.message).toMatch(/can no longer read/);
    expect(await h.file("main", "b.txt")).toBeNull();
  });

  it("does not let a stranger's project keep pulling a repository that its owner made private", async () => {
    world.person("sam", 7); // no entry for robin/shop: he can read it only while it is public
    const { id, h, mainSha } = await world.linkedProject("sam", { repo: "robin/shop" });
    // As after Sam's public import of robin/shop: main is GitHub's commit, the repository was public.
    world.setGhState(id, { last: mainSha, private: false });
    // Robin makes the repository private and pushes.
    world.gh.private_ = true;
    world.gh.push({ "embargo/fix.c": "/* CVE fix, private until disclosure */\n" }, "Security fix");
    expect((await pushEvent(1)).status).toBe(202);
    await world.settle();
    expect(await h.file("main", "embargo/fix.c")).toBeNull();
    expect(world.ghState(id).pull?.state).toBe("error");
    expect(world.ghState(id).pull?.message).toMatch(/can no longer read/);
    expect(world.ghState(id).private).toBe(true);
    // The next push: the same.
    world.gh.push({ "embargo/more.c": "/* more */\n" }, "More");
    await pushEvent(2);
    await world.settle();
    expect(await h.file("main", "embargo/more.c")).toBeNull();
  });

  it("refuses a pull into a public project", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice", { repo: "robin/shop", mode: "pull-request" }, "public");
    world.gh.private_ = true;
    world.gh.push({ "secret.txt": "internal\n" }, "Internal change");
    const pulled = await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect(pulled.json.pull.state).toBe("error");
    expect(pulled.json.pull.message).toMatch(/is private on GitHub, and this project is public/);
    expect(await h.file("main", "secret.txt")).toBeNull();
  });
});

describe("a project that holds private code", () => {
  async function pulledPrivateCode() {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const made = await world.linkedProject("alice");
    expect((await made.h.githubStatus()).state).toBe("ok");
    world.gh.private_ = true;
    world.gh.push({ "secret.txt": "API_KEY=hunter2\n" }, "Add secret");
    const pulled = await world.call("POST", `/api/projects/${made.id}/github/pull`, { key: made.key });
    await world.settle();
    expect(pulled.json.pull.state).toBe("merged");
    expect(await made.h.file("main", "secret.txt")).toBe("API_KEY=hunter2\n");
    return made;
  }

  it("stays private while linked, after an unlink, and after a relink to a public repository", async () => {
    const { id, key } = await pulledPrivateCode();
    const refused = () => world.call("PATCH", `/api/projects/${id}`, { key, body: { visibility: "public" } });
    let r = await refused();
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("This project holds code of a private GitHub repository. It stays private.");
    expect((await world.harbor(id).githubFacts()).privateCode).toBe(true);

    // Unlink: the flag stays.
    expect((await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { github: { repo: "" } } })).status).toBe(200);
    await world.settle();
    expect((await world.harbor(id).githubFacts())).toEqual({ privateCode: true });
    r = await refused();
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/stays private/);

    // Relink to the repository while it is public again: the flag stays.
    world.gh.private_ = false;
    expect((await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { github: { repo: "robin/shop", mode: "off" } } })).status).toBe(200);
    await world.settle();
    r = await refused();
    expect(r.status).toBe(400);

    // Nobody without a sign-in reads the file.
    const anon = await world.call("GET", `/api/projects/${id}/file?path=secret.txt`);
    expect(anon.status).toBe(401);
    expect((await world.call("GET", `/api/projects/${id}`, { key })).json.visibility).toBe("private");
  });

  it("holds the flag from a conflict task of a private repository too", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { id, key, h } = await world.linkedProject("alice");
    await world.land(id, "README.md", "# shop\n\nours\n");
    world.gh.private_ = true;
    world.gh.push({ "README.md": "# shop\n\ntheirs\n" }, "Theirs");
    const pulled = await world.call("POST", `/api/projects/${id}/github/pull`, { key });
    await world.settle();
    expect(pulled.json.pull.state).toBe("conflict");
    expect((await h.githubFacts()).privateCode).toBe(true);
    const r = await world.call("PATCH", `/api/projects/${id}`, { key, body: { visibility: "public" } });
    expect(r.status).toBe(400);
  });

  it("refuses to link a repository of unknown privacy to a public project", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: true });
    const { key } = await world.signIn("alice");
    const made = await world.call("POST", "/api/projects", { key, body: { name: "pub", visibility: "public", source: { kind: "empty" } } });
    const id = made.json.project.id as string;
    // The person's token does not work, and the app cannot read the repository info either.
    alice.tokenWorks = false;
    world.gh.failInfo = 503;
    const r = await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { github: { repo: "robin/shop" } } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/could not find out whether robin\/shop is private/);
    // With the info, a public repository links; a private one does not.
    world.gh.failInfo = 0;
    expect((await world.call("PUT", `/api/projects/${id}/settings`, { key, body: { github: { repo: "robin/shop" } } })).status).toBe(200);
    world.gh.private_ = true;
    const other = await world.call("POST", "/api/projects", { key, body: { name: "pub2", visibility: "public", source: { kind: "empty" } } });
    const r2 = await world.call("PUT", `/api/projects/${other.json.project.id}/settings`, { key, body: { github: { repo: "robin/shop" } } });
    expect(r2.status).toBe(400);
    expect(r2.json.error).toMatch(/is private on GitHub, and this project is public/);
  });
});

describe("issues of a private repository", () => {
  const labeled = (n: number, sender: { login: string; id: number }, isPrivate: boolean) => ({
    action: "labeled",
    issue: { title: "Embargoed: auth bypass in /login", body: "Repro: POST /login with ...", number: n, labels: [{ name: "gitring" }] },
    repository: { full_name: "robin/shop", private: isPrivate },
    sender,
  });

  it("go only to a project whose link holder can read the repository now", async () => {
    world.person("sam", 7);
    const { id, key } = await world.linkedProject("sam", { repo: "robin/shop" });
    // Sam invites Robin's login to his own project (a pending invite: Robin never accepts).
    expect((await world.call("POST", `/api/projects/${id}/members`, { key, body: { who: "robin", role: "member" } })).status).toBe(200);
    world.gh.private_ = true;
    const res = await world.hook("issues", "i-3", labeled(3, { login: "robin", id: 5 }, true));
    expect(res.status).toBe(200);
    expect(res.json.intents).toEqual([]);
    expect(res.json.refused).toEqual([expect.stringMatching(/can no longer read/)]);
    const st = await world.harbor(id).state();
    expect(st.intents.map((i: { goal: string }) => i.goal)).not.toContain("Repro: POST /login with ...");

    // A person who reads the repository gets the task, and the project holds private text from then on.
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: false });
    const mine = await world.linkedProject("alice", { repo: "robin/shop" });
    const ok = await world.hook("issues", "i-4", labeled(4, { login: "alice", id: 1 }, true));
    expect(ok.status).toBe(201);
    expect(ok.json.intents).toEqual([expect.stringMatching(new RegExp(`^${mine.id}/`))]);
    expect((await mine.h.githubFacts()).privateCode).toBe(true);
  });

  it("never become a task of a public project", async () => {
    const alice = world.person("alice", 1);
    alice.access.set("robin/shop", { read: true, push: false });
    const { id } = await world.linkedProject("alice", { repo: "robin/shop" }, "public");
    world.gh.private_ = true;
    const res = await world.hook("issues", "d-7", labeled(7, { login: "alice", id: 1 }, true));
    expect(res.status).toBe(200);
    expect(res.json.intents).toEqual([]);
    expect(res.json.refused).toEqual([expect.stringMatching(/this project is public/)]);
    const anon = await world.call("GET", `/api/projects/${id}/state`);
    expect(anon.status).toBe(200);
    expect(anon.json.intents).toEqual([]);
    // An issue of the public repository still becomes a task.
    world.gh.private_ = false;
    const ok = await world.hook("issues", "d-8", labeled(8, { login: "alice", id: 1 }, false));
    expect(ok.status).toBe(201);
  });
});

describe("a new project from a GitHub repository", () => {
  it("records no read right and no privacy when GitHub rate-limited the reads", async () => {
    world.person("alice", 1);
    const { key } = await world.signIn("alice");
    world.rateLimited.add("user").add("anon");
    const made = await world.call("POST", "/api/projects", { key, body: { name: "shop", source: { kind: "github", repo: "robin/shop" } } });
    expect(made.status).toBe(201);
    const id = made.json.project.id as string;
    // Artifacts imports the public URL (it fails for a private repository); no snapshot through the app.
    expect(made.json.state.project.importing.github.snapshot).toBe(false);
    expect(made.json.state.project.source.private).toBeUndefined();
    const st = world.ghState(id);
    expect(st.actor?.read).toBe(false);
    expect(st.private).toBeUndefined();
    expect(made.json.state.project.settings.github.mode).toBe("off");
  });

  it("refuses a private repository that the person's rate-limited token could not show", async () => {
    world.person("alice", 1);
    const { key } = await world.signIn("alice");
    world.rateLimited.add("user");
    world.gh.private_ = true;
    const made = await world.call("POST", "/api/projects", { key, body: { name: "shop", source: { kind: "github", repo: "robin/shop" } } });
    expect(made.status).toBe(404);
    expect(made.json.error).toMatch(/gitring cannot read robin\/shop/);
  });

  it("imports a public repository that the anonymous read confirmed", async () => {
    world.person("alice", 1);
    const { key } = await world.signIn("alice");
    world.rateLimited.add("user");
    const made = await world.call("POST", "/api/projects", { key, body: { name: "shop", source: { kind: "github", repo: "robin/shop" } } });
    expect(made.status).toBe(201);
    expect(made.json.state.project.source.private).toBe(false);
    expect(world.ghState(made.json.project.id).actor?.read).toBe(true);
  });
});
