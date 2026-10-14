import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** A page that the Worker answers must be in run_worker_first, else the static assets answer "Not found". */
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const patternsOf = (file: string): string[] => {
  const cfg = JSON.parse(strip(readFileSync(file, "utf8")));
  return cfg.assets.run_worker_first as string[];
};
const covered = (path: string, patterns: string[]) => patterns.some((p) => (p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p));

describe("run_worker_first", () => {
  const src = readFileSync("src/worker/index.ts", "utf8");
  const block = src.slice(src.lastIndexOf("const path = url.pathname;"));
  const paths = [...block.matchAll(/path\.startsWith\("([^"]+)"\)/g)].map((m) => m[1]).concat([...block.matchAll(/path === "([^"]+)"/g)].map((m) => m[1]));
  for (const file of ["wrangler.jsonc", "wrangler.local.jsonc"]) {
    it(`${file} lists every path that the Worker answers`, () => {
      const patterns = patternsOf(file);
      expect(paths).toContain("/device");
      for (const p of paths) expect(covered(p, patterns), p).toBe(true);
    });
  }
});
