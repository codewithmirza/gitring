/**
 * The plain webhooks (/hooks/github with GITHUB_WEBHOOK_SECRET, /hooks/slack with SLACK_SIGNING_SECRET):
 * the shared secret alone aims at no project (the URL carries the project's key), a delivery opens one
 * task only, and a repository opens tasks only in its own project. Connect info for viewers.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hookKey } from "../../src/harbor/harbor";
import { World } from "./harness";

const GH_SECRET = "plain-hook-secret";
const SLACK_SECRET = "slack-signing-secret";

let world: World;
beforeEach(async () => {
  world = new World();
  vi.stubGlobal("fetch", world.fetch);
  await world.init({ GITHUB_WEBHOOK_SECRET: GH_SECRET, SLACK_SIGNING_SECRET: SLACK_SECRET });
});
afterEach(() => vi.unstubAllGlobals());

function issue(repo: string, n: number, isPrivate = false) {
  return {
    action: "labeled",
    label: { name: "gitring" },
    issue: { title: `Issue ${n}`, body: `Do thing ${n}`, number: n, labels: [{ name: "gitring" }], html_url: `https://github.com/${repo}/issues/${n}` },
    repository: { full_name: repo, private: isPrivate },
    sender: { login: "robin", id: 7 },
  };
}

async function githubHook(query: string, delivery: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const sig = createHmac("sha256", GH_SECRET).update(raw).digest("hex");
  return world.call("POST", `/hooks/github?${query}`, { raw, headers: { "x-github-event": "issues", "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${sig}`, "content-type": "application/json" } });
}

async function slackCommand(query: string, text: string, ts = Math.floor(Date.now() / 1000)) {
  const raw = new URLSearchParams({ text, user_name: "mira", team_id: "T1" }).toString();
  const sig = createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  return world.call("POST", `/hooks/slack?${query}`, { raw, headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${sig}`, "content-type": "application/x-www-form-urlencoded" } });
}

describe("plain GitHub webhook", () => {
  it("opens a task only with the project's key, once per delivery, and only for the project's own repository", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    const shop = await world.linkedProject("alice");
    const key = await hookKey(GH_SECRET, "github", shop.id);

    // The shared secret alone: refused.
    expect((await githubHook(`project=${shop.id}`, "d1", issue("robin/shop", 1))).status).toBe(401);
    expect((await githubHook(`project=${shop.id}&key=wrong`, "d1", issue("robin/shop", 1))).status).toBe(401);
    // Another project's key: refused (and the key of one project does not leak which other ids exist).
    expect((await githubHook(`project=other-project&key=${key}`, "d1", issue("robin/shop", 1))).status).toBe(401);

    const first = await githubHook(`project=${shop.id}&key=${key}`, "d1", issue("robin/shop", 1));
    expect(first.status).toBe(201);
    const again = await githubHook(`project=${shop.id}&key=${key}`, "d1", issue("robin/shop", 1));
    expect(again.status).toBe(200);
    expect(again.json.reason).toMatch(/handled before/);
    expect((await shop.h.state()).intents.filter((i) => i.source?.kind === "webhook")).toHaveLength(1);

    // A delivery from another repository, aimed at this project: refused.
    const foreign = await githubHook(`project=${shop.id}&key=${key}`, "d2", issue("mallory/evil", 2));
    expect(foreign.status).toBe(403);
    expect(foreign.json.error).toMatch(/not linked to mallory\/evil/);
    expect((await shop.h.state()).intents.filter((i) => i.source?.kind === "webhook")).toHaveLength(1);
  });

  it("keeps a private repository's issues out of a public project", async () => {
    world.person("alice", 1).access.set("robin/shop", { read: true, push: true });
    const shop = await world.linkedProject("alice", { repo: "robin/shop", mode: "off" }, "public");
    const key = await hookKey(GH_SECRET, "github", shop.id);
    const res = await githubHook(`project=${shop.id}&key=${key}`, "d3", issue("robin/shop", 3, true));
    expect(res.status).toBe(200);
    expect(res.json.reason).toMatch(/private on GitHub, and this project is public/);
    expect((await shop.h.state()).intents.filter((i) => i.source?.kind === "webhook")).toHaveLength(0);
  });
});

describe("Slack command", () => {
  it("needs the project's key and opens one task per signed request", async () => {
    world.person("alice", 1);
    const shop = await world.linkedProject("alice", { repo: "", mode: "off" });
    const key = await hookKey(SLACK_SECRET, "slack", shop.id);
    const noKey = await slackCommand(`project=${shop.id}`, "Add a dark mode — Readers can switch.");
    expect(noKey.status).toBe(200);
    expect(noKey.json.text).toMatch(/key in the command URL is not valid/);
    const ts = Math.floor(Date.now() / 1000);
    const ok = await slackCommand(`project=${shop.id}&key=${key}`, "Add a dark mode — Readers can switch.", ts);
    expect(ok.json.response_type).toBe("in_channel");
    expect(ok.json.text).toMatch(/Task opened/);
    const replay = await slackCommand(`project=${shop.id}&key=${key}`, "Add a dark mode — Readers can switch.", ts);
    expect(replay.json.text).toMatch(/already opened/);
    expect((await shop.h.state()).intents.filter((i) => i.source?.kind === "webhook")).toHaveLength(1);
  });
});

describe("connect info", () => {
  it("gives members the hook URLs with keys and the repository; viewers get the public addresses only", async () => {
    world.person("alice", 1);
    const shop = await world.linkedProject("alice", { repo: "", mode: "off" }, "public");
    const member = await world.call("GET", `/api/projects/${shop.id}/connect`, { key: shop.key });
    expect(member.status).toBe(200);
    expect(member.json.slackUrl).toContain(`/hooks/slack?project=${shop.id}&key=`);
    expect(member.json.githubHookUrl).toContain(`/hooks/github?project=${shop.id}&key=`);
    expect(member.json.artifacts.repo).toBeTruthy();
    const viewer = await world.call("GET", `/api/projects/${shop.id}/connect`);
    expect(viewer.status).toBe(200);
    expect(viewer.json.mcpUrl).toBe(member.json.mcpUrl);
    expect(viewer.json.slackUrl).toBeUndefined();
    expect(viewer.json.githubHookUrl).toBeUndefined();
    expect(viewer.json.artifacts).toEqual({ namespace: "", repo: "", backend: member.json.artifacts.backend });
  });
});
