/**
 * Runs gitring on your computer, so that you need no Cloudflare account (npm run dev:local).
 * It builds the test version of Artifacts (real git, in tmp/local) and starts it. Then it starts `wrangler dev`.
 * wrangler dev uses wrangler.local.jsonc (or the file in LOCAL_CONFIG) and new random keys. Each start deletes the earlier data.
 * Never reuse the key that it prints outside this run. Read next: local/worker.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, "tmp", "local");
const artifactsPort = process.env.LOCAL_ARTIFACTS_PORT || "8792";
const wranglerArgs = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) fail("This run needs git. Install git and start again.");
const { build } = await import("esbuild").catch(() => fail("Run npm install first."));

rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "repos"), { recursive: true });
await build({
  entryPoints: [join(root, "test", "workers", "emulator", "fake-artifacts-server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(work, "artifacts-server.mjs"),
  logLevel: "warning",
});

const children = [];
function stop(code) {
  for (const child of children) child.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const artifacts = spawn(process.execPath, [join(work, "artifacts-server.mjs"), join(work, "repos"), artifactsPort], { stdio: ["ignore", "pipe", "inherit"] });
children.push(artifacts);
artifacts.on("exit", (code) => {
  console.error("The test version of Artifacts stopped.");
  stop(code ?? 1);
});
await new Promise((resolve) => {
  artifacts.stdout.on("data", (chunk) => {
    if (String(chunk).includes("rpc on")) resolve();
  });
});

const key = randomBytes(24).toString("hex");
console.log("");
console.log(`gitring key for this run: ${key}`);
console.log("Send it as  Authorization: Bearer <key>  to /api and /mcp at the address that wrangler shows below.");
console.log("");

const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const wrangler = spawn(
  process.execPath,
  [
    wranglerBin,
    "dev",
    "--config",
    process.env.LOCAL_CONFIG || "wrangler.local.jsonc",
    "--persist-to",
    join(work, "state"),
    "--var",
    `GITRING_KEY:${key}`,
    "--var",
    `GITRING_SECRET:${randomBytes(32).toString("base64")}`,
    "--var",
    `GITRING_SETUP_TOKEN:${randomBytes(16).toString("hex")}`,
    "--var",
    "GITRING_OWNERS:github:local",
    "--var",
    `LOCAL_ARTIFACTS_URL:http://127.0.0.1:${artifactsPort}`,
    ...wranglerArgs,
  ],
  { cwd: root, stdio: "inherit" },
);
children.push(wrangler);
wrangler.on("exit", (code) => stop(code ?? 0));
