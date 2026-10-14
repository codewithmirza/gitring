/**
 * A work copy against its base, as one file or as every changed file.
 * It shows unified rows with old and new line numbers, colors for the code, and collapsed unchanged lines.
 * Long diffs show their first rows and a button for the rest.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { inSelection, LineRequestForm, parseUnified, pickLine, type LineRequestInput, type LineSelection } from "../../design/components";
import { Icon } from "../../design/icons";
import type { DiffFile } from "../../state/api";
import { CLASS_NAMES, languageOf, tokenizeAll } from "./highlight";
import { CodeLink } from "./CodeLink";
import type { CodeLocation } from "./links";

/* ───────────── constants and types ───────────── */

const STATUS_TEXT = { A: "Added", M: "Changed", D: "Deleted" } as const;
const FIRST_ROWS = 1200;

type DiffRow = ReturnType<typeof parseUnified>[number];

/* ───────────── helpers ───────────── */

function Code({ text, tokens }: { text: string; tokens: number[] | undefined }): ReactNode {
  if (!text) return "​";
  if (!tokens?.length) return text;
  const out: ReactNode[] = [];
  let p = 0;
  for (let k = 0; k < tokens.length; k += 2) {
    const end = tokens[k];
    if (end <= p) continue;
    const cls = tokens[k + 1];
    out.push(cls ? <span key={k} className={CLASS_NAMES[cls]}>{text.slice(p, end)}</span> : text.slice(p, end));
    p = end;
  }
  if (p < text.length) out.push(text.slice(p));
  return out;
}

/** Colors for diff rows: the new side (context + added) and the old side (context + removed) each read as code. */
function diffTokens(rows: DiffRow[], path: string): (number[] | undefined)[] {
  const info = languageOf(path);
  if (!info) return [];
  const newIdx: number[] = [];
  const oldIdx: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === "add" || r.kind === "ctx") newIdx.push(i);
    if (r.kind === "del") oldIdx.push(i);
  });
  const out: (number[] | undefined)[] = new Array(rows.length);
  const text = (i: number) => (rows[i] as { text: string }).text;
  const nt = tokenizeAll(info, newIdx.map(text));
  newIdx.forEach((ri, k) => (out[ri] = nt[k]));
  const ot = tokenizeAll(info, oldIdx.map(text));
  oldIdx.forEach((ri, k) => (out[ri] = ot[k]));
  return out;
}

/* ───────────── the diff ───────────── */

/**
 * `onRequest`: a person may ask the agent to change lines of this work copy. The new line numbers become
 * buttons (Shift selects more lines), and the form opens under the selected lines.
 */
export function FileDiff({
  file,
  open,
  headingLevel = 2,
  onRequest,
}: {
  file: DiffFile;
  open?: Partial<CodeLocation> & { ref: string };
  headingLevel?: 2 | 3;
  onRequest?: (input: LineRequestInput) => Promise<void>;
}) {
  const rows = useMemo(() => parseUnified(file.diff), [file.diff]);
  const [sel, setSel] = useState<LineSelection | null>(null);
  const tokens = useMemo(() => (file.diff.length < 400_000 ? diffTokens(rows, file.path) : []), [rows, file.path, file.diff.length]);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="cv-diff" aria-label={`${STATUS_TEXT[file.status]}: ${file.path}`}>
      <header className="cv-diff__head">
        <span className={`cv-own cv-own--${file.status}`} aria-hidden="true">
          {file.status}
        </span>
        <H className="cv-diff__path voice-agent">
          <span className="vh">{STATUS_TEXT[file.status]}: </span>
          {file.path}
        </H>
        <span className="cv-diff__stat voice-agent">
          <span className="cv-plus">+{file.additions}</span> <span className="cv-minus">−{file.deletions}</span>
        </span>
        {open && file.status !== "D" && (
          <CodeLink className="cv-diff__open" to={open}>
            Open the file
          </CodeLink>
        )}
      </header>
      {rows.length === 0 ? (
        <p className="cv-diff__none">{file.status === "D" ? "The work copy deletes this file." : "No line changes (a binary file or a mode change)."}</p>
      ) : (
        <div className="cv-diff__body" role="table" aria-label={`Changes in ${file.path}`}>
          {shown.map((r, i) => {
            if (r.kind === "hunk") {
              return (
                <div key={i} className="cv-drow cv-drow--hunk" role="row">
                  <span role="cell" className="cv-drow__hunk voice-agent">
                    {r.text}
                  </span>
                </div>
              );
            }
            if (r.kind === "gap") {
              return (
                <div key={i} className="cv-drow cv-drow--gap" role="row">
                  <span role="cell">
                    {r.lines} unchanged {r.lines === 1 ? "line" : "lines"}
                  </span>
                </div>
              );
            }
            const picked = onRequest ? inSelection(sel, file.path, r.b) : false;
            return (
              <Fragment key={i}>
                <div className={`cv-drow cv-drow--${r.kind}${picked ? " is-picked" : ""}`} role="row">
                  <span className="cv-drow__n" role="cell" aria-hidden="true" data-n={r.a ?? ""} />
                  {onRequest && r.b !== undefined ? (
                    <span className="cv-drow__n cv-drow__n--btn" role="cell">
                      <button
                        type="button"
                        className="cv-drow__nbtn"
                        data-n={r.b}
                        aria-pressed={picked}
                        aria-label={`Ask the agent to change ${file.path} line ${r.b}`}
                        title="Ask the agent to change this line. Shift-click selects more lines."
                        onClick={(e) => setSel((s) => pickLine(s, file.path, r.b!, e.shiftKey))}
                      />
                    </span>
                  ) : (
                    <span className="cv-drow__n" role="cell" aria-hidden="true" data-n={r.b ?? ""} />
                  )}
                  <span className="cv-drow__sign" role="cell">
                    {r.kind === "add" ? (
                      <>
                        <span aria-hidden="true">+</span>
                        <span className="vh">Added</span>
                      </>
                    ) : r.kind === "del" ? (
                      <>
                        <span aria-hidden="true">−</span>
                        <span className="vh">Removed</span>
                      </>
                    ) : null}
                  </span>
                  <span className="cv-drow__code" role="cell">
                    <Code text={r.text} tokens={tokens[i]} />
                  </span>
                </div>
                {onRequest && sel && picked && r.b === sel.to && (
                  <div className="cv-drow cv-drow--request" role="row">
                    <span role="cell">
                      <LineRequestForm
                        sel={sel}
                        onSend={async (input) => {
                          await onRequest(input);
                          setSel(null);
                        }}
                        onCancel={() => setSel(null)}
                      />
                    </span>
                  </div>
                )}
              </Fragment>
            );
          })}
          {!all && rows.length > FIRST_ROWS && (
            <div className="cv-drow cv-drow--more" role="row">
              <span role="cell">
                <button type="button" className="cv-linkbtn" onClick={() => setAll(true)}>
                  Show the other {rows.length - FIRST_ROWS} lines
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Every changed file of a work copy, with a short list at the top. */
export function AllDiffs({ files, openOf, onRequest }: { files: DiffFile[]; openOf: (path: string) => Partial<CodeLocation> & { ref: string }; onRequest?: (input: LineRequestInput) => Promise<void> }) {
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  if (!files.length) return <p className="cv-note">This work copy has no changes yet.</p>;
  return (
    <div className="cv-alldiffs">
      <p className="cv-alldiffs__sum">
        <Icon name="diff" size={14} /> {files.length} {files.length === 1 ? "file" : "files"} changed ·{" "}
        <span className="voice-agent">
          <span className="cv-plus">+{adds}</span> <span className="cv-minus">−{dels}</span>
        </span>
      </p>
      {files.map((f) => (
        <FileDiff key={f.path} file={f} open={openOf(f.path)} headingLevel={3} onRequest={onRequest} />
      ))}
    </div>
  );
}
