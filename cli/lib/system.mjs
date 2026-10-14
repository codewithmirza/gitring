/**
 * Starts programs outside gitring: the browser of the system, and child processes such as git.
 * Called through ctx.openUrl and ctx.run (see context.mjs). Tests replace both with fakes.
 * Never give these functions text that a person or a server wrote without a check (see safePage).
 */
import { spawn } from "node:child_process";

/** Open a page in the browser of the system. It never fails: when it cannot, the person opens the page. */
export function openInBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* the person opens the page */
  }
}

/** Run a child process with the terminal of this program. Answers the exit code (127 when it cannot start). */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
