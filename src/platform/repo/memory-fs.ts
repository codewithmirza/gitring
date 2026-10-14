/**
 * An in-memory filesystem for isomorphic-git inside a Worker (no disk).
 *
 * Ported from the Cloudflare Artifacts docs example, with fixes that isomorphic-git 1.43.2 needs (see the note below).
 */

/*
 * The fixes that isomorphic-git 1.43.2 needs:
 *
 * Ported from the Cloudflare Artifacts docs example (docs: "isomorphic-git inside a Worker"),
 * with fixes isomorphic-git 1.43.2 needs:
 *   - errors carry Node-style `code` ("ENOENT", "EEXIST", …): `FileSystem.exists()` and `mkdirp`
 *     branch on it, and rethrow errors without it;
 *   - `readlink` and `symlink` exist (isomorphic-git binds them unconditionally) and work;
 *   - stats are plain writable objects (checkout assigns `stats.mode`), with the fields the index uses;
 *   - `rm` with `{ recursive }`, `mkdir` with Node semantics.
 */

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number; ino: number }
  | { kind: "file"; data: Uint8Array; mode: number; mtimeMs: number; ino: number }
  | { kind: "symlink"; target: string; mtimeMs: number; ino: number };

export interface MemoryStats {
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  ino: number;
  dev: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function fsError(code: string, op: string, path: string): Error {
  const messages: Record<string, string> = {
    ENOENT: "no such file or directory",
    EEXIST: "file already exists",
    ENOTDIR: "not a directory",
    EISDIR: "illegal operation on a directory",
    ENOTEMPTY: "directory not empty",
    EINVAL: "invalid argument",
    ELOOP: "too many symbolic links encountered",
  };
  return Object.assign(new Error(`${code}: ${messages[code] ?? "error"}, ${op} '${path}'`), { code, path, syscall: op });
}

export class MemoryFS {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private nextIno = 1;
  private readonly entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now(), ino: 0 }]]);

  /** isomorphic-git uses `fs.promises` when it is an own enumerable property. */
  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    rm: this.rm.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
  };

  /** Total bytes held in files (for memory accounting). */
  get bytes(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.kind === "file") n += e.data.byteLength;
    return n;
  }

  normalize(input: string): string {
    if (typeof input !== "string") throw fsError("EINVAL", "path", String(input));
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") segments.pop();
      else segments.push(part);
    }
    return `/${segments.join("/")}`;
  }

  private parent(path: string): string {
    const parts = this.normalize(path).split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  /** Follow symlinks (up to 40 hops). */
  private resolve(path: string, op: string): string {
    let current = this.normalize(path);
    for (let hops = 0; hops < 40; hops++) {
      const e = this.entries.get(current);
      if (!e || e.kind !== "symlink") return current;
      current = e.target.startsWith("/") ? this.normalize(e.target) : this.normalize(`${this.parent(current)}/${e.target}`);
    }
    throw fsError("ELOOP", op, path);
  }

  private dirOf(path: string, op: string): Extract<Entry, { kind: "dir" }> {
    const e = this.entries.get(path);
    if (!e) throw fsError("ENOENT", op, path);
    if (e.kind !== "dir") throw fsError("ENOTDIR", op, path);
    return e;
  }

  private link(path: string, entry: Entry): void {
    this.entries.set(path, entry);
    this.dirOf(this.parent(path), "link").children.add(this.basename(path));
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number } | number): Promise<void> {
    const target = this.normalize(path);
    const recursive = typeof options === "object" && options !== null && !!options.recursive;
    if (target === "/") {
      if (recursive) return;
      throw fsError("EEXIST", "mkdir", path);
    }
    const existing = this.entries.get(target);
    if (existing) {
      if (recursive && existing.kind === "dir") return;
      throw fsError("EEXIST", "mkdir", path);
    }
    const parent = this.parent(target);
    if (!this.entries.has(parent)) {
      if (!recursive) throw fsError("ENOENT", "mkdir", path);
      await this.mkdir(parent, { recursive: true });
    }
    this.link(target, { kind: "dir", children: new Set(), mtimeMs: Date.now(), ino: this.nextIno++ });
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: { mode?: number; encoding?: string } | string): Promise<void> {
    const target = this.resolve(path, "open");
    const existing = this.entries.get(target);
    if (existing?.kind === "dir") throw fsError("EISDIR", "open", path);
    const parent = this.parent(target);
    if (!this.entries.has(parent)) await this.mkdir(parent, { recursive: true });
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    const mode = typeof options === "object" && options?.mode !== undefined ? options.mode : existing?.kind === "file" ? existing.mode : 0o644;
    this.link(target, {
      kind: "file",
      data: bytes,
      mode: mode & 0o777,
      mtimeMs: Date.now(),
      ino: existing?.ino ?? this.nextIno++,
    });
  }

  async readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> {
    const target = this.resolve(path, "open");
    const entry = this.entries.get(target);
    if (!entry) throw fsError("ENOENT", "open", path);
    if (entry.kind !== "file") throw fsError("EISDIR", "read", path);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(entry.data) : entry.data;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.dirOf(this.resolve(path, "scandir"), "scandir").children].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.entries.get(target);
    if (!entry) throw fsError("ENOENT", "unlink", path);
    if (entry.kind === "dir") throw fsError("EISDIR", "unlink", path);
    this.entries.delete(target);
    this.dirOf(this.parent(target), "unlink").children.delete(this.basename(target));
  }

  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    if (target === "/") throw fsError("EINVAL", "rmdir", path);
    const entry = this.dirOf(target, "rmdir");
    if (entry.children.size > 0) throw fsError("ENOTEMPTY", "rmdir", path);
    this.entries.delete(target);
    this.dirOf(this.parent(target), "rmdir").children.delete(this.basename(target));
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const target = this.normalize(path);
    const entry = this.entries.get(target);
    if (!entry) {
      if (options?.force) return;
      throw fsError("ENOENT", "rm", path);
    }
    if (entry.kind !== "dir") return this.unlink(target);
    if (!options?.recursive) throw fsError("EISDIR", "rm", path);
    for (const child of [...entry.children]) await this.rm(`${target}/${child}`, options);
    if (target !== "/") await this.rmdir(target);
  }

  private stats(entry: Entry): MemoryStats {
    const type = entry.kind;
    const mode = entry.kind === "dir" ? 0o040755 : entry.kind === "symlink" ? 0o120777 : 0o100000 | entry.mode;
    const size = entry.kind === "file" ? entry.data.byteLength : entry.kind === "symlink" ? this.encoder.encode(entry.target).byteLength : 0;
    return {
      type,
      mode,
      size,
      ino: entry.ino,
      dev: 1,
      uid: 1,
      gid: 1,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.mtimeMs,
      isFile: () => type === "file",
      isDirectory: () => type === "dir",
      isSymbolicLink: () => type === "symlink",
    };
  }

  async stat(path: string): Promise<MemoryStats> {
    const entry = this.entries.get(this.resolve(path, "stat"));
    if (!entry) throw fsError("ENOENT", "stat", path);
    return this.stats(entry);
  }

  async lstat(path: string): Promise<MemoryStats> {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw fsError("ENOENT", "lstat", path);
    return this.stats(entry);
  }

  async readlink(path: string): Promise<string> {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw fsError("ENOENT", "readlink", path);
    if (entry.kind !== "symlink") throw fsError("EINVAL", "readlink", path);
    return entry.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    const at = this.normalize(path);
    if (this.entries.has(at)) throw fsError("EEXIST", "symlink", path);
    const parent = this.parent(at);
    if (!this.entries.has(parent)) await this.mkdir(parent, { recursive: true });
    this.link(at, { kind: "symlink", target, mtimeMs: Date.now(), ino: this.nextIno++ });
  }
}
