/**
 * A small GitHub REST client for the Worker: a token, JSON and raw reads, pagination and ETags.
 *
 * The token is a user token, an installation token or none.
 * GitHub answers 304 to a request with a known ETag, and a 304 does not count against the rate limit: repeated reads stay cheap.
 */

export const GITHUB_API = "https://api.github.com";

const HEADERS = {
  "User-Agent": "gitring",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

/** ETag cache of GET answers in this isolate: key → { etag, body }, at most 8 MB together. */
const etags = new Map<string, { etag: string; status: number; body: string; link: string | null }>();
const ETAG_TOTAL_MAX = 8_000_000;
const ETAG_BODY_MAX = 256_000;
let etagBytes = 0;

function remember(key: string, entry: { etag: string; status: number; body: string; link: string | null }): void {
  const old = etags.get(key);
  if (old) {
    etagBytes -= old.body.length;
    etags.delete(key);
  }
  while (etagBytes + entry.body.length > ETAG_TOTAL_MAX && etags.size) {
    const [k, v] = etags.entries().next().value!;
    etags.delete(k);
    etagBytes -= v.body.length;
  }
  etags.set(key, entry);
  etagBytes += entry.body.length;
}

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export interface GithubClientOptions {
  fetch?: typeof fetch;
  base?: string;
  /** Separates ETag entries of different tokens' owners (for example the person's id). */
  cacheKey?: string;
}

export class GithubClient {
  private readonly fetcher: typeof fetch;
  private readonly base: string;

  constructor(
    readonly token: string | null,
    private readonly opts: GithubClientOptions = {},
  ) {
    this.fetcher = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.base = opts.base ?? GITHUB_API;
  }

  private headers(accept?: string): Record<string, string> {
    return { ...HEADERS, ...(accept ? { Accept: accept } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }

  /** GET with ETag reuse. Answers the status, the body text and the Link header. */
  async raw(path: string, accept?: string): Promise<{ status: number; body: string; link: string | null }> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    const key = `${this.opts.cacheKey ?? (this.token ? "t" : "anon")}|${accept ?? ""}|${url}`;
    const known = etags.get(key);
    const headers = this.headers(accept);
    if (known) headers["If-None-Match"] = known.etag;
    const res = await this.fetcher(url, { headers });
    if (res.status === 304 && known) {
      // Refresh the entry's position (Map keeps insertion order: the oldest entries go first).
      remember(key, known);
      return { status: known.status, body: known.body, link: known.link };
    }
    const body = await res.text();
    const link = res.headers.get("link");
    const etag = res.headers.get("etag");
    if (res.ok && etag && body.length <= ETAG_BODY_MAX) remember(key, { etag, status: res.status, body, link });
    return { status: res.status, body, link };
  }

  /** GET JSON. Null for 404; GithubError for other failures. */
  async json<T>(path: string): Promise<T | null> {
    const r = await this.raw(path);
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new GithubError(r.status, githubMessage(r.status, r.body));
    return JSON.parse(r.body) as T;
  }

  /** A file's text at a ref, or null (missing, a folder, or larger than `max` bytes). */
  async text(repo: string, path: string, ref: string, max = 200_000): Promise<string | null> {
    const r = await this.raw(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw+json");
    if (r.status !== 200 || r.body.length > max) return null;
    return r.body;
  }

  /**
   * All items of a paginated list, up to `maxPages` pages. `pick` takes the items out of one page
   * (some endpoints answer an array, others an object with the array in a field).
   */
  async pages<T>(path: string, pick: (page: unknown) => T[], maxPages = 10): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    let n = 0;
    while (next && n < maxPages) {
      const r = await this.raw(next);
      if (r.status < 200 || r.status >= 300) throw new GithubError(r.status, githubMessage(r.status, r.body));
      items.push(...pick(JSON.parse(r.body)));
      next = nextLink(r.link);
      n++;
    }
    return { items, complete: !next };
  }
}

/** The rel="next" URL of a Link header. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** One plain sentence for a GitHub error answer. */
export function githubMessage(status: number, body: string): string {
  let msg = "";
  try {
    msg = String((JSON.parse(body) as { message?: string }).message ?? "");
  } catch {
    /* not JSON */
  }
  if (status === 401) return "GitHub refused the token.";
  if (status === 403 && /rate limit/i.test(msg)) return "GitHub's rate limit is used up. Try again in a few minutes.";
  if (status === 403) return `GitHub refused the request${msg ? `: ${msg}` : ""}.`;
  return `GitHub answered ${status}${msg ? `: ${msg}` : ""}.`;
}

/** Forget cached answers (tests). */
export function clearGithubCache(): void {
  etags.clear();
  etagBytes = 0;
}
