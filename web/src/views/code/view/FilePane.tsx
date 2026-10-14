/**
 * The right side of the code view: the file header, the strip of who works here, and the body.
 */
import { kb, plural } from "../../../state/format";
import { langLabel } from "../../labels";
import { WRAP_MAX } from "../CodeLines";
import { LinePicker, MoreMenu } from "../pickers";
import { LineHistory } from "../LineHistory";
import { ancestors } from "../tree";
import { ContextStrip } from "./ContextStrip";
import type { CodeViewModel } from "./model";

export function FilePane({ m }: { m: CodeViewModel }) {
  const {
    path, diffMode, info, setExpanded, narrow, setPhonePanel, setTreeOn, text, lineBtn, lineOpen, setLineOpen, lineCount, copied,
    selectLines, setFlash, jumpTo, projectId, whyRef, loc, fileVersion, now, wrap, setWrap, copyPermalink, githubHref, copy,
    rawHref, marks, lastMerges, own, main, files,
  } = m;
  const fileSize = path ? files.find((f) => f.path === path)?.size : undefined;
  const crumbs = path ? path.split("/") : [];
  return (
    <section className="cv-main" aria-label={path ? `File ${path}` : "Files"}>
      {path && !diffMode && info.kind !== "ended" && info.kind !== "unknown" && (
        <header className="cv-filehead">
          <nav className="cv-crumbs voice-agent" aria-label="Path">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              const dir = crumbs.slice(0, i + 1).join("/");
              return (
                <span key={dir} className="cv-crumbs__part">
                  {last ? (
                    <span aria-current="page" className="cv-crumbs__file">
                      {c}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="cv-crumbs__dir"
                      onClick={() => {
                        setExpanded((s) => new Set([...s, ...ancestors(`${dir}/x`)]));
                        if (narrow) setPhonePanel("tree");
                        else setTreeOn(true);
                      }}
                      title={`Show ${dir} in the files`}
                    >
                      {c}
                    </button>
                  )}
                  {!last && <span className="cv-crumbs__sep" aria-hidden="true">/</span>}
                </span>
              );
            })}
          </nav>
          <span className="cv-filehead__meta">
            {text?.status === "ready" && (
              <button ref={lineBtn} type="button" className="cv-metabtn" aria-haspopup="dialog" aria-expanded={lineOpen} onClick={() => setLineOpen(!lineOpen)} title="Go to a line (l)">
                {plural(lineCount, "line")}
              </button>
            )}
            {fileSize ? <span>{kb(fileSize)}</span> : null}
            <span>{langLabel(undefined, path)}</span>
            <span className="cv-copied" role="status" aria-live="polite">
              {copied === "path" ? "Path copied" : copied === "file" ? "File copied" : copied === "link" ? "Link copied" : copied?.endsWith(":fail") ? "The copy did not work. Select the text and copy it." : ""}
            </span>
          </span>
          <LinePicker
            anchor={lineBtn.current}
            open={lineOpen}
            onClose={() => setLineOpen(false)}
            max={Math.max(1, lineCount)}
            onGo={(r) => {
              setLineOpen(false);
              selectLines(r);
              setFlash(r);
              jumpTo(r[0]);
            }}
          />
          <span className="cv-filehead__acts">
            <LineHistory projectId={projectId} refName={whyRef} path={path} line={loc.lines?.[0] ?? null} version={fileVersion} now={now} />
            <button
              type="button"
              className="cv-tool"
              aria-pressed={wrap && lineCount <= WRAP_MAX}
              aria-disabled={lineCount > WRAP_MAX || undefined}
              title={lineCount > WRAP_MAX ? `Soft wrap is off for files over ${WRAP_MAX.toLocaleString("en-US")} lines.` : "Wrap long lines"}
              onClick={() => lineCount <= WRAP_MAX && setWrap(!wrap)}
            >
              Wrap
            </button>
            <button type="button" className="cv-tool" onClick={copyPermalink} title="Copy a link with the commit (y)">
              Copy link
            </button>
            {githubHref && !narrow && (
              <a className="cv-tool" href={githubHref} target="_blank" rel="noopener noreferrer">
                Open on GitHub
              </a>
            )}
            <MoreMenu
              actions={[
                { key: "line", label: "Go to line", keys: "l", disabled: text?.status !== "ready", onSelect: () => setLineOpen(true) },
                { key: "path", label: "Copy path", onSelect: () => copy("path", path) },
                { key: "file", label: "Copy file", disabled: text?.status !== "ready", onSelect: () => text?.status === "ready" && copy("file", text.data) },
                ...(rawHref ? [{ key: "raw", label: "Open raw text", href: rawHref, external: true }] : []),
                ...(githubHref && narrow ? [{ key: "gh", label: "Open on GitHub", href: githubHref, external: true }] : []),
              ]}
            />
          </span>
        </header>
      )}
      {path && !diffMode && (info.kind === "main" || info.kind === "work") && (
        <ContextStrip info={info} path={path} fm={marks.get(path)} last={lastMerges.get(path)} own={own} onShowLines={(r) => { selectLines(r); setFlash(r); jumpTo(r[0]); }} now={now} />
      )}
      {main}
    </section>
  );
}
