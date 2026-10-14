/**
 * Decides which server to talk to and where the config folder is, on every system.
 * Called by session.mjs, the login and logout commands and context.mjs.
 * Never let a token go over plain http: serverOrigin allows http to this computer only.
 */
import { posix, win32 } from "node:path";
import { CliError } from "./errors.mjs";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** The origin of a server address. https, or http to this computer only (a token never goes over plain http). */
export function serverOrigin(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    throw new CliError("The server address is not a web address. Use https://your-gitring.example.com.", 2);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.test(u.hostname))) {
    throw new CliError("Use https in the server address. The command line uses http only for localhost.", 2);
  }
  return u.origin;
}

/** The config folder of the person: GITRING_CONFIG_DIR, else the place that the system uses for app settings. */
export function configDir(env, platform, home) {
  if (env.GITRING_CONFIG_DIR) return env.GITRING_CONFIG_DIR;
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "gitring");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "gitring");
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "gitring");
}
