/**
 * What gitring merges of a work copy. A merge carries every change of the work: text, binary files,
 * large files, modes (an executable bit, a symlink), and files in vendored folders. A few changes stay
 * out, and gitring tells the agent about each of them:
 *
 *   generated  a new folder of tool output (node_modules, caches) that main does not have
 *   many       a new vendored or built folder (vendor, dist, build, out) with too many files
 *   large      a file larger than MAX_CARRY_FILE_BYTES (the harbor reads the size)
 *   total      a file past MAX_CARRY_TOTAL_BYTES of files without text in one merge
 *   submodule  a submodule entry (gitring cannot merge submodules)
 *
 * A folder that main already has is carried as it is. Paths that an agent wrote one by one (gitring_write,
 * the Claude Code hook) are always carried. Pure module.
 */
import { diffSnapshots, type Snapshot } from "../git/snapshot";
import { opaqueFolder } from "../repo-rules";

/** A new vendored or built folder with more files than this stays out of the merge. */
export const MAX_NEW_FOLDER_FILES = 200;
/**
 * A file larger than this stays out of the merge (and out of the test container). A merge holds the bytes
 * of each file without text in the memory of the project object (128 MB) up to three times: the file, the
 * git object, the pack. The two limits keep a merge far below that memory.
 */
export const MAX_CARRY_FILE_BYTES = 10_000_000;
/** One merge carries at most this many bytes of files without text. The files past it stay out. */
export const MAX_CARRY_TOTAL_BYTES = 16_000_000;

const GITLINK_MODE = "160000";

export interface NotCarried {
  /** A file, or a folder with a final "/". */
  path: string;
  why: "generated" | "many" | "large" | "total" | "submodule";
  /** Files in the folder that stay out. */
  files?: number;
  /** Size of the file (large, total). */
  bytes?: number;
}

export interface CarryPlan {
  /** The work tree to merge: a path that stays out keeps its base entry. */
  work: Snapshot;
  notCarried: NotCarried[];
}

/** The work tree without the changes to `paths`: each path keeps its entry of the base (or stays absent). */
export function withoutChanges(base: Snapshot, work: Snapshot, paths: Iterable<string>): Snapshot {
  const out: Snapshot = new Map(work);
  for (const path of paths) {
    const b = base.get(path);
    if (b) out.set(path, b);
    else out.delete(path);
  }
  return out;
}

/** Which changes of `work` (against `base`) gitring merges. `explicit`: paths an agent wrote one by one. */
export function planCarry(base: Snapshot, work: Snapshot, explicit: ReadonlySet<string> = new Set()): CarryPlan {
  const notCarried: NotCarried[] = [];
  const drop: string[] = [];
  const folders = new Map<string, { generated: boolean; paths: string[] }>();
  for (const ch of diffSnapshots(base, work)) {
    if (explicit.has(ch.path)) continue;
    if (ch.status !== "D" && ch.mode === GITLINK_MODE) {
      drop.push(ch.path);
      notCarried.push({ path: ch.path, why: "submodule" });
      continue;
    }
    const of = opaqueFolder(ch.path);
    if (!of) continue;
    const f = folders.get(of.folder) ?? { generated: of.generated, paths: [] };
    f.paths.push(ch.path);
    folders.set(of.folder, f);
  }
  for (const [folder, f] of folders) {
    // A folder that main has: the project keeps it in git, so the work changes it like any other folder.
    if ([...base.keys()].some((path) => path.startsWith(folder))) continue;
    if (!f.generated && f.paths.length <= MAX_NEW_FOLDER_FILES) continue;
    drop.push(...f.paths);
    notCarried.push({ path: folder, why: f.generated ? "generated" : "many", files: f.paths.length });
  }
  notCarried.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { work: drop.length ? withoutChanges(base, work, drop) : work, notCarried };
}

/**
 * Which changed files without text stay out because of their size: a file larger than MAX_CARRY_FILE_BYTES,
 * and the files past MAX_CARRY_TOTAL_BYTES in path order. `sized`: each changed file and its size.
 */
export function overSize(sized: { path: string; bytes: number }[]): NotCarried[] {
  const out: NotCarried[] = [];
  let total = 0;
  for (const f of [...sized].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (f.bytes > MAX_CARRY_FILE_BYTES) out.push({ path: f.path, why: "large", bytes: f.bytes });
    else if (total + f.bytes > MAX_CARRY_TOTAL_BYTES) out.push({ path: f.path, why: "total", bytes: f.bytes });
    else total += f.bytes;
  }
  return out;
}

function sizeWord(bytes: number): string {
  return `${Math.round(bytes / 100_000) / 10} MB`;
}

/**
 * One short sentence for each part of the work that stays out. `forAgent`: also what the agent can do.
 * Empty when everything merges.
 */
export function notCarriedText(items: NotCarried[], forAgent = true): string {
  if (!items.length) return "";
  const lines = items.slice(0, 6).map((n) => {
    const count = n.files !== undefined ? ` (${n.files} file${n.files === 1 ? "" : "s"})` : "";
    if (n.why === "generated") return `gitring does not merge ${n.path}${count}. Tools make these files, and main does not have this folder.`;
    if (n.why === "many") return `gitring does not merge ${n.path}${count}. The new folder has more than ${MAX_NEW_FOLDER_FILES} files.`;
    const size = n.bytes ? ` (${sizeWord(n.bytes)})` : "";
    if (n.why === "large") return `gitring does not merge ${n.path}${size}. The limit for one file is ${sizeWord(MAX_CARRY_FILE_BYTES)}.`;
    if (n.why === "total") return `gitring does not merge ${n.path}${size}. One merge carries at most ${sizeWord(MAX_CARRY_TOTAL_BYTES)} of files without text. Add it in a different task.`;
    return `gitring does not merge the submodule ${n.path}.`;
  });
  const more = items.length > 6 ? ` ${items.length - 6} more parts of the work do not merge.` : "";
  return `${lines.join(" ")}${more}${forAgent ? " The other changes merge. Remove these paths from your work if you do not need them." : ""}`;
}
