/**
 * The left side of the code view: the filter, the file tree, its loading shape and the key hints.
 */
import { IconButton } from "../../../design/components";
import { CodeTree } from "../CodeTree";
import { ancestors } from "../tree";
import { TreeSkeleton } from "./Skeletons";
import type { CodeViewModel } from "./model";

export function TreePane({ m }: { m: CodeViewModel }) {
  const {
    showTree, filter, setFilter, setExpanded, path, showTreeSkel, rows, fileMarks, folders, onToggle, openPath, hrefOf, diffMode,
    prefetch, refText, loc, listReady, dFilter,
  } = m;
  return (
    <aside className="cv-tree" aria-label="Files" hidden={!showTree}>
      <div className="cv-tree__head">
        <label className="vh" htmlFor="cv-filter">
          Filter the files
        </label>
        <input
          id="cv-filter"
          className="b-input cv-tree__filter"
          type="search"
          placeholder="Filter files"
          autoComplete="off"
          spellCheck={false}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              e.stopPropagation();
              setFilter("");
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              (e.currentTarget.closest(".cv-tree")?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? null)?.focus();
            }
          }}
        />
        <IconButton icon="minus" label="Close all folders" size="sm" onClick={() => setExpanded(new Set(path ? ancestors(path) : []))} />
      </div>
      {showTreeSkel ? (
        <TreeSkeleton />
      ) : (
        <CodeTree
          rows={rows}
          selectedPath={path}
          fileMarks={fileMarks}
          folderMarks={folders}
          onToggle={onToggle}
          onOpen={openPath}
          hrefOf={hrefOf}
          onPrefetch={diffMode ? undefined : prefetch}
          label={diffMode ? "Changed files" : `Files of ${refText}`}
          revealKey={loc.ref}
          emptyText={!listReady ? "" : dFilter ? `No file matches “${dFilter}”.` : diffMode ? "No changes yet." : "No files."}
        />
      )}
      <p className="cv-keys" aria-hidden="true">
        <kbd className="b-kbd">t</kbd> find <kbd className="b-kbd">w</kbd> ref <kbd className="b-kbd">l</kbd> line <kbd className="b-kbd">y</kbd> link <kbd className="b-kbd">j</kbd>
        <kbd className="b-kbd">k</kbd> marks
      </p>
    </aside>
  );
}
