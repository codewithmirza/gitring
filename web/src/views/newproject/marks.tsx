/**
 * Icons of the new-project flow. The GitHub mark is the one of the design system (Primer Octicons
 * "mark-github", unchanged, black or white by theme); it is decorative next to a text label.
 */
import { GitHubMark } from "../../design/brand/marks";

export function GithubMark({ size = 16, className }: { size?: number; className?: string }) {
  return <GitHubMark size={size} className={["np-mark", className].filter(Boolean).join(" ")} />;
}

/** A repository (a closed book), drawn like the gitring icons: 16 px grid, 1.5 px stroke. */
export function RepoIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={["b-icon", className].filter(Boolean).join(" ")} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden="true" focusable="false">
      <path d="M3.25 12.25V3a1.25 1.25 0 0 1 1.25-1.25h8.25v9H4.5a1.25 1.25 0 0 0 0 2.5h8.25" />
      <path d="M6 14.25v-1.5M6 4.5h4" />
    </svg>
  );
}

/** Search (a magnifier), drawn like the gitring icons. */
export function SearchIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={["b-icon", className].filter(Boolean).join(" ")} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.75" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

/** A private repository (a lock), drawn like the gitring icons. */
export function LockIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={["b-icon", className].filter(Boolean).join(" ")} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden="true" focusable="false">
      <rect x="3.25" y="7.25" width="9.5" height="7" />
      <path d="M5.25 7.25V5a2.75 2.75 0 0 1 5.5 0v2.25" />
    </svg>
  );
}
