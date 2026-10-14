/**
 * The strip above the code: who works on this file, which change requests apply, the last merge.
 */
import { useState, type ReactNode } from "react";
import type { LineRange } from "../../../../../src/core/types";
import { Icon } from "../../../design/icons";
import { Link } from "../../../app/router";
import { ago, ATTEMPT_STATUS_TEXT } from "../../../state/format";
import { lineRangeText } from "../../labels";
import type { FileMarks, LastMerge } from "../annotations";
import { CodeLink } from "../CodeLink";
import type { RefInfo } from "../data";
import type { DiffFile } from "../../../state/api";
import { Dot } from "./Dot";

/** Lines of a hunk list for people: "lines 10–18 and 40–44". */
function rangesText(ranges: LineRange[]): string {
  if (!ranges.length) return "";
  const parts = ranges.slice(0, 3).map((r) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`));
  const more = ranges.length > 3 ? ` and ${ranges.length - 3} more` : "";
  return `${ranges.length === 1 && ranges[0][0] === ranges[0][1] ? "line" : "lines"} ${parts.join(", ")}${more}`;
}

/* ───────────── who works on this file ───────────── */

export function ContextStrip({
  info,
  path,
  fm,
  last,
  own,
  onShowLines,
  now,
  limit = 3,
}: {
  info: RefInfo;
  path: string;
  fm: FileMarks | undefined;
  last: LastMerge | undefined;
  own: DiffFile | undefined;
  onShowLines: (r: LineRange) => void;
  now: number;
  /** How many lines show before "Show more". A phone shows one, so that the code is on the first screen. */
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  const items: { key: string; node: ReactNode }[] = [];
  if (info.kind === "work") {
    const wc = info.wc;
    items.push({
      key: "self",
      node: (
        <>
          <Dot color={wc.color} />
          <span>
            {own ? (
              <>
                <strong>{wc.callsign}</strong> {own.status === "A" ? "adds" : own.status === "D" ? "deletes" : "changes"} this file{" "}
                <span className="voice-agent">
                  <span className="cv-plus">+{own.additions}</span> <span className="cv-minus">−{own.deletions}</span>
                </span>
              </>
            ) : (
              <>
                <strong>{wc.callsign}</strong> does not change this file
              </>
            )}{" "}
            for <span className="voice-human">{wc.intentTitle}</span>
          </span>
        </>
      ),
    });
  }
  for (const w of fm?.work ?? []) {
    if (info.kind === "work" && w.wc.id === info.wc.id) continue;
    const hunks = w.touch?.hunks ?? [];
    items.push({
      key: `w:${w.wc.id}`,
      node: (
        <>
          <Dot color={w.wc.color} ring={!w.touch} />
          <span>
            <strong>{w.wc.callsign}</strong>{" "}
            {w.touch ? (hunks.length ? `changes ${rangesText(hunks)}` : w.touch.status === "A" ? "adds this file" : w.touch.status === "D" ? "deletes this file" : "changes this file") : "plans to change this file"}
            {info.kind === "work" ? " too" : ""} for <span className="voice-human">{w.wc.intentTitle}</span>
            <span className="cv-ctx__state">{ATTEMPT_STATUS_TEXT[w.wc.status]}</span>
          </span>
          <span className="cv-ctx__acts">
            {w.touch && (
              <CodeLink to={{ ref: w.wc.id, path, view: "diff" }} className="cv-ctx__act">
                Show the change
              </CodeLink>
            )}
            <Link to={`/overview?v=${encodeURIComponent(w.wc.id)}`} className="cv-ctx__act">
              Work copy
            </Link>
          </span>
        </>
      ),
    });
  }
  for (const k of fm?.keepOut ?? []) {
    items.push({
      key: `k:${k.correction.id}:${k.lines[0]}`,
      node: (
        <>
          <span className="cv-keep" aria-hidden="true" />
          <span>
            Change request to <strong>{k.to?.callsign ?? "an agent"}</strong>: keep out of {lineRangeText(k.lines)}
            {k.from ? `. ${k.from.callsign} changes them.` : "."}
          </span>
          <span className="cv-ctx__acts">
            {info.kind !== "work" && (
              <button type="button" className="cv-ctx__act cv-linkbtn" onClick={() => onShowLines(k.lines)}>
                Show the lines
              </button>
            )}
            {k.to && (
              <Link to={`/tasks/${encodeURIComponent(k.to.intentId)}`} className="cv-ctx__act">
                Task
              </Link>
            )}
          </span>
        </>
      ),
    });
  }
  if (last && info.kind === "main") {
    items.push({
      key: "last",
      node: (
        <>
          <Icon name="anchor" size={12} />
          <span>
            Last merge: <span className="voice-human">{last.intentTitle}</span>
            {last.callsign ? ` by ${last.callsign}` : ""}
            <span className="cv-ctx__state">{ago(last.landing.at, now)}</span>
          </span>
          <span className="cv-ctx__acts">
            <Link to={`/history/${encodeURIComponent(last.landing.id)}`} className="cv-ctx__act">
              Merge record
            </Link>
          </span>
        </>
      ),
    });
  }
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, limit);
  return (
    <div className="cv-ctx">
      <h2 className="vh">Who works on this file</h2>
      <ul className="cv-ctx__list" role="list">
        {shown.map((it) => (
          <li key={it.key} className="cv-ctx__item">
            {it.node}
          </li>
        ))}
      </ul>
      {items.length > limit && (
        <button type="button" className="cv-linkbtn cv-ctx__more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show ${items.length - limit} more`}
        </button>
      )}
    </div>
  );
}
