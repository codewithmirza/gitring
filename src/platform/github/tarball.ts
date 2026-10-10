/**
 * Read one commit of a GitHub repository as files, from its tarball (GET /repos/{repo}/tarball/{sha}).
 * gitring uses it to import a private repository: Artifacts imports public remotes only.
 *
 * The tarball has one top folder ("owner-repo-<sha>/"); gitring strips it. Executable bits and symlinks
 * stay; submodules are not in tarballs (their entries on GitHub stay as they are, because gitring sends
 * only changed paths back).
 */
import type { FileChange } from "../repo/backend";
import { readTar } from "../checks/tar";
import { githubMessage, GITHUB_API } from "./api";

export interface SnapshotLimits {
  /** All file bytes together. */
  maxBytes: number;
  maxFiles: number;
}

export const SNAPSHOT_LIMITS: SnapshotLimits = { maxBytes: 25_000_000, maxFiles: 20_000 };

export class SnapshotTooLarge extends Error {}

export async function githubSnapshot(opts: {
  repo: string;
  sha: string;
  token: string | null;
  fetch?: typeof fetch;
  base?: string;
  limits?: SnapshotLimits;
}): Promise<{ files: FileChange[]; bytes: number }> {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const limits = opts.limits ?? SNAPSHOT_LIMITS;
  const res = await f(`${opts.base ?? GITHUB_API}/repos/${opts.repo}/tarball/${opts.sha}`, {
    headers: {
      "User-Agent": "gitring",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    redirect: "follow",
  });
  if (!res.ok || !res.body) throw new Error(`gitring could not download ${opts.repo}: ${githubMessage(res.status, await res.text().catch(() => ""))}`);
  const files: FileChange[] = [];
  let bytes = 0;
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  for await (const item of readTar(stream, (path, size) => {
    bytes += size;
    if (bytes > limits.maxBytes) throw new SnapshotTooLarge(`${opts.repo} is larger than ${Math.round(limits.maxBytes / 1e6)} MB. Push it with git instead (history and all files).`);
    return true;
  })) {
    const path = item.path.split("/").slice(1).join("/").replace(/\/+$/, "");
    if (!path || path.split("/").some((seg) => seg === "." || seg === ".." || seg === ".git")) continue;
    if (item.type === "file") {
      files.push({ path, content: item.data ?? new Uint8Array(), mode: item.mode & 0o111 ? "100755" : "100644" });
    } else if (item.type === "symlink" && item.linkname) {
      files.push({ path, content: item.linkname, mode: "120000" });
    } else continue;
    if (files.length > limits.maxFiles) throw new SnapshotTooLarge(`${opts.repo} has more than ${limits.maxFiles} files. Push it with git instead.`);
  }
  return { files, bytes };
}
