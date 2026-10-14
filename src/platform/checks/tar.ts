/**
 * A small tar writer (POSIX ustar, PAX for long or non-ASCII paths) for check containers.
 *
 * gitring copies a tree into a check container through `tar -x` on standard input.
 * No dependencies. It runs in Workers and in Node.
 */

const enc = new TextEncoder();
const BLOCK = 512;

export interface TarEntry {
  path: string;
  content: string | Uint8Array;
  /** Octal file mode. Default 0o644. */
  mode?: number;
  /** A symbolic link to this target (the content is not used). */
  link?: string;
}

function octal(n: number, width: number): string {
  // width includes the trailing NUL
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function put(buf: Uint8Array, offset: number, text: string, width: number): void {
  const bytes = enc.encode(text);
  buf.set(bytes.subarray(0, width), offset);
}

function header(name: string, size: number, mode: number, type: "0" | "2" | "x", mtime: number, linkname = ""): Uint8Array {
  const h = new Uint8Array(BLOCK);
  put(h, 0, name, 100);
  put(h, 157, linkname, 100);
  put(h, 100, octal(mode, 8), 8);
  put(h, 108, octal(0, 8), 8); // uid
  put(h, 116, octal(0, 8), 8); // gid
  put(h, 124, octal(size, 12), 12);
  put(h, 136, octal(mtime, 12), 12);
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  put(h, 156, type, 1);
  put(h, 257, "ustar\u0000", 6);
  put(h, 263, "00", 2);
  put(h, 265, "gitring", 32);
  put(h, 297, "gitring", 32);
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, octal(sum, 7) + " ", 8);
  return h;
}

/** One PAX record: "<len> path=<value>\n", where <len> counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = enc.encode(body).length + 1;
  while (String(len).length + enc.encode(body).length !== len) len = String(len).length + enc.encode(body).length;
  return `${len}${body}`;
}

function padding(size: number): Uint8Array {
  const rest = size % BLOCK;
  return new Uint8Array(rest ? BLOCK - rest : 0);
}

/** Tar bytes for the entries (sorted by path), ending with two zero blocks. */
export function tar(entries: TarEntry[], mtime = 0): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const path = e.path.replace(/^\/+/, "");
    if (!path || path.split("/").some((seg) => seg === ".." || seg === "")) continue;
    const data = e.link !== undefined ? new Uint8Array(0) : typeof e.content === "string" ? enc.encode(e.content) : e.content;
    const longPath = !/^[\x20-\x7e]*$/.test(path) || enc.encode(path).length > 100;
    const link = e.link ?? "";
    const longLink = !/^[\x20-\x7e]*$/.test(link) || enc.encode(link).length > 100;
    let name = path;
    if (longPath || longLink) {
      const pax = enc.encode((longPath ? paxRecord("path", path) : "") + (longLink ? paxRecord("linkpath", link) : ""));
      parts.push(header("PaxHeader", pax.length, 0o644, "x", mtime), pax, padding(pax.length));
      if (longPath) name = path.slice(-100).replace(/[^\x20-\x7e]/g, "_");
    }
    if (e.link !== undefined) {
      parts.push(header(name, 0, 0o777, "2", mtime, longLink ? link.slice(0, 100).replace(/[^\x20-\x7e]/g, "_") : link));
      continue;
    }
    parts.push(header(name, data.length, e.mode ?? 0o644, "0", mtime), data, padding(data.length));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Files that need the executable bit in a check container (git modes are not kept in text views). */
export function modeFor(path: string): number {
  return /(^|\/)(bin|scripts?)\/[^/]+$|\.(sh|bash)$|(^|\/)gradlew$|(^|\/)mvnw$/.test(path) ? 0o755 : 0o644;
}

/** Gzip bytes with the platform CompressionStream (Workers and Node 18+). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as ArrayBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ───────────── reading (GitHub tarballs) ───────────── */

export interface TarItem {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  /** Octal mode from the header (0o755 for executables). */
  mode: number;
  size: number;
  /** Symlink target. */
  linkname?: string;
  /** File bytes (files only). */
  data?: Uint8Array;
}

const dec = new TextDecoder();

function cstr(b: Uint8Array, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return dec.decode(end < 0 ? s : s.subarray(0, end));
}

function num(b: Uint8Array, start: number, len: number): number {
  // GNU base-256 for large values: the first byte has the high bit set.
  if (b[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + b[i];
    return n;
  }
  const t = cstr(b, start, len).trim();
  return t ? parseInt(t, 8) : 0;
}

/** PAX records: "<len> key=value\n" … */
function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(dec.decode(data.subarray(i, sp)), 10);
    if (!len || i + len > data.length) break;
    const rec = dec.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Pull exact byte counts out of a stream of chunks. */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private have = 0;
  private done = false;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Exactly n bytes, or null at the end of the stream. */
  async read(n: number): Promise<Uint8Array | null> {
    while (this.have < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value?.length) {
        this.chunks.push(value);
        this.have += value.length;
      }
    }
    if (this.have < n) return null;
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0];
      const take = Math.min(c.length, n - at);
      out.set(c.subarray(0, take), at);
      at += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.have -= n;
    return out;
  }

  async skip(n: number): Promise<boolean> {
    while (n > 0) {
      const step = Math.min(n, 1 << 20);
      if (!(await this.read(step))) return false;
      n -= step;
    }
    return true;
  }
}

/**
 * Read a tar stream (ustar, PAX and GNU long names). `want(path, size)` decides per file whether its
 * bytes are kept; skipped files still count in the yielded items, without data.
 */
export async function* readTar(stream: ReadableStream<Uint8Array>, want: (path: string, size: number) => boolean = () => true): AsyncGenerator<TarItem> {
  const r = new ByteReader(stream.getReader());
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  for (;;) {
    const h = await r.read(BLOCK);
    if (!h || h.every((b) => b === 0)) return;
    const type = String.fromCharCode(h[156] || 0x30);
    const size = num(h, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      const body = await r.read(padded);
      if (!body) return;
      const data = body.subarray(0, size);
      if (type === "x") pax = paxRecords(data);
      else if (type === "L") longName = cstr(data, 0, data.length);
      else if (type === "K") longLink = cstr(data, 0, data.length);
      // "g" (global, such as GitHub's commit comment) applies to nothing here.
      continue;
    }
    const prefix = cstr(h, 345, 155);
    const name = cstr(h, 0, 100);
    const path = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const linkname = pax.linkpath ?? longLink ?? cstr(h, 157, 100);
    const realSize = pax.size ? Number(pax.size) : size;
    const realPadded = Math.ceil(realSize / BLOCK) * BLOCK;
    pax = {};
    longName = longLink = undefined;
    const mode = num(h, 100, 8);
    const kind: TarItem["type"] = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "dir" : type === "2" ? "symlink" : "other";
    if (kind === "file" && want(path, realSize)) {
      const body = await r.read(realPadded);
      if (!body) return;
      yield { path, type: kind, mode, size: realSize, data: body.subarray(0, realSize) };
    } else {
      if (!(await r.skip(realPadded))) return;
      yield { path, type: kind, mode, size: realSize, ...(kind === "symlink" ? { linkname } : {}) };
    }
  }
}
