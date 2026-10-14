/**
 * The code page: the real files of main, of each active work copy and of past merges, with live marks.
 * The marks where agents work come from the live state, so the page makes no extra requests for them.
 * Address: /code/<ref>/<path>?view=diff#L10-L20 (see ./code/links). Every view of a file has a link.
 * The file tree is on the left and the file is on the right (line numbers, colors, a gutter with the marks of
 * agents). The toolbar has the ref switcher (w), Code or Diff (d), Find file (t), Go to line (l) and Copy link (y).
 * This file only puts the page together. Read code/view/README.md first.
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
  const model = useCodeView();
  const { showTree, narrow, phonePanel, projectName, path, markAt, setMarkAt, lanes, now, lineAnswer, loc } = model;
  // On a phone an open answer is a sheet from the bottom. The page gives the code its room above the sheet.
  const hasSheet = narrow && (lineAnswer === "history" || (lineAnswer === "why" && Boolean(loc.lines)));
  return (
    <div className={["cv", showTree ? "has-tree" : "no-tree", narrow ? "is-narrow" : "", hasSheet ? "has-sheet" : ""].join(" ")} data-panel={narrow ? phonePanel : undefined}>
      <h1 className="vh" tabIndex={-1}>
        Code of {projectName}
        {path ? `: ${path}` : ""}
      </h1>

      <CodeToolbar model={model} />

      <div className="cv-body">
        <TreePane model={model} />

        <FilePane model={model} />
      </div>

      <Popover anchor={markAt?.el ?? null} open={Boolean(markAt)} onClose={() => setMarkAt(null)} label={`Who works on line ${markAt?.line ?? ""}`} align="start">
        {markAt && path && <MarkCard lanes={lanes} line={markAt.line} path={path} now={now} />}
      </Popover>
    </div>
  );
}
