/** Test helpers: temp dirs and a hermetic git CLI runner (Node only). */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "bearing-git-"): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Environment that ignores the user's and system git config. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    ...extra,
  };
}

/** Run git; returns stdout as a Buffer. Throws with stderr on a non-zero exit. */
export function gitRaw(args: string[], opts: { cwd?: string; input?: string | Uint8Array; env?: Record<string, string> } = {}): Buffer {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    input: opts.input,
    env: gitEnv(opts.env),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Run git; returns trimmed stdout text. */
export function git(args: string[], opts: { cwd?: string; input?: string | Uint8Array; env?: Record<string, string> } = {}): string {
  return dec.decode(gitRaw(args, opts)).trim();
}

/**
 * Run git without blocking the event loop. Required when git talks to an HTTP server that lives
 * in this same process (a synchronous child would deadlock it).
 */
export function gitAsync(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: opts.cwd, env: gitEnv(opts.env), maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(String(stdout).trim());
    });
  });
}

export function hasGitHttpBackend(): boolean {
  try {
    const execPath = git(["--exec-path"]);
    execFileSync("test", ["-x", join(execPath, "git-http-backend")]);
    return true;
  } catch {
    return false;
  }
}

export const enc = new TextEncoder();
export const dec = new TextDecoder();
