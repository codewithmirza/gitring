/**
 * A small tar writer (POSIX ustar + PAX for long or non-ASCII paths), so that Gitring can copy a tree
 * into a check container through `tar -x` on standard input. No dependencies; runs in Workers and Node.
 */

const enc = new TextEncoder();
const BLOCK = 512;

export interface TarEntry {
  path: string;
  content: string | Uint8Array;
  /** Octal file mode. Default 0o644. */
  mode?: number;
}

function octal(n: number, width: number): string {
  // width includes the trailing NUL
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function put(buf: Uint8Array, offset: number, text: string, width: number): void {
  const bytes = enc.encode(text);
  buf.set(bytes.subarray(0, width), offset);
}

function header(name: string, size: number, mode: number, type: "0" | "x", mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  put(h, 0, name, 100);
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
    const data = typeof e.content === "string" ? enc.encode(e.content) : e.content;
    const ascii = /^[\x20-\x7e]*$/.test(path);
    let name = path;
    if (!ascii || enc.encode(path).length > 100) {
      const pax = enc.encode(paxRecord("path", path));
      parts.push(header("PaxHeader", pax.length, 0o644, "x", mtime), pax, padding(pax.length));
      name = path.slice(-100).replace(/[^\x20-\x7e]/g, "_");
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
