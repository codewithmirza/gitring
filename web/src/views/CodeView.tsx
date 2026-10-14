/**
 * The code page: the real files of main, of each active work copy and of past merges, with live marks.
 * The marks where agents work come from the live state, so the page makes no extra requests for them.
 *
 *   left   the file tree (virtual list, filter, folders open where agents work)
 *   right  the file: line numbers, colors, soft wrap; a gutter with each agent's changed lines and the
 *          lines that change requests keep agents out of; "who works here" above the code.
 *   top    the ref switcher (w), Code | Diff for a work copy (d), Find file (t), Go to line (l),
 *          Copy link with the commit (y), the tree on or off ([), j / k between marks, Clone (members:
 *          a git clone command with a 6-hour read token).
 *
 * Address: /code/<ref>/<path>?view=diff#L10-L20 (see ./code/links). The path stays in the address,
 * so every view of a file has a link.
 *
 * This file only puts the page together. The state is in code/view/model.ts (one hook for each concern),
 * and each part of the screen is a pane in code/view/. Read code/view/README.md first.
 */
import { Popover } from "../design/components";
import { MarkCard } from "./code/view/MarkCard";
import { CodeToolbar } from "./code/view/CodeToolbar";
import { FilePane } from "./code/view/FilePane";
import { TreePane } from "./code/view/TreePane";
import { useCodeView } from "./code/view/model";
import "./code/code.css";

export { codeHref } from "./code/links";

export function CodeView() {
  const m = useCodeView();
  const { showTree, narrow, phonePanel, projectName, path, markAt, setMarkAt, lanes, now } = m;
  return (
    <div className={["cv", showTree ? "has-tree" : "no-tree", narrow ? "is-narrow" : ""].join(" ")} data-panel={narrow ? phonePanel : undefined}>
      <h1 className="vh" tabIndex={-1}>
        Code of {projectName}
        {path ? `: ${path}` : ""}
      </h1>

      <CodeToolbar m={m} />

      <div className="cv-body">
        <TreePane m={m} />

        <FilePane m={m} />
      </div>

      <Popover anchor={markAt?.el ?? null} open={Boolean(markAt)} onClose={() => setMarkAt(null)} label={`Who works on line ${markAt?.line ?? ""}`} align="start">
        {markAt && path && <MarkCard lanes={lanes} line={markAt.line} path={path} now={now} />}
      </Popover>
    </div>
  );
}
