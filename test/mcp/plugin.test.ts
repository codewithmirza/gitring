/**
 * The Claude Code plugin and marketplace in this repository (.claude-plugin/marketplace.json and
 * plugins/gitring): the files fit together, the skill uses plain words and names real tools, no deployment
 * address is written into a file, and the hook sends the right request and never blocks the agent.
 * (`claude plugin validate` checks the format of the same files.)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GITRING_TOOLS } from "../../src/worker/mcp";
import { steViolations } from "../coord/ste";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN = join(ROOT, "plugins/gitring");
const HOOK = join(PLUGIN, "hooks/gitring-hook.sh");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("marketplace", () => {
  const market = json(join(ROOT, ".claude-plugin/marketplace.json"));
  const manifest = json(join(PLUGIN, ".claude-plugin/plugin.json"));

  it("lists one plugin, from a folder of this repository, under the name of its manifest", () => {
    expect(market.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(market.owner.name).toBeTruthy();
    expect(market.plugins).toHaveLength(1);
    const [entry] = market.plugins;
    expect(entry.source).toBe("./plugins/gitring");
    expect(existsSync(join(ROOT, entry.source, ".claude-plugin/plugin.json"))).toBe(true);
    expect(entry.name).toBe(manifest.name);
  });

  it("asks the user for the address of gitring, and keeps the API key secret", () => {
    expect(manifest.userConfig.gitring_url).toMatchObject({ type: "string", required: true });
    expect(manifest.userConfig.api_key.sensitive).toBe(true);
    // The hook needs the project and the key; the tools work with OAuth alone.
    expect(manifest.userConfig.project.required).not.toBe(true);
    expect(manifest.userConfig.api_key.required).not.toBe(true);
  });

  it("does not write a deployment address or an email address into any file", () => {
    const files = [...filesUnder(PLUGIN), join(ROOT, ".claude-plugin/marketplace.json")];
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const name = relative(ROOT, file);
      expect(text, name).not.toMatch(/(?<!<your-worker>\.)workers\.dev\b/);
      // No contact address of a person (a placeholder host is fine, an email address is not).
      expect(text, name).not.toMatch(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
      // A web address is allowed only as a placeholder.
      for (const m of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) expect(m[0], `${name}: ${m[0]}`).toMatch(/<your-worker>|example\.com/);
    }
  });
});

describe("MCP server of the plugin", () => {
  it("is gitring over streamable HTTP, at the address from the user's settings", () => {
    const mcp = json(join(PLUGIN, ".mcp.json"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["gitring"]);
    expect(mcp.mcpServers.gitring).toEqual({ type: "http", url: "${user_config.gitring_url}/mcp" });
  });
});

describe("skill", () => {
  const raw = readFileSync(join(PLUGIN, "skills/gitring/SKILL.md"), "utf8");
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const front = Object.fromEntries((parts?.[1] ?? "").split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  const body = parts?.[2] ?? "";

  it("has a name and a description inside the limits of the Agent Skills format", () => {
    expect(parts).not.toBeNull();
    expect(front.name).toBe("gitring");
    expect(front.name.length).toBeLessThanOrEqual(64);
    expect(front.description.length).toBeGreaterThan(40);
    expect(front.description.length).toBeLessThanOrEqual(1024);
  });

  it("teaches the whole loop, with real tool names", () => {
    const known = new Set(GITRING_TOOLS.map((t) => t.name));
    const mentioned = new Set([...body.matchAll(/`(gitring_[a-z]+)`/g)].map((m) => m[1]));
    for (const name of ["gitring_intents", "gitring_declare", "gitring_ack", "gitring_check", "gitring_submit"]) expect(mentioned.has(name), name).toBe(true);
    for (const name of mentioned) expect(known.has(name), `${name} is not a gitring tool`).toBe(true);
    expect(body).toMatch(/GitHub pull request/);
    expect(body).toMatch(/GITRING CHANGE REQUEST/);
  });

  it("uses plain words (ASD-STE100: short sentences, no -ing forms)", () => {
    const prose = (front.description + "\n" + body.replace(/```[\s\S]*?```/g, " ")).replace(/`[^`]*`/g, (code) => code.replace(/\s+/g, "_"));
    expect(steViolations(prose.replace(/\n+/g, " "))).toEqual([]);
  });
});

describe("hook", () => {
  const hooks = json(join(PLUGIN, "hooks/hooks.json"));

  it("runs after Write, Edit and MultiEdit, through a script that the plugin carries", () => {
    const [group] = hooks.hooks.PostToolUse;
    expect(group.matcher).toBe("Write|Edit|MultiEdit");
    expect(group.hooks).toHaveLength(1);
    expect(group.hooks[0].type).toBe("command");
    expect(group.hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/gitring-hook.sh");
    // Shell form: it must not use ${user_config.*} (Claude Code refuses that); it reads CLAUDE_PLUGIN_OPTION_* instead.
    expect(group.hooks[0].command).not.toContain("user_config");
    // Windows file systems have no exec bit: there, the mode that git records is the one that ships.
    if (process.platform === "win32") expect(execFileSync("git", ["ls-files", "-s", relative(ROOT, HOOK).replaceAll("\\", "/")], { cwd: ROOT, encoding: "utf8" })).toMatch(/^100755 /);
    else expect(statSync(HOOK).mode & 0o111).not.toBe(0);
  });

  /** A local stand-in for gitring: records each request, answers with `reply`. */
  async function withServer<T>(reply: string, run: (url: string, seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[]) => Promise<T>): Promise<T> {
    const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        res.setHeader("content-type", "application/json");
        res.end(reply);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      return await run(`http://127.0.0.1:${port}`, seen);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  function runHook(env: Record<string, string>, stdin: string, path = process.env.PATH ?? ""): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      // Only what the hook reads: no key from the real environment leaks into the test.
      const child = spawn("sh", [HOOK], { env: { PATH: path, HOME: tmpdir(), ...env } });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      // A hook that has nothing to do exits before it reads its input: that is fine.
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
      child.on("close", (code) => resolve({ code, out }));
    });
  }

  const hasCurl = spawnCheck("curl");
  function spawnCheck(cmd: string): boolean {
    return (process.env.PATH ?? "").split(":").some((dir) => existsSync(join(dir, cmd)));
  }
  const event = JSON.stringify({ session_id: "s1", cwd: "/work/shop", tool_name: "Edit", tool_input: { file_path: "/work/shop/a.txt", old_string: "a", new_string: "b" } });

  it.skipIf(!hasCurl)("posts the event to /hooks/claude/<project> with the key, and prints the answer", async () => {
    const reply = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "GITRING CHANGE REQUEST" } });
    await withServer(reply, async (url, seen) => {
      const res = await runHook({ CLAUDE_PLUGIN_OPTION_GITRING_URL: `${url}/`, CLAUDE_PLUGIN_OPTION_PROJECT: "shop", CLAUDE_PLUGIN_OPTION_API_KEY: "gk_test-key" }, event);
      expect(res.code).toBe(0);
      expect(JSON.parse(res.out)).toEqual(JSON.parse(reply));
      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe("POST");
      expect(seen[0].url).toBe("/hooks/claude/shop");
      expect(seen[0].headers.authorization).toBe("Bearer gk_test-key");
      expect(seen[0].headers["content-type"]).toBe("application/json");
      expect(seen[0].body).toBe(event);
    });
  });

  it.skipIf(!hasCurl)("lets the environment variables take precedence over the plugin settings", async () => {
    await withServer("{}", async (url, seen) => {
      const res = await runHook(
        { GITRING_URL: url, GITRING_PROJECT: "mine", GITRING_KEY: "gk_env", CLAUDE_PLUGIN_OPTION_GITRING_URL: "http://127.0.0.1:1", CLAUDE_PLUGIN_OPTION_PROJECT: "other", CLAUDE_PLUGIN_OPTION_API_KEY: "gk_plugin" },
        event,
      );
      expect(res.code).toBe(0);
      expect(seen.map((s) => [s.url, s.headers.authorization])).toEqual([["/hooks/claude/mine", "Bearer gk_env"]]);
    });
  });

  it.skipIf(!hasCurl)("does nothing, and does not fail, without an address, a project or a key", async () => {
    await withServer("{}", async (url, seen) => {
      const cases: Record<string, string>[] = [{}, { GITRING_URL: url }, { GITRING_URL: url, GITRING_PROJECT: "shop" }, { GITRING_PROJECT: "shop", GITRING_KEY: "gk_x" }];
      for (const env of cases) {
        const res = await runHook(env, event);
        expect(res).toEqual({ code: 0, out: "" });
      }
      expect(seen).toEqual([]);
    });
  });

  it.skipIf(!hasCurl)("does not fail and prints nothing when gitring cannot be reached", async () => {
    const res = await runHook({ GITRING_URL: "http://127.0.0.1:1", GITRING_PROJECT: "shop", GITRING_KEY: "gk_x" }, event);
    expect(res).toEqual({ code: 0, out: "" });
  });

  it("keeps the key out of the command line of curl", async () => {
    // A stand-in for curl that records its arguments.
    const dir = mkdtempSync(join(tmpdir(), "gitring-hook-"));
    const args = join(dir, "args.txt");
    const fake = join(dir, "curl");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${args}"\ncat > /dev/null\necho '{}'\n`);
    chmodSync(fake, 0o755);
    const res = await runHook({ GITRING_URL: "https://gitring.example.com", GITRING_PROJECT: "shop", GITRING_KEY: "gk_secret-value" }, event, `${dir}:${process.env.PATH ?? ""}`);
    expect(res).toEqual({ code: 0, out: "{}\n" });
    const recorded = readFileSync(args, "utf8");
    expect(recorded).toContain("https://gitring.example.com/hooks/claude/shop");
    expect(recorded).not.toContain("gk_secret-value");
  });
});
