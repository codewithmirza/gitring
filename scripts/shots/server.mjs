// Builds the app when it is old, starts the local gitring like `npm run dev:local`, and stops it again.
// Used by: scripts/shots.mjs. It must never print the key of the run: the key stays in memory (a log line hides it).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const START_TIMEOUT_MS = 180_000;

// ───── Build ─────

/** The newest change time (ms) of the files that the web build reads. */
function newestSource(root) {
  let newest = 0;
  const walk = (target) => {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "tmp") continue;
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  for (const folder of ["web", "public", path.join("src", "core")]) if (existsSync(path.join(root, folder))) walk(path.join(root, folder));
  for (const file of ["index.html", "vite.config.ts", "package.json"]) if (existsSync(path.join(root, file))) newest = Math.max(newest, statSync(path.join(root, file)).mtimeMs);
  return newest;
}

/** True when dist/client is missing or older than a source file. */
export function isBuildStale(root) {
  const built = path.join(root, "dist", "client", "index.html");
  return !existsSync(built) || statSync(built).mtimeMs < newestSource(root);
}

/** Runs `npx vite build`. It throws with the end of the output when the build fails. */
export function buildApp(root, say) {
  say("The app build is old or missing. Building it with vite.");
  const run = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`vite build failed:\n${String(run.stdout).slice(-1500)}${String(run.stderr).slice(-1500)}`);
}

// ───── Start and stop ─────

/** Asks the system for a free port on this computer. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Stops a process and all of its children (wrangler starts more processes than the one that we start). */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

/**
 * Starts `local/start.mjs` on free ports (the default ports may be busy: other agents run gitring too).
 * Resolves with { url, key, stop }. The address uses `localhost`, because passkeys need a host name.
 */
export async function startLocal(root, say) {
  const [app, artifacts, inspector] = [await freePort(), await freePort(), await freePort()];
  const child = spawn(process.execPath, [path.join(root, "local", "start.mjs"), "--port", String(app), "--inspector-port", String(inspector)], {
    cwd: root,
    env: { ...process.env, LOCAL_ARTIFACTS_PORT: String(artifacts) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let key = "";
  let log = "";
  let ready = false;
  const hide = (text) => (key ? text.split(key).join("[key]") : text);
  const onData = (chunk) => {
    log = (log + chunk).slice(-6000);
    key ||= /gitring key for this run: (\w+)/.exec(log)?.[1] ?? "";
    ready ||= /Ready on http:\/\/[\w.]+:\d+/.test(log);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const stop = () => killTree(child);
  process.once("exit", stop);
  // Ctrl-C and a stop signal do not run the exit handler. Without these two lines, wrangler would keep running.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(130));

  const started = Date.now();
  while (!(ready && key)) {
    if (child.exitCode !== null) throw new Error(`The local gitring stopped while it started:\n${hide(log).slice(-1500)}`);
    if (Date.now() - started > START_TIMEOUT_MS) {
      stop();
      throw new Error(`The local gitring did not start in ${START_TIMEOUT_MS / 1000} seconds:\n${hide(log).slice(-1500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const url = `http://localhost:${app}`;
  say(`The local gitring runs at ${url}`);
  return { url, key, stop };
}
