/**
 * Two small text helpers of the account sections: the host of a URL and a short date.
 */
export function host(uri?: string): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

export function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
