/**
 * Chooses what the right side of the code view shows: a message, a diff, an overview or code.
 * It is a plain function, not a hook. The first case that fits wins, in the order of the checks.
 */
import type { ReactNode } from "react";
import { Button, EmptyState } from "../../../design/components";
import { openNewIntent } from "../../../app/ui";
import { ago, kb, plural } from "../../../state/format";
import { CodeLines } from "../CodeLines";
import { AllDiffs, FileDiff } from "../CodeDiff";
import { CodeLink } from "../CodeLink";
import { languageOf } from "../highlight";
import { baseName } from "../tree";
import { RefOverview } from "./RefOverview";
import { LinesSkeleton } from "./Skeletons";
import type { RefLabels } from "./describeRef";
import type { CursorState } from "./useCodeCursor";
import type { PanelState } from "./useCodePanels";
import type { CodeSource } from "./useCodeSource";
import type { FileTreeState } from "./useFileTree";
import type { OpenFileState } from "./useOpenFile";

export function renderMain(source: CodeSource, treeRows: FileTreeState, openFile: OpenFileState, cursor: CursorState, panels: PanelState, labels: RefLabels) {
  const {
    info, now, loc, importing, mainFiles, canAct, tree, treeData, setRetry, diffMode, diff, path, ownByPath, marks, commitChanged,
    mergeOfCommit, intents, diffFiles,
  } = source;
  const { files } = treeRows;
  const { readme, readmePath, binary, treeReady, inTree, text, showTextSkel, lineCount, gutterLanes, byLine, head, markStarts } = openFile;
  const { flash, onLines, jump, focusMark } = cursor;
  const { wrap, onMark } = panels;
  const { refText, askAgent } = labels;
  let main: ReactNode;
  if (info.kind === "ended") {
    const merged = info.attempt.status === "landed";
    main = (
      <EmptyState
        text={merged ? `This work copy merged ${info.attempt.landedAt ? ago(info.attempt.landedAt, now) : "earlier"}. Its changes are on main now.` : "This work copy stopped. Its changes did not merge."}
        action={
          <CodeLink className="b-btn b-btn--primary" to={{ ref: "main", path: loc.path }}>
            Open main
          </CodeLink>
        }
      />
    );
  } else if (info.kind === "unknown") {
    main = (
      <EmptyState
        text="gitring does not know this ref. It is not main, an active work copy or a commit of this project."
        action={
          <CodeLink className="b-btn b-btn--primary" to={{ ref: "main", path: loc.path }}>
            Open main
          </CodeLink>
        }
      />
    );
  } else if (info.kind === "main" && importing && !mainFiles.length) {
    main = <EmptyState text={importing.error ? `The import did not finish: ${importing.error}` : "gitring imports the repository. The files show here when the import ends."} />;
  } else if (info.kind === "main" && !mainFiles.length) {
    main = (
      <EmptyState
        text="Main has no files yet. Write a task. Agents write the first files."
        action={
          canAct ? (
            <Button variant="primary" icon="plus" onClick={() => openNewIntent()}>
              Write a task
            </Button>
          ) : undefined
        }
      />
    );
  } else if (tree.status === "error" && !treeData) {
    main = (
      <EmptyState
        text={`gitring could not load the files of ${refText}. ${tree.error}`}
        action={
          <Button icon="reload" onClick={() => setRetry((r) => r + 1)}>
            Try again
          </Button>
        }
      />
    );
  } else if (diffMode) {
    if (!diff || diff.status === "loading") main = <LinesSkeleton rows={14} />;
    else if (diff.status === "error")
      main = (
        <EmptyState
          text={`gitring could not load the changes. ${diff.error}`}
          action={
            <Button icon="reload" onClick={() => setRetry((r) => r + 1)}>
              Try again
            </Button>
          }
        />
      );
    else if (path) {
      const f = ownByPath.get(path);
      main = f ? (
        <div className="cv-scroll">
          <FileDiff file={f} open={{ ref: loc.ref, path, view: "code" }} onRequest={askAgent} />
        </div>
      ) : (
        <EmptyState
          text={`${info.kind === "work" ? info.wc.callsign : "This work copy"} does not change ${baseName(path)}.`}
          action={
            <CodeLink className="b-btn b-btn--secondary" to={{ ref: loc.ref, view: "diff" }}>
              Show all changes
            </CodeLink>
          }
        />
      );
    } else
      main = (
        <div className="cv-scroll">
          <AllDiffs files={diff.data.files} openOf={(p) => ({ ref: loc.ref, path: p, view: "code" })} onRequest={askAgent} />
        </div>
      );
  } else if (!path) {
    main = <RefOverview info={info} marks={marks} readme={readme} readmePath={readmePath} now={now} commitChanged={commitChanged} mergeTitle={mergeOfCommit ? intents?.find((i) => i.id === mergeOfCommit.intentId)?.title : undefined} diffFiles={diffFiles} />;
  } else if (binary) {
    main = <EmptyState text={`gitring does not show binary files${files.find((f) => f.path === path)?.size ? ` (${kb(files.find((f) => f.path === path)!.size)})` : ""}.`} />;
  } else if (treeReady && !inTree) {
    main = (
      <EmptyState
        text={`${baseName(path)} is not on ${refText}. It was deleted or moved, or it does not exist yet.`}
        action={
          info.kind !== "main" ? (
            <CodeLink className="b-btn b-btn--secondary" to={{ ref: "main", path }}>
              Look on main
            </CodeLink>
          ) : undefined
        }
      />
    );
  } else if (!text || text.status === "loading") {
    main = showTextSkel ? <LinesSkeleton /> : <div className="cv-wait" aria-busy="true" />;
  } else if (text.status === "error") {
    main =
      text.code === 404 ? (
        <EmptyState text="gitring does not show this file. It is binary or very large." />
      ) : (
        <EmptyState
          text={`gitring could not load this file. ${text.error}`}
          action={
            <Button icon="reload" onClick={() => setRetry((r) => r + 1)}>
              Try again
            </Button>
          }
        />
      );
  } else {
    main = (
      <CodeLines
        text={text.data}
        info={languageOf(path)}
        label={`${path}, ${plural(lineCount, "line")}`}
        wrap={wrap}
        lanes={gutterLanes}
        byLine={byLine}
        head={head}
        selected={loc.lines}
        flash={flash}
        onLines={onLines}
        onMark={onMark}
        jump={jump}
        markStarts={markStarts}
        focusMark={focusMark}
      />
    );
  }

  return main;
}
