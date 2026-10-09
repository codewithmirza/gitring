/** Short ids, callsigns and identity colors. */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function rand(n = 6): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export function newId(prefix: string, n = 6): string {
  return `${prefix}_${rand(n)}`;
}

export const CALLSIGNS = [
  "KESTREL",
  "HERON",
  "PETREL",
  "TERN",
  "SKUA",
  "GANNET",
  "ALBATROSS",
  "OSPREY",
  "WREN",
  "FULMAR",
  "PUFFIN",
  "CURLEW",
  "PLOVER",
  "MERLIN",
  "EIDER",
  "SHEARWATER",
  "CORMORANT",
  "SANDERLING",
  "GUILLEMOT",
  "AUK",
] as const;

/** Deterministic callsign for the n-th agent of a project: KESTREL-7, HERON-3, … */
export function callsignFor(n: number): string {
  const name = CALLSIGNS[n % CALLSIGNS.length];
  const num = ((n * 7 + 3) % 9) + 1 + 10 * Math.floor(n / CALLSIGNS.length);
  return `${name}-${num}`;
}

export function colorFor(n: number): number {
  return n % 12;
}

/** Stable small hash (FNV-1a) for keys. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Artifacts repo names: alphanumeric, dots, hyphens, underscores. */
export function repoSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "repo";
}
