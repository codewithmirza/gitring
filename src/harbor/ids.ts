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

/**
 * The id prefix of a check run made in the project object ("ck_…"; the runner makes "chk_…"). Change
 * requests use "cr_…". Check runs saved before 13 Oct 2026 can also have "cr_…": gitring never reads the
 * prefix of a check run id, so those runs stay readable as they are.
 */
export const CHECK_RUN = "ck";

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

/** Artifacts repo names: alphanumeric, dots, hyphens, underscores. */
export function repoSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "repo";
}
