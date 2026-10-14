/**
 * Keeps every source file easy to read (docs/CODE-STYLE.md, rules 1 to 3): a size limit, a header comment
 * and a folder map. The three lists below are exceptions. They are empty now. Add a line only for one
 * cohesive table, with the reason; never for code that can be split. The test fails when a line is stale.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ROOTS = ["src", "web/src", "cli", "scripts", "local", "bench", "plugins"];
const SKIP = new Set(["node_modules", "dist", "tmp"]);
const SOURCE = new Set([".ts", ".tsx", ".mjs", ".css"]);
const MAX_LINES = { code: 600, css: 500 };
const MIN_FILES_FOR_README = 4;

/** Files over the size limit. A file may stay only if it is one cohesive table, with the reason as the value. */
const TOO_LONG: Record<string, string> = {};

/** Files with no header comment. Keep empty. */
const NO_HEADER = new Set<string>();

/** Folders with 4 or more source files and no README.md. Keep empty. */
const NO_README = new Set<string>();

interface SourceFile {
  path: string;
  lines: number;
  header: boolean;
}

function scan(): { files: SourceFile[]; folders: Map<string, number> } {
  const files: SourceFile[] = [];
  const folders = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (SKIP.has(name)) continue;
      const path = `${dir}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) {
        walk(path);
        continue;
      }
      if (!SOURCE.has(extname(name)) || /\.d\.m?ts$/.test(name)) continue;
      const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
      const first = lines.find((line) => line.trim() && !line.startsWith("#!")) ?? "";
      files.push({ path, lines: lines.length, header: /^\s*(\/\*|\/\/)/.test(first) });
      folders.set(dir, (folders.get(dir) ?? 0) + 1);
    }
  };
  for (const root of ROOTS) walk(root);
  return { files, folders };
}

const { files, folders } = scan();
const limitOf = (path: string): number => (path.endsWith(".css") ? MAX_LINES.css : MAX_LINES.code);

describe("the structure of the source files", () => {
  it("has no file over the size limit that is not on the list", () => {
    const over = files.filter((f) => f.lines > limitOf(f.path) && !(f.path in TOO_LONG)).map((f) => `${f.path} (${f.lines} lines)`);
    expect(over, "Split these files (docs/CODE-STYLE.md, rule 1)").toEqual([]);
  });

  it("has no stale line in the list of long files", () => {
    const stale = Object.keys(TOO_LONG).filter((path) => {
      const file = files.find((f) => f.path === path);
      return !file || file.lines <= limitOf(path);
    });
    expect(stale, "These files are short now: delete their lines from TOO_LONG").toEqual([]);
  });

  it("gives every file a header comment", () => {
    const missing = files.filter((f) => !f.header && !NO_HEADER.has(f.path)).map((f) => f.path);
    expect(missing, "Start each file with a comment of one sentence (rule 2)").toEqual([]);
  });

  it("has no stale line in the list of files without a header", () => {
    const stale = [...NO_HEADER].filter((path) => files.find((f) => f.path === path)?.header !== false);
    expect(stale, "These files have a header now: delete their lines from NO_HEADER").toEqual([]);
  });

  it("gives every big folder a README.md", () => {
    const missing = [...folders].filter(([dir, count]) => count >= MIN_FILES_FOR_README && !existsSync(join(ROOT, dir, "README.md")) && !NO_README.has(dir)).map(([dir]) => dir);
    expect(missing, "Add a README.md with one line for each file (rule 3)").toEqual([]);
  });

  it("has no stale line in the list of folders without a README", () => {
    const stale = [...NO_README].filter((dir) => existsSync(join(ROOT, dir, "README.md")) || (folders.get(dir) ?? 0) < MIN_FILES_FOR_README);
    expect(stale, "These folders have a README.md now: delete their lines from NO_README").toEqual([]);
  });
});
