import { useMemo, useState } from "react";
import { Icon } from "../icons";
import { Button } from "./Button";

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

function FileDiff({ file, large, defaultOpen = true }: { file: DiffFileLike; large?: boolean; defaultOpen?: boolean }) {
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
                return (
                  <tr key={i} className={r.kind === "add" ? "is-add" : r.kind === "del" ? "is-del" : undefined}>
                    <td className="b-diff__ln">{r.a ?? ""}</td>
                    <td className="b-diff__ln">{r.b ?? ""}</td>
                    <td className="b-diff__sign" aria-label={r.kind === "add" ? "added" : r.kind === "del" ? "removed" : undefined}>
                      {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
                    </td>
                    <td className="b-diff__code">{r.text || " "}</td>
                  </tr>
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

/** DiffView: unified, mono, line numbers, +/− gutters, hunk headers, collapsed unchanged regions. */
export function DiffView({ files, large, empty = "No changes." }: { files: DiffFileLike[]; large?: boolean; empty?: string }) {
  if (!files.length) return <p className="b-diff__empty">{empty}</p>;
  return (
    <div className={["b-diff", large && "b-diff--lg"].filter(Boolean).join(" ")}>
      {files.map((f) => (
        <FileDiff key={f.path} file={f} large={large} />
      ))}
    </div>
  );
}
