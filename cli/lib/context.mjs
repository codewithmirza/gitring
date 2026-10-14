/**
 * Builds ctx, the object that gives every command the outside world: environment, network, output, clock and processes.
 * Called by main() in cli/gitring.mjs. Tests give their own `io` to replace each part.
 * Never read process.env or write to the terminal anywhere else: go through ctx so that tests can see it.
 */
import { homedir } from "node:os";
import { configDir } from "./config.mjs";
import { plainText } from "./format.mjs";
import { openInBrowser, runCommand } from "./system.mjs";
import { openSocket } from "./websocket.mjs";

/**
 * `io` replaces the outside world in tests: env, fetch, out, err, configDir, sleep, now, run (child
 * processes), openUrl, connect (WebSocket) and watchRetries. Answers ctx. Every printed line goes through plainText.
 */
export function makeContext(io = {}) {
  const env = io.env ?? process.env;
  const ctx = {
    env,
    processEnv: io.processEnv ?? process.env,
    fetch: io.fetch ?? ((...a) => globalThis.fetch(...a)),
    out: (line) => (io.out ?? ((l) => process.stdout.write(`${l}\n`)))(plainText(line)),
    err: (line) => (io.err ?? ((l) => process.stderr.write(`${l}\n`)))(plainText(line)),
    configDir: io.configDir ?? configDir(env, process.platform, homedir()),
    sleep: io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: io.now ?? (() => Date.now()),
    run: io.run ?? runCommand,
    openUrl: io.openUrl ?? openInBrowser,
    connect: io.connect ?? openSocket,
    watchRetries: io.watchRetries ?? 8,
    flags: {},
  };
  return ctx;
}
