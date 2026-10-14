/**
 * Keeps every source file easy to read (docs/CODE-STYLE.md, rules 1 to 3): a size limit, a header comment
 * and a folder map. The three lists below are debts of today. Fix a debt, then delete its line: the test
 * fails when a line is stale. Never add a line for new code. New code follows the rules.
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
const TOO_LONG: Record<string, string> = {
  "src/harbor/harbor.ts": "split it, then delete this line",
  "src/core/analysis/symbols.ts": "split it, then delete this line",
  "src/directory/directory.ts": "split it, then delete this line",
  "web/src/design/components/components.css": "split it, then delete this line",
  "web/src/views/code/highlight.ts": "split it, then delete this line",
  "web/src/views/CodeView.tsx": "split it, then delete this line",
  "src/core/types.ts": "split it, then delete this line",
  "src/worker/index.ts": "split it, then delete this line",
  "web/src/views/SettingsView.tsx": "split it, then delete this line",
  "web/src/views/DesignView.tsx": "split it, then delete this line",
  "src/platform/repo/artifacts.ts": "split it, then delete this line",
  "src/directory/oauth.ts": "split it, then delete this line",
  "src/worker/mcp-github.ts": "split it, then delete this line",
  "web/src/views/ConnectView.tsx": "split it, then delete this line",
  "web/src/app/app.css": "split it, then delete this line",
  "web/src/chart/Chart.tsx": "split it, then delete this line",
  "src/harbor/derived.ts": "split it, then delete this line",
  "web/src/views/replay/model.ts": "split it, then delete this line",
  "web/src/views/IntentsView.tsx": "split it, then delete this line",
  "web/src/views/newproject/steps.tsx": "split it, then delete this line",
  "web/src/views/LogbookView.tsx": "split it, then delete this line",
  "src/worker/auth.ts": "split it, then delete this line",
  "web/src/state/selectors.ts": "split it, then delete this line",
  "web/src/views/AccountView.tsx": "split it, then delete this line",
  "web/src/views/code/code.css": "split it, then delete this line",
  "web/src/state/api.ts": "split it, then delete this line",
  "web/src/views/replay/replay.css": "split it, then delete this line",
};

/** Files with no header comment yet. */
const NO_HEADER = new Set([
  "src/worker/env.ts",
  "web/src/app/App.tsx",
  "web/src/app/IntentsRail.tsx",
  "web/src/app/LaunchControl.tsx",
  "web/src/app/RadioLog.tsx",
  "web/src/app/TopBar.tsx",
  "web/src/app/TrafficRail.tsx",
  "web/src/app/useMedia.ts",
  "web/src/app/useNow.ts",
  "web/src/chart/ChartLegend.tsx",
  "web/src/design/components/Badge.tsx",
  "web/src/design/components/Button.tsx",
  "web/src/design/components/Callsign.tsx",
  "web/src/design/components/CodeBlock.tsx",
  "web/src/design/components/CorrectionNotice.tsx",
  "web/src/design/components/CourseCheckReadout.tsx",
  "web/src/design/components/Dialog.tsx",
  "web/src/design/components/DiffView.tsx",
  "web/src/design/components/EmptyState.tsx",
  "web/src/design/components/EvidenceBar.tsx",
  "web/src/design/components/Field.tsx",
  "web/src/design/components/index.ts",
  "web/src/design/components/InlineConfirm.tsx",
  "web/src/design/components/InlinePanel.tsx",
  "web/src/design/components/Kbd.tsx",
  "web/src/design/components/LineRequest.tsx",
  "web/src/design/components/LogLine.tsx",
  "web/src/design/components/Menu.tsx",
  "web/src/design/components/Panel.tsx",
  "web/src/design/components/Popover.tsx",
  "web/src/design/components/PreviewFrame.tsx",
  "web/src/design/components/RangeIndicator.tsx",
  "web/src/design/components/Segmented.tsx",
  "web/src/design/components/Skeleton.tsx",
  "web/src/design/components/Stat.tsx",
  "web/src/design/components/Tabs.tsx",
  "web/src/design/components/Toast.tsx",
  "web/src/design/components/Tooltip.tsx",
  "web/src/main.tsx",
  "web/src/views/ChartView.tsx",
  "web/src/views/ChoiceList.tsx",
  "web/src/views/IntentsView.tsx",
]);

/** Folders with 4 or more source files and no README.md yet. */
const NO_README = new Set([
  "src/core",
  "src/core/analysis",
  "src/core/coord",
  "src/directory",
  "src/harbor",
  "src/platform/github",
  "src/platform/repo",
  "src/worker",
  "web/src/app",
  "web/src/chart",
  "web/src/design",
  "web/src/design/components",
  "web/src/state",
  "web/src/views",
  "web/src/views/code",
  "web/src/views/newproject",
  "web/src/views/replay",
  "web/src/views/waitlist",
]);

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
