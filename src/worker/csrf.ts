/**
 * A browser session may change state only from gitring's own pages.
 *
 * Fetch Metadata (`Sec-Fetch-Site`) decides when the browser sends it; the `Origin` header is the
 * fallback for older browsers. A page with a strict referrer policy makes the browser send
 * `Origin: null` on its own form posts and fetches, so "null" alone does not mean cross-site.
 */
export function isCrossSiteWrite(method: string, origin: string | undefined, site: string | undefined, own: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  if (origin && origin !== "null" && origin !== own) return true;
  if (site) return site !== "same-origin";
  return origin === "null";
}
