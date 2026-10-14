#!/usr/bin/env node
/**
 * gitring: the command line for people who work with agents on gitring (plain Node 20 or later, no dependency).
 * npm links it as `gitring` (package.json, "bin"). The tests import main and the helpers from this file.
 * Never read the network or the config folder here. Each command in commands/ does it through ctx.
 * Read next: cli/README.md (the commands and where each lives), then commands/index.mjs.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "./commands/index.mjs";
import { parseArgs } from "./lib/args.mjs";
import { VERSION } from "./lib/constants.mjs";
import { makeContext } from "./lib/context.mjs";
import { CliError } from "./lib/errors.mjs";
import { USAGE } from "./lib/usage.mjs";

// ───── Public surface ─────
// Tests and cli/gitring.d.mts name these from here. Each one lives in its own file.

export { CLIENT_ID, CREDENTIALS_FILE, DEVICE_GRANT, MCP_VERSION, TOO_OLD, VERSION } from "./lib/constants.mjs";
export { USAGE } from "./lib/usage.mjs";
export { CliError } from "./lib/errors.mjs";
export { parseArgs } from "./lib/args.mjs";
export { configDir, serverOrigin } from "./lib/config.mjs";
export { readCredentials, writeCredentials } from "./lib/credentials.mjs";
export { isMissingTool, lastJson, rpcMessage, toolCallBody } from "./lib/mcp.mjs";
export { age, plainText, titleFrom } from "./lib/format.mjs";
export { safePage } from "./lib/device-grant.mjs";
export { openSocket, wsFrame, wsReadFrames } from "./lib/websocket.mjs";
export { gitAuthHeader } from "./commands/clone.mjs";

// ───── Run the command line ─────

/**
 * Run the command line. `io` replaces the outside world in tests: env, fetch, out, err, configDir, sleep,
 * now, run (child processes), openUrl, connect (WebSocket) and watchRetries. Answers the exit code.
 */
export async function main(argv, io = {}) {
  const ctx = makeContext(io);
  try {
    const { command, args, flags } = parseArgs(argv);
    ctx.flags = flags;
    if (command === "help") {
      for (const line of USAGE) ctx.out(line);
      return 0;
    }
    if (command === "version") {
      ctx.out(VERSION);
      return 0;
    }
    return (await COMMANDS[command](ctx, args)) ?? 0;
  } catch (e) {
    if (e instanceof CliError) {
      ctx.err(e.message);
      if (e.code === 2) ctx.err("Run gitring --help to see the commands.");
      return e.code;
    }
    ctx.err(`The command line stopped with an error: ${e?.message ?? e}`);
    return 1;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
