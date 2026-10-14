/**
 * Git object model: encode, decode and hash blob / tree / commit objects.
 *
 * Pure module: WebCrypto SHA-1 (`globalThis.crypto.subtle`), TextEncoder and TextDecoder only (plus a
 * plain JavaScript SHA-1 for callers that need an id at once). It runs unchanged in Node 22 (vitest) and
 * in workerd.
 *
 * Hashes are byte-for-byte identical to real git. `test/git/objects.test.ts` cross-checks
 * `hashObject`, `encodeTree` and `encodeCommit` against `git hash-object`, `git mktree`
 * and `git commit-tree`.
 */
import type { CommitMeta, TreeEntry, TreeEntryType } from "../../platform/repo/backend";

export type GitObjectType = "blob" | "tree" | "commit";

/** Committer / author identity as written in a commit object. */
export interface GitIdent {
  name: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
  /** "+0000", "-0700", … */
  tzOffset: string;
}

/** The empty tree (`git hash-object -t tree /dev/null`). Git treats it as always present. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The empty blob. */
export const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
/** Tree entry mode of a directory, as git writes it (no leading zero). */
export const TREE_MODE = "40000";

const encoder = new TextEncoder();
const decoder = new TextDecoder(); // non-fatal: invalid UTF-8 becomes U+FFFD

export const utf8: { encode(s: string): Uint8Array; decode(b: Uint8Array): string } = {
  encode: (s: string): Uint8Array => encoder.encode(s),
  decode: (b: Uint8Array): string => decoder.decode(b),
};

/* ───────────────────────────── hex + hashing ───────────────────────────── */

const SHA_RE = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-character hex object id. */
export function isSha(value: unknown): boolean {
  return typeof value === "string" && SHA_RE.test(value);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`invalid hex string: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** SHA-1 of `data` as lowercase hex (WebCrypto). */
export async function sha1Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>);
  return bytesToHex(new Uint8Array(digest));
}

/** `"<type> <len>\0" + body`: the bytes git hashes (and deflates) for a loose object. */
export function frameObject(type: GitObjectType, body: Uint8Array): Uint8Array {
  const header = encoder.encode(`${type} ${body.byteLength}\0`);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

/** The git object id of `body` stored as `type` (what `git hash-object -t <type>` prints). */
export function hashObject(type: GitObjectType, body: Uint8Array): Promise<string> {
  return sha1Hex(frameObject(type, body));
}

/**
 * SHA-1 of `data` as lowercase hex, in plain JavaScript: the answer comes at once, with no wait for
 * WebCrypto. For a caller that must not give way to other work in the middle of a step (a view of a work
 * copy that many calls read). WebCrypto is faster for large data.
 */
export function sha1HexSync(data: Uint8Array): string {
  const blocks = (((data.length + 8) >>> 6) + 1) * 16;
  const m = new Uint32Array(blocks);
  for (let i = 0; i < data.length; i++) m[i >>> 2] |= data[i] << (24 - (i & 3) * 8);
  m[data.length >>> 2] |= 0x80 << (24 - (data.length & 3) * 8);
  const bits = data.length * 8;
  m[blocks - 1] = bits >>> 0;
  m[blocks - 2] = Math.floor(bits / 0x100000000);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < blocks; off += 16) {
    for (let t = 0; t < 16; t++) w[t] = m[off + t];
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 || t >= 60 ? b ^ c ^ d : (b & c) | (b & d) | (c & d);
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = next;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}

/** hashObject, computed at once (see sha1HexSync). */
export function hashObjectSync(type: GitObjectType, body: Uint8Array): string {
  return sha1HexSync(frameObject(type, body));
}

/* ───────────────────────────── modes ───────────────────────────── */

function parseMode(mode: string): number {
  if (typeof mode !== "string" || !/^[0-7]{1,7}$/.test(mode)) throw new Error(`invalid git mode: ${String(mode)}`);
  return parseInt(mode, 8);
}

/** Canonical spelling of a mode: octal without leading zeros ("040000" → "40000"). */
export function normalizeMode(mode: string): string {
  return parseMode(mode).toString(8);
}

/**
 * Entry type derived from a mode:
 * 40000 → tree, 100644 → blob, 100755 → exec, 120000 → symlink, 160000 → gitlink.
 * Regular files with the owner-execute bit are "exec" (git canonicalizes them to 100755).
 */
export function modeToType(mode: string): TreeEntryType {
  const m = parseMode(mode);
  switch (m & 0o170000) {
    case 0o040000:
      return "tree";
    case 0o100000:
      return m & 0o100 ? "exec" : "blob";
    case 0o120000:
      return "symlink";
    case 0o160000:
      return "gitlink";
    default:
      throw new Error(`unsupported git mode: ${mode}`);
  }
}

/** True if the mode is a directory (tree) mode. */
export function isTreeMode(mode: string): boolean {
  return (parseMode(mode) & 0o170000) === 0o040000;
}

/* ───────────────────────────── trees ───────────────────────────── */

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function assertEntryName(name: string): void {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`invalid tree entry name: ${JSON.stringify(name)}`);
  }
}

/**
 * Encode a tree object body. Entries are sorted by git rules: byte order of the UTF-8 name,
 * where a directory compares as if its name ended with "/". Modes are written without a
 * leading zero ("40000"), followed by a space, the name, NUL and the raw 20-byte object id.
 */
export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const seen = new Set<string>();
  const items = entries.map((e) => {
    assertEntryName(e.name);
    if (!isSha(e.hash)) throw new Error(`invalid object id for tree entry ${e.name}: ${String(e.hash)}`);
    if (seen.has(e.name)) throw new Error(`duplicate tree entry name: ${e.name}`);
    seen.add(e.name);
    const mode = normalizeMode(e.mode);
    const name = encoder.encode(e.name);
    const key = isTreeMode(mode) ? concatBytes(name, SLASH) : name;
    return { mode: encoder.encode(mode), name, key, hash: hexToBytes(e.hash) };
  });
  items.sort((a, b) => compareBytes(a.key, b.key));
  let size = 0;
  for (const it of items) size += it.mode.length + 1 + it.name.length + 1 + 20;
  const out = new Uint8Array(size);
  let at = 0;
  for (const it of items) {
    out.set(it.mode, at);
    at += it.mode.length;
    out[at++] = 0x20;
    out.set(it.name, at);
    at += it.name.length;
    out[at++] = 0x00;
    out.set(it.hash, at);
    at += 20;
  }
  return out;
}

const SLASH = new Uint8Array([0x2f]);

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Decode a tree object body. Modes come back canonical ("40000"); `type` is derived from the mode. */
export function decodeTree(body: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) throw new Error(`malformed tree: no space after mode at byte ${at}`);
    const nul = body.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > body.length) throw new Error(`malformed tree: truncated entry at byte ${at}`);
    const rawMode = decoder.decode(body.subarray(at, space));
    const mode = normalizeMode(rawMode);
    out.push({
      name: decoder.decode(body.subarray(space + 1, nul)),
      mode,
      hash: bytesToHex(body.subarray(nul + 1, nul + 21)),
      type: modeToType(mode),
    });
    at = nul + 21;
  }
  return out;
}

/* ───────────────────────────── commits ───────────────────────────── */

// Git's `crud()`: characters stripped from both ends of a name or email.
function isCrud(c: number): boolean {
  return c <= 32 || c === 0x2c || c === 0x3a || c === 0x3b || c === 0x3c || c === 0x3e || c === 0x22 || c === 0x5c || c === 0x27;
}

/**
 * Sanitize a name or email exactly like git's `strbuf_addstr_without_crud`: strip "crud"
 * (whitespace, `, : ; < > " \ '`) from both ends and drop `\n`, `<` and `>` anywhere.
 */
export function sanitizeIdentPart(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isCrud(value.charCodeAt(start))) start++;
  while (end > start && isCrud(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end).replace(/[\n<>\0]/g, "");
}

const TZ_RE = /^[+-]\d{4}$/;

function formatIdent(id: GitIdent): string {
  const ts = Math.floor(Number(id.timestamp));
  if (!Number.isFinite(ts) || ts < 0) throw new Error(`invalid commit timestamp: ${String(id.timestamp)}`);
  const tz = TZ_RE.test(id.tzOffset) ? id.tzOffset : "+0000";
  return `${sanitizeIdentPart(id.name)} <${sanitizeIdentPart(id.email)}> ${ts} ${tz}`;
}

/**
 * Encode a commit object body:
 * `tree X\nparent Y\nauthor N <E> <ts> <tz>\ncommitter …\n\n<message>`.
 * The message is written exactly as given: pass a trailing "\n" to match `git commit`.
 */
export function encodeCommit(c: {
  tree: string;
  parents: string[];
  author: GitIdent;
  committer: GitIdent;
  message: string;
}): Uint8Array {
  if (!isSha(c.tree)) throw new Error(`invalid tree id: ${String(c.tree)}`);
  let head = `tree ${c.tree}\n`;
  for (const p of c.parents) {
    if (!isSha(p)) throw new Error(`invalid parent id: ${String(p)}`);
    head += `parent ${p}\n`;
  }
  head += `author ${formatIdent(c.author)}\n`;
  head += `committer ${formatIdent(c.committer)}\n`;
  return encoder.encode(`${head}\n${c.message}`);
}

/** Parse an ident value (`Name <email> 1700000000 +0000`). Tolerant of odd foreign commits. */
export function parseIdent(value: string): GitIdent {
  const lt = value.indexOf("<");
  const gt = lt < 0 ? -1 : value.indexOf(">", lt + 1);
  if (lt < 0 || gt < 0) return { name: value.trim(), email: "", timestamp: 0, tzOffset: "+0000" };
  const [ts, tz] = value.slice(gt + 1).trim().split(/\s+/);
  const timestamp = Number.parseInt(ts ?? "", 10);
  return {
    name: value.slice(0, lt).trim(),
    email: value.slice(lt + 1, gt),
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    tzOffset: tz && TZ_RE.test(tz) ? tz : "+0000",
  };
}

/**
 * Decode a commit object body into the `CommitMeta` shape Artifacts returns:
 * the message has ONE trailing newline removed, timestamps are unix seconds.
 * Extra headers (gpgsig, encoding, mergetag) are skipped.
 */
export function decodeCommit(hash: string, body: Uint8Array): CommitMeta {
  const text = decoder.decode(body);
  const sep = text.indexOf("\n\n");
  const headers = sep < 0 ? text : text.slice(0, sep);
  let message = sep < 0 ? "" : text.slice(sep + 2);
  if (message.endsWith("\n")) message = message.slice(0, -1);

  let tree = "";
  const parents: string[] = [];
  let author: GitIdent | undefined;
  let committer: GitIdent | undefined;
  for (const line of headers.split("\n")) {
    if (line === "" || line.startsWith(" ")) continue; // continuation of a multi-line header
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "tree" && !tree) tree = value.trim();
    else if (key === "parent") parents.push(value.trim());
    else if (key === "author" && !author) author = parseIdent(value);
    else if (key === "committer" && !committer) committer = parseIdent(value);
  }
  if (!isSha(tree)) throw new Error(`malformed commit ${hash}: missing tree header`);
  const a = author ?? { name: "", email: "", timestamp: 0, tzOffset: "+0000" };
  const c = committer ?? a;
  return {
    hash,
    treeHash: tree,
    message,
    author: { name: a.name, email: a.email },
    committer: { name: c.name, email: c.email },
    parents,
    authoredAt: a.timestamp,
    committedAt: c.timestamp,
  };
}

/** Ensure a commit message ends with exactly the newline git would store for `git commit -m`. */
export function normalizeCommitMessage(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

/* ───────────────────────────── refs ───────────────────────────── */

/**
 * Validate a branch name (the part after `refs/heads/`) with git's ref-name rules
 * (`git check-ref-format --branch`), slightly stricter: ASCII printable only.
 */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== "string" || name === "" || name === "@" || name === "HEAD") return false;
  if (name.length > 255) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.startsWith("-")) return false;
  for (const part of name.split("/")) {
    if (part.startsWith(".") || part.endsWith(".lock")) return false;
  }
  return true;
}
