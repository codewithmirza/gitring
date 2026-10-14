/**
 * The toolbar of the code view: files button, ref switcher, Code or Diff, Find file and Clone.
 */
import { Icon } from "../../../design/icons";
import { plural } from "../../../state/format";
import { CodeLink } from "../CodeLink";
import { FileFinder, RefPicker } from "../pickers";
import { CloneButton } from "../CloneButton";
import type { CodeViewModel } from "./model";

export function CodeToolbar({ m }: { m: CodeViewModel }) {
  const {
    showTree, narrow, setPhonePanel, phonePanel, setTreeOn, treeOn, refBtn, refOpen, refText, setRefOpen, refLabel, refOptions,
    chooseRef, diffMode, loc, findBtn, findOpen, setFindOpen, allPaths, finderMarks, hrefOf, openPath, diffFiles, treeReady, files,
    canAct, projectId, importing, info,
  } = m;
  const isWork = info.kind === "work";
  return (
    <div className="cv-bar" role="toolbar" aria-label="Code">
      <button
        type="button"
        className="cv-iconbtn cv-bar__files"
        aria-pressed={showTree}
        aria-label={showTree ? "Hide the files" : "Show the files"}
        title={narrow ? "Files" : "Show or hide the files ( [ )"}
        onClick={() => (narrow ? setPhonePanel(phonePanel === "tree" ? "file" : "tree") : setTreeOn(!treeOn))}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M2 2.75h12v10.5H2Z M6 2.75v10.5" />
        </svg>
        {narrow && <span>Files</span>}
      </button>

      <button
        ref={refBtn}
        type="button"
        className="cv-refbtn"
        aria-haspopup="dialog"
        aria-expanded={refOpen}
        aria-label={`Ref: ${refText}. Switch to main or a work copy.`}
        onClick={() => setRefOpen(!refOpen)}
      >
        {refLabel}
        <Icon name="chevron-down" size={12} />
      </button>
      <RefPicker anchor={refBtn.current} open={refOpen} onClose={() => setRefOpen(false)} options={refOptions} onChoose={chooseRef} />

      {isWork && (
        <div className="cv-seg" role="group" aria-label="Show the code or the changes (d)">
          <CodeLink aria-current={!diffMode ? "true" : undefined} className="cv-seg__opt" to={{ ref: loc.ref, path: loc.path, view: "code" }} replace>
            Code
          </CodeLink>
          <CodeLink aria-current={diffMode ? "true" : undefined} className="cv-seg__opt" to={{ ref: loc.ref, path: loc.path, view: "diff" }} replace>
            Diff
          </CodeLink>
        </div>
      )}

      <button ref={findBtn} type="button" className="cv-findbtn" aria-haspopup="dialog" aria-expanded={findOpen} onClick={() => setFindOpen(!findOpen)}>
        <Icon name="filter" size={14} />
        <span className="cv-findbtn__text">Find file</span>
        <kbd className="b-kbd">t</kbd>
      </button>
      <FileFinder
        anchor={findBtn.current}
        open={findOpen}
        onClose={() => setFindOpen(false)}
        paths={allPaths}
        marks={finderMarks}
        onChoose={(p, newTab) => {
          setFindOpen(false);
          if (newTab) window.open(hrefOf(p), "_blank", "noopener");
          else openPath(p);
        }}
      />

      <span className="cv-bar__meta">
        {diffMode && diffFiles
          ? `${plural(diffFiles.length, "file")} changed`
          : treeReady
            ? `${plural(files.length, "file")}`
            : ""}
      </span>
      {canAct && projectId && !importing && <CloneButton project={projectId} />}
    </div>
  );
}
