/**
 * Shows a unified diff as rows with line numbers. parseUnified turns diff text into rows.
 * Used by the tasks page, the history page and the approve page.
 */
import { Fragment, useMemo, useState } from "react";
import { Icon } from "../icons";
import { Button } from "./Button";
import { inSelection, LineRequestForm, linesText, pickLine, type LineRequestInput, type LineSelection } from "./LineRequest";

export interface DiffFileLike {
  path: string;
  status: "A" | "M" | "D";
  additions: number;
  deletions: number;
  diff: string;
}

type Row =
  | { kind: "hunk"; text: string }
  | { kind: "gap"; lines: number }
  | { kind: "add" | "del" | "ctx"; a?: number; b?: number; text: string };

/** Parse unified diff text into rows. Unchanged regions between hunks collapse into gap rows. */
export function parseUnified(diff: string): Row[] {
  const rows: Row[] = [];
  let a = 0;
  let b = 0;
  let lastAEnd = 0;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename )/.test(line)) continue;
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (h) {
      a = Number(h[1]);
      b = Number(h[3]);
      const gap = a - lastAEnd - 1;
      if (rows.length && gap > 0) rows.push({ kind: "gap", lines: gap });
      else if (!rows.length && a > 1) rows.push({ kind: "gap", lines: a - 1 });
      rows.push({ kind: "hunk", text: line });
      if (a === 0) a = 1;
      if (b === 0) b = 1;
      continue;
    }
    if (line.startsWith("+")) rows.push({ kind: "add", b: b++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", a: a++, text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", a: a++, b: b++, text: line.slice(1) });
    else if (line.startsWith("\\")) continue;
    else continue;
    lastAEnd = a - 1;
  }
  return rows;
}

const STATUS_TEXT = { A: "Added", M: "Changed", D: "Deleted" } as const;

/** A person may ask the agent to change lines: the new line numbers become buttons, and the form opens under the lines. */
interface LineAsk {
  sel: LineSelection | null;
  pick: (path: string, line: number, extend: boolean) => void;
  send: (input: LineRequestInput) => Promise<void>;
  cancel: () => void;
}

function FileDiff({ file, large, defaultOpen = true, ask }: { file: DiffFileLike; large?: boolean; defaultOpen?: boolean; ask?: LineAsk }) {
  const [open, setOpen] = useState(defaultOpen);
  const rows = useMemo(() => parseUnified(file.diff), [file.diff]);
  return (
    <section className="b-diff__file" aria-label={`${STATUS_TEXT[file.status]} ${file.path}`}>
      <div className="b-diff__filehead">
        <Button
          variant="ghost"
          size="sm"
          className="b-iconbtn"
          aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} />
        </Button>
        <span className="b-badge b-badge--quiet ink-3">{STATUS_TEXT[file.status]}</span>
        <span className="b-diff__path">{file.path}</span>
        <span className="b-diff__stat">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
      </div>
      {open && (
        <div className="b-diff__scroll" tabIndex={0} role="region" aria-label={`Diff of ${file.path}`}>
          <table className="b-diff__table">
            <tbody>
              {rows.map((r, i) => {
                if (r.kind === "hunk")
                  return (
                    <tr key={i} className="is-hunk">
                      <td colSpan={4}>{r.text}</td>
                    </tr>
                  );
                if (r.kind === "gap")
                  return (
                    <tr key={i} className="is-gap">
                      <td colSpan={4}>⋯ {r.lines} unchanged {r.lines === 1 ? "line" : "lines"}</td>
                    </tr>
                  );
                const picked = ask ? inSelection(ask.sel, file.path, r.b) : false;
                const formHere = ask?.sel && picked && r.b === ask.sel.to;
                return (
                  <Fragment key={i}>
                    <tr className={[r.kind === "add" ? "is-add" : r.kind === "del" ? "is-del" : "", picked ? "is-picked" : ""].filter(Boolean).join(" ") || undefined}>
                      <td className="b-diff__ln">{r.a ?? ""}</td>
                      <td className="b-diff__ln">
                        {ask && r.b !== undefined ? (
                          <button
                            type="button"
                            className="b-diff__lnbtn"
                            aria-pressed={picked}
                            aria-label={`Ask the agent to change ${file.path} line ${r.b}`}
                            title="Ask the agent to change this line. Shift-click selects more lines."
                            onClick={(e) => ask.pick(file.path, r.b!, e.shiftKey)}
                          >
                            {r.b}
                          </button>
                        ) : (
                          (r.b ?? "")
                        )}
                      </td>
                      <td className="b-diff__sign" aria-label={r.kind === "add" ? "added" : r.kind === "del" ? "removed" : undefined}>
                        {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
                      </td>
                      <td className="b-diff__code">{r.text || " "}</td>
                    </tr>
                    {formHere && ask?.sel && (
                      <tr className="is-request">
                        <td colSpan={4}>
                          <LineRequestForm sel={ask.sel} onSend={ask.send} onCancel={ask.cancel} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {large && null}
    </section>
  );
}

/**
 * DiffView: unified, mono, line numbers, +/− gutters, hunk headers, collapsed unchanged regions. With
 * `onRequest`, a person selects lines (the new line numbers) and asks the agent to change them; the promise
 * rejects with a plain sentence when the request did not go out.
 */
export function DiffView({
  files,
  large,
  empty = "No changes.",
  onlyFirstOpen,
  onRequest,
}: {
  files: DiffFileLike[];
  large?: boolean;
  empty?: string;
  onlyFirstOpen?: boolean;
  onRequest?: (input: LineRequestInput) => Promise<void>;
}) {
  const [sel, setSel] = useState<LineSelection | null>(null);
  if (!files.length) return <p className="b-diff__empty">{empty}</p>;
  const ask: LineAsk | undefined = onRequest
    ? {
        sel,
        pick: (path, line, extend) => setSel((s) => pickLine(s, path, line, extend)),
        send: async (input) => {
          await onRequest(input);
          setSel(null);
        },
        cancel: () => setSel(null),
      }
    : undefined;
  return (
    <div className={["b-diff", large && "b-diff--lg"].filter(Boolean).join(" ")}>
      {onRequest && (
        <p className="b-diff__hint">
          Select a line number to ask the agent to change that line{sel ? ` (now: ${sel.path} ${linesText(sel.from, sel.to)})` : ""}.
        </p>
      )}
      {files.map((f, i) => (
        <FileDiff key={f.path} file={f} large={large} defaultOpen={!onlyFirstOpen || i === 0} ask={ask} />
      ))}
    </div>
  );
}
