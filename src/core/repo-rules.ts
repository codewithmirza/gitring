/**
 * Rules for code that comes from outside: which remotes gitring imports, and which files it reads as text.
 *
 * Pure module (no platform APIs).
 */

/**
 * A host name on the public Internet: a domain with a dot, not an IP address (10.0.0.1, 169.254.169.254
 * and [fd00::1] included), not a local or internal name. gitring fetches from such hosts (imports,
 * webhooks, client metadata), so none of them may point into a private network.
 */
export function publicHostname(host: string): boolean {
  const h = String(host ?? "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h.includes(".")) return false;
  if (/^[\d.]+$/.test(h) || /^0x/.test(h) || h.startsWith("[") || h.includes(":")) return false; // IPv4 and IPv6 literals
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa|test|example|invalid|onion)$/.test(h)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h);
}

/** An https git remote for Artifacts import: https only, no credentials, a public host, ".git" optional. */
export function normalizeGitUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Give an https URL of a git repository, for example https://github.com/owner/repo.");
  }
  if (u.protocol !== "https:") throw new Error("Use an https URL.");
  if (u.username || u.password) throw new Error("Do not put credentials in the URL.");
  if (!publicHostname(u.hostname)) throw new Error("gitring cannot import from a private host. Give the address of a public git host.");
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

/** Folders that only tools fill (dependencies, caches, reports). People do not write these files. */
const GENERATED_DIRS = new Set(["node_modules", ".git", "__pycache__", ".cache", ".turbo", ".next", ".nuxt", "coverage", "target"]);

/**
 * The opaque folder that holds `path`, as a prefix with a final "/" ("node_modules/", "packages/a/dist/"),
 * or null. `generated`: a folder of tool output, never source (node_modules, caches); else vendored or built
 * files that a project can keep in git (vendor, dist, build, out).
 */
export function opaqueFolder(path: string): { folder: string; generated: boolean } | null {
  const m = OPAQUE_DIRS.exec(path);
  if (!m) return null;
  return { folder: path.slice(0, m.index + m[0].length), generated: GENERATED_DIRS.has(m[2]) };
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
