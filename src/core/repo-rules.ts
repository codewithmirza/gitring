/**
 * Rules for repositories that come from outside: which remotes gitring imports, and which files of
 * a tree it reads as text. Pure module (no platform APIs).
 */

/** An https git remote for Artifacts import: https only, no credentials, ".git" optional. */
export function normalizeGitUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Give an https URL of a git repository, for example https://github.com/owner/repo.");
  }
  if (u.protocol !== "https:") throw new Error("Use an https URL.");
  if (u.username || u.password) throw new Error("Do not put credentials in the URL.");
  if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(u.hostname) || /\.(local|internal)$/.test(u.hostname)) throw new Error("gitring cannot import from a private host.");
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/+$/, "");
}

/** Files larger than this stay opaque (no text, no analysis). */
export const MAX_TEXT_BYTES = 1_000_000;
/** At most this many files of a tree get their text loaded. */
export const MAX_TEXT_FILES = 6000;
const OPAQUE_DIRS = /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.git|target|__pycache__)\//;
const OPAQUE_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|webm|wav|flac|ogg|sqlite|db|lockb)$/i;

/** True for files whose text gitring loads (source and docs), false for vendored or binary files. */
export function textEligible(path: string): boolean {
  return !OPAQUE_DIRS.test(path) && !OPAQUE_EXT.test(path);
}


/**
 * "owner/name" of a GitHub repository, from "owner/name", "https://github.com/owner/name(.git)" or
 * "git@github.com:owner/name.git". null when the text names no GitHub repository.
 */
export function githubRepoName(raw: string): string | null {
  const t = String(raw ?? "").trim();
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(t) ??
    /^git@github\.com:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/i.exec(t) ??
    /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)$/.exec(t);
  if (!m) return null;
  if (m[2] === "." || m[2] === "..") return null;
  return `${m[1]}/${m[2]}`;
}
