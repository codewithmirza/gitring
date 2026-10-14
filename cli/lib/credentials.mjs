/**
 * Stores the sign-ins of the person in credentials.json of the config folder (mode 0600).
 * Called by session.mjs and the login, logout and whoami commands.
 * Never print a stored token. Never write the file in another way than writeCredentials does.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { CREDENTIALS_FILE } from "./constants.mjs";

// ───── The file ─────

function joinIn(dir, file) {
  return dir.includes("\\") && !dir.includes("/") ? win32.join(dir, file) : posix.join(dir.replace(/\\/g, "/"), file);
}

/** The stored sign-ins: one per server, and the server of the last sign-in. */
export function readCredentials(dir) {
  try {
    const raw = JSON.parse(readFileSync(joinIn(dir, CREDENTIALS_FILE), "utf8"));
    if (raw && raw.version === 1 && raw.servers && typeof raw.servers === "object") return { version: 1, current: raw.current ?? null, servers: raw.servers };
  } catch {
    /* no file, or a file that is not ours */
  }
  return { version: 1, current: null, servers: {} };
}

/** Write the sign-ins. Only the person can read the file (mode 0600, folder 0700). */
export function writeCredentials(dir, creds) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = joinIn(dir, CREDENTIALS_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// ───── Remember and forget one sign-in ─────

/** The stored form of an OAuth token answer: the two tokens, the time the access token ends, and the scope. */
export function tokensOf(ctx, t) {
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: ctx.now() + Number(t.expires_in ?? 3600) * 1000, scope: t.scope ?? "mcp" };
}

/** Store the sign-in of one server. It becomes the current server when `makeCurrent` is set, or when there is none. */
export function remember(ctx, origin, entry, makeCurrent = false) {
  const creds = readCredentials(ctx.configDir);
  creds.servers[origin] = entry;
  if (makeCurrent || !creds.current) creds.current = origin;
  writeCredentials(ctx.configDir, creds);
}

/** Delete the sign-in of one server. Answers false when there was none. */
export function forget(ctx, origin) {
  const creds = readCredentials(ctx.configDir);
  if (!creds.servers[origin]) return false;
  delete creds.servers[origin];
  if (creds.current === origin) creds.current = Object.keys(creds.servers)[0] ?? null;
  writeCredentials(ctx.configDir, creds);
  return true;
}
