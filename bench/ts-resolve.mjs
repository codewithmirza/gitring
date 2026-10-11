/**
 * A module hook for Node. The source of gitring imports its own files without an extension
 * (`from "../core/types"`), as the bundler allows. Node needs the extension. This hook tries
 * `x.ts` and `x/index.ts` for every relative import that has no extension.
 * It makes the code in src/core run in plain Node, with no build step and no extra package.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
    }
  }
  return nextResolve(specifier, context);
}
