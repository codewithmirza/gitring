/**
 * Pure helpers for the source picker: rank repositories for a query, read pasted URLs, suggest names.
 * No DOM, no requests (unit tests run them in Node).
 */
import type { GithubRepo } from "../../../../src/core/accounts";
import { githubRepoName } from "../../../../src/core/repo-rules";

/** What pasted text names: a GitHub repository, another https git URL, or something gitring cannot import. */
export type Pasted = { kind: "github"; repo: string; url: string } | { kind: "git"; url: string } | { kind: "bad"; reason: string };

/**
 * Read text that a person typed or pasted into the source picker.
 * null: the text is a search, not a source.
 */
export function readPasted(text: string): Pasted | null {
  const t = text.trim();
  if (!t) return null;
  const gh = githubRepoName(t);
  const named = /github\.com/i.test(t);
  if (gh && named) return { kind: "github", repo: gh, url: `https://github.com/${gh}` };
  if (/^https:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (u.username || u.password) return { kind: "bad", reason: "Remove the user name and the password from the URL." };
      if (u.hostname.includes(".") && u.pathname.replace(/\/+$/, "").length > 1) return { kind: "git", url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
    } catch {
      /* not a URL */
    }
    return null;
  }
  if (/^http:\/\//i.test(t)) return { kind: "bad", reason: "gitring imports https URLs only." };
  if (/^(git@|ssh:\/\/)/i.test(t)) return { kind: "bad", reason: "gitring cannot import SSH URLs. Use the https URL, or push with git." };
  // "owner/name" alone: a search, and also a GitHub repository that the person can import.
  if (gh && /^[^\s/]+\/[^\s/]+$/.test(t)) return { kind: "github", repo: gh, url: `https://github.com/${gh}` };
  return null;
}

/** True when the text looks like a URL or an owner/name pair (the picker then puts an import row on top). */
export function looksLikeSource(text: string): boolean {
  return readPasted(text) !== null;
}

function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** How well one word of a query matches a repository (0: no match). */
function scoreToken(r: GithubRepo, t: string): number {
  const full = r.fullName.toLowerCase();
  const slash = full.indexOf("/");
  const owner = slash > 0 ? full.slice(0, slash) : "";
  const name = slash >= 0 ? full.slice(slash + 1) : full;
  if (full === t || name === t) return 100;
  if (name.startsWith(t)) return 85;
  if (full.startsWith(t)) return 75;
  if (name.split(/[-_.]+/).some((w) => w.startsWith(t))) return 65;
  if (name.includes(t)) return 55;
  if (owner === t) return 50;
  if (full.includes(t)) return 45;
  if (t.length > 1 && subsequence(name, t)) return 25;
  if (r.description?.toLowerCase().includes(t)) return 12;
  if (r.language?.toLowerCase() === t) return 10;
  return 0;
}

/**
 * Repositories that match every word of the query, best first. A tie keeps the server order
 * (the server sorts by the last push).
 */
export function rankRepos(repos: GithubRepo[], query: string): GithubRepo[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return repos;
  const scored: { r: GithubRepo; s: number; i: number }[] = [];
  repos.forEach((r, i) => {
    let total = 0;
    for (const w of words) {
      const s = scoreToken(r, w);
      if (s === 0) return;
      total += s;
    }
    scored.push({ r, s: total, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.r);
}

/** "owner/name" → "name". */
export function nameOfRepo(repo: string): string {
  const i = repo.indexOf("/");
  return i >= 0 ? repo.slice(i + 1) : repo;
}

/** The last part of a git URL, without ".git": a name for the project. */
export function nameOfUrl(url: string): string {
  const m = /([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : "";
}

/** A branch name that git and gitring accept. */
export function validBranch(b: string): boolean {
  return /^[A-Za-z0-9._/-]{1,100}$/.test(b) && !b.startsWith("/") && !b.endsWith("/") && !b.includes("..");
}

/** "3 d ago" for an ISO time (empty when the time is absent or bad). */
export function agoIso(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} d ago`;
  const mo = Math.round(d / 30);
  if (mo < 24) return `${mo} mo ago`;
  return `${Math.round(mo / 12)} y ago`;
}

/** The size of a folder for people: "640 KB", "3.4 MB". */
export function sizeText(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** The guess reason that explains one field, by its words (the server sends plain sentences). */
export function reasonFor(reasons: string[], field: "branch" | "install" | "test" | "sync" | "visibility" | "name"): string | undefined {
  const tests: Record<typeof field, RegExp> = {
    branch: /\bbranch\b/i,
    install: /\binstall|lock ?file|package-lock|pnpm-lock|yarn\.lock|bun\.lock/i,
    test: /\btests?\b|\bpytest\b|go test|cargo test/i,
    sync: /\bpush\b|pull request|\bsync\b|send/i,
    visibility: /\bprivate\b|\bpublic\b/i,
    name: /\bname\b/i,
  };
  return reasons.find((r) => tests[field].test(r));
}
