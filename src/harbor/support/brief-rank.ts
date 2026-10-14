/**
 * Ranks the files of main by how likely an agent needs them, for the brief that gitring_declare answers.
 * Called by the agent protocol in ../master/protocol.ts. Never read files from here: it only sorts what it gets.
 */
import type * as T from "../../core/types";

export const BRIEF_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|json|md|css|scss|html|vue|svelte|py|go|rs|rb|java|kt|toml|ya?ml)$/;

/**
 * Files for an agent's first look, most useful first: the files of its course and of the intent's scope,
 * the manifest and the README, then files whose path shares words with the intent.
 */
export function rankForBrief(files: Map<string, string>, intent: T.Intent, wanted: Set<string>): [string, string][] {
  const words = new Set((`${intent.title} ${intent.goal}`.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)));
  const score = (path: string): number => {
    let s = 0;
    if (wanted.has(path)) s += 100;
    if (/^(package\.json|readme\.md|tsconfig\.json|wrangler\.jsonc?|pyproject\.toml|go\.mod|cargo\.toml)$/i.test(path)) s += 40;
    if (/(^|\/)(src|lib|app|pages|components|server|api)\//.test(path)) s += 5;
    for (const part of path.toLowerCase().split(/[^a-z0-9]+/)) if (words.has(part) || words.has(part.replace(/s$/, ""))) s += 15;
    if (/(^|\/)(dist|build|vendor|node_modules|\.next|coverage)\//.test(path) || /\.min\.|lock|\.snap$/.test(path)) s -= 200;
    return s - path.split("/").length;
  };
  return [...files]
    .filter(([path]) => BRIEF_EXT.test(path) || wanted.has(path))
    .map(([path, text]) => ({ path, text, s: score(path) }))
    .sort((x, y) => y.s - x.s || (x.path < y.path ? -1 : 1))
    .map((x) => [x.path, x.text]);
}

export const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "add", "make", "show", "use", "can", "are", "not", "all", "one", "each", "new", "has", "have", "who", "its", "their", "them", "then", "than", "page"]);
