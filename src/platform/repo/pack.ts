/**
 * Writes a git pack for a push, in a Worker: version 2, every object whole, deflated, with a SHA-1 trailer.
 *
 * Pure module: WebCrypto, TextEncoder and CompressionStream only. It runs in Node 22 and in workerd.
 * The pack carries the NEW objects of a commit only: the server has the rest.
 * `git index-pack` and the receive-pack of Artifacts read it as a normal pack.
 */
import { type GitObjectType, hexToBytes, sha1Hex } from "../../core/git/objects";

export interface PackObject {
  type: GitObjectType;
  body: Uint8Array;
}

/** Object type codes of the pack format (OBJ_COMMIT, OBJ_TREE, OBJ_BLOB). */
const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

const PACK_SIGNATURE = new TextEncoder().encode("PACK");
const PACK_VERSION = 2;

/** Deflate bytes in zlib format (RFC 1950), as git stores every object. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as ArrayBuffer]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The header of one object in a pack: the type in the top bits of the first byte, the size in base-128
 * groups of 7 bits, least significant first, with the high bit set on every byte but the last.
 */
export function objectHeader(type: GitObjectType, size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 0) throw new Error(`invalid object size: ${String(size)}`);
  const out: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(first);
  return Uint8Array.from(out);
}

/** The pack bytes for `objects`: header, every object (header + deflated body), the SHA-1 trailer. */
export async function writePack(objects: readonly PackObject[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(12);
  head.set(PACK_SIGNATURE, 0);
  new DataView(head.buffer).setUint32(4, PACK_VERSION);
  new DataView(head.buffer).setUint32(8, objects.length);
  parts.push(head);
  for (const o of objects) {
    parts.push(objectHeader(o.type, o.body.byteLength));
    parts.push(await deflate(o.body));
  }
  const body = concat(parts);
  const trailer = hexToBytes(await sha1Hex(body));
  return concat([body, trailer]);
}

/** The object count a pack announces (bytes 8 to 12 of its header). */
export function packObjectCount(pack: Uint8Array): number {
  if (pack.byteLength < 12) throw new Error("not a pack: too short");
  return new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.byteLength;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
