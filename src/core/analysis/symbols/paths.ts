/**
 * Turns an import specifier into a repository path, and reads path aliases from tsconfig.json or jsconfig.json.
 *
 * Called through `../symbols`. It reads no file: the caller gives the set of paths. It never throws.
 */

import type { PathAliases } from "./types";

/**
 * Resolve a relative import specifier ("./x", "../y/z.js") against the importer's directory.
 * Tries the exact path, then + ".js", ".mjs", ".ts", "/index.js", "/index.ts" (then a few more:
 * ".jsx", ".tsx", ".cjs", ".mts", "/index.mjs", "/index.jsx", "/index.tsx", and the TypeScript
 * convention "./x.js" → "x.ts"). Bare package specifiers return undefined.
 * Extension: with `aliases`, a bare specifier tries the `paths` patterns that match it (an exact
 * pattern first, then the longest prefix before the `*`), then the `baseUrl` directory.
 */
export function resolveImport(fromPath: string, spec: string, files: Set<string>, aliases?: PathAliases): string | undefined {
  if (!(spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../"))) {
    // An alias may start with "#" (`#shared/*`), so only a query is cut here.
    const bare = spec.replace(/\?.*$/, "");
    return aliases && bare && !bare.startsWith("/") ? resolveAliased(bare, files, aliases) : undefined;
  }
  const clean = spec.replace(/[?#].*$/, "");
  const from = normalizeRepoPath(fromPath);
  const slash = from.lastIndexOf("/");
  const dir = slash < 0 ? "" : from.slice(0, slash);
  const joined = joinPath(dir, clean);
  return joined === undefined ? undefined : resolveJoined(joined, files);
}

function resolveAliased(spec: string, files: Set<string>, aliases: PathAliases): string | undefined {
  const matches: { star: string; targets: string[]; weight: number }[] = [];
  for (const { pattern, targets } of aliases.paths) {
    const star = pattern.indexOf("*");
    if (star < 0) {
      if (pattern === spec) matches.push({ star: "", targets, weight: Infinity });
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.length >= prefix.length + suffix.length && spec.startsWith(prefix) && spec.endsWith(suffix)) {
      matches.push({ star: spec.slice(prefix.length, spec.length - suffix.length), targets, weight: prefix.length });
    }
  }
  matches.sort((x, y) => y.weight - x.weight);
  for (const m of matches) {
    for (const target of m.targets) {
      const joined = joinPath("", target.replace("*", m.star));
      const hit = joined === undefined ? undefined : resolveJoined(joined, files);
      if (hit !== undefined) return hit;
    }
  }
  if (aliases.baseUrl === undefined) return undefined;
  const joined = joinPath(aliases.baseUrl, spec);
  return joined === undefined || joined === "" ? undefined : resolveJoined(joined, files);
}

/** The file for a joined repo path: the path itself, or the path with a known extension or an index file. */
function resolveJoined(joined: string, files: Set<string>): string | undefined {
  const candidates: string[] = [];
  if (joined !== "") {
    candidates.push(joined, joined + ".js", joined + ".mjs", joined + ".ts");
  }
  const indexBase = joined === "" ? "" : joined + "/";
  candidates.push(indexBase + "index.js", indexBase + "index.ts");
  if (joined !== "") {
    candidates.push(joined + ".jsx", joined + ".tsx", joined + ".cjs", joined + ".mts");
    const m = /\.(m|c)?js(x)?$/.exec(joined);
    if (m) {
      const stem = joined.slice(0, m.index);
      if (m[1] === "m") candidates.push(stem + ".mts");
      else if (m[1] === "c") candidates.push(stem + ".cts");
      else if (m[2]) candidates.push(stem + ".tsx");
      else candidates.push(stem + ".ts", stem + ".tsx");
    }
  }
  candidates.push(indexBase + "index.mjs", indexBase + "index.jsx", indexBase + "index.tsx");
  for (const c of candidates) if (files.has(c)) return c;
  return undefined;
}

/**
 * The path aliases of a repository: `compilerOptions.paths` and `baseUrl` of the root tsconfig.json,
 * else of the root jsconfig.json. The text may hold comments and trailing commas. `extends` is not
 * followed. Undefined when the file is missing, cannot be read, or has no aliases. Never throws.
 */
export function pathAliasesOf(files: ReadonlyMap<string, string>): PathAliases | undefined {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const text = files.get(name);
    if (typeof text !== "string") continue;
    let options: { baseUrl?: unknown; paths?: unknown } | undefined;
    try {
      options = (parseJsonc(text) as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | null)?.compilerOptions;
    } catch {
      continue;
    }
    if (!options || typeof options !== "object") continue;
    const baseUrl = typeof options.baseUrl === "string" ? joinPath("", options.baseUrl) : undefined;
    const paths: PathAliases["paths"] = [];
    if (options.paths && typeof options.paths === "object" && !Array.isArray(options.paths)) {
      for (const [pattern, raw] of Object.entries(options.paths as Record<string, unknown>)) {
        if (!Array.isArray(raw) || (pattern.match(/\*/g)?.length ?? 0) > 1) continue;
        // Targets are relative to baseUrl, or to the directory of the file (the root) without it.
        const targets = raw.flatMap((t) => (typeof t === "string" ? [joinPath(baseUrl ?? "", t)] : [])).filter((t): t is string => t !== undefined && t !== "");
        if (targets.length) paths.push({ pattern, targets });
      }
    }
    if (paths.length || baseUrl !== undefined) return baseUrl === undefined ? { paths } : { baseUrl, paths };
  }
  return undefined;
}

/** JSON with comments and trailing commas (the tsconfig format). Throws on anything else. */
function parseJsonc(text: string): unknown {
  let out = "";
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
    } else if (c === ",") {
      // A comma before "}" or "]" (spaces and comments between) is a trailing comma.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === "/" && text[j + 1] === "/") {
          const nl = text.indexOf("\n", j);
          j = nl < 0 ? text.length : nl;
        } else if (text[j] === "/" && text[j + 1] === "*") {
          const close = text.indexOf("*/", j + 2);
          j = close < 0 ? text.length : close + 2;
        } else break;
      }
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

function normalizeRepoPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

/** Join and normalize; undefined if ".." climbs above the repo root. */
function joinPath(dir: string, rel: string): string | undefined {
  const out: string[] = dir ? dir.split("/").filter(Boolean) : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}
