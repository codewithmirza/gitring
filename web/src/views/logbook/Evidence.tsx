/**
 * The proof parts of a merge record: the merge ladder (which method was used), the evidence of a conflict check and the table of checks.
 */
import { Fragment, useState } from "react";
import type { CourseCheck, LandingMethod } from "../../../../src/core/types";
import { Badge } from "../../design/components";
import { Icon, type IconName } from "../../design/icons";
import { checkSourceText, clock, prob, shortSha, TRIGGER_TEXT, VERDICT_TEXT } from "../../state/format";
import { lineRangeText } from "../labels";
import { codeHref } from "../code/links";
import { openInApp, withProject } from "./links";

/** Merge methods, in the order gitring tries them. */
const LADDER: { method: LandingMethod; title: string; rule: string; icon: IconName }[] = [
  { method: "fast-forward", title: "Fast-forward", rule: "main is the base of the work copy", icon: "fastforward" },
  { method: "merge", title: "3-way merge", rule: "the text merge is clean", icon: "merge" },
  { method: "rederive", title: "Redo", rule: "an agent does the task again on the new main", icon: "rederive" },
];

export function Ladder({ method, baseSha, mainBefore }: { method: LandingMethod; baseSha?: string; mainBefore: string }) {
  const used = LADDER.findIndex((l) => l.method === method);
  return (
    <ol className="ladder" aria-label="Merge methods">
      {LADDER.map((l, i) => {
        const state = i < used ? "skipped" : i === used ? "used" : "unused";
        let why = "";
        if (state === "skipped") {
          why = i === 0 ? `main moved: base ${shortSha(baseSha)} ≠ main ${shortSha(mainBefore)}` : "the merge has conflicts, or the tests fail on the combined code";
        } else if (state === "used") why = `used: ${l.rule}`;
        else why = "not needed";
        return (
          <li key={l.method} className={`ladder__rung is-${state}`}>
            <span className="ladder__n voice-agent">{i + 1}</span>
            <Icon name={state === "skipped" ? "cross" : state === "used" ? l.icon : "ring"} size={14} />
            <span className="ladder__title">{l.title}</span>
            <span className="ladder__why">{why}</span>
          </li>
        );
      })}
    </ol>
  );
}

function verdictBadge(c: CourseCheck) {
  if (c.verdict === "clear")
    return (
      <Badge tone="clear" icon="check">
        {VERDICT_TEXT.clear}
      </Badge>
    );
  if (c.verdict === "correct")
    return (
      <Badge tone="correction" icon="buoy">
        {VERDICT_TEXT.correct}
      </Badge>
    );
  return (
    <Badge tone="caution" icon="lighthouse">
      {VERDICT_TEXT[c.verdict] ?? c.verdict}
    </Badge>
  );
}

/** What a conflict check saw, for one other work copy: shared files, overlapping lines, interfaces. */
function Evidence({ c, names, mainAfter }: { c: CourseCheck; names: (id: string) => string; mainAfter: string }) {
  if (!c.facts.length) return <p className="ink-3">No other work was near. Nothing to compare.</p>;
  return (
    <ul className="evid" role="list">
      {c.facts.map((f) => {
        const a = c.assessments.find((x) => x.otherAttemptId === f.otherAttemptId);
        return (
          <li key={f.otherAttemptId} className="evid__item">
            <p className="evid__head">
              Near <strong className="voice-agent">{names(f.otherAttemptId)}</strong> ({f.otherState === "landed" ? "merged" : f.otherState === "waiting" ? "waits to merge" : "works"}) · distance {f.range}
              {f.closing ? " · closer now" : ""}
              {a ? ` · collision ${prob(a.collision)} · ${a.giveWay === "incoming" ? "this work adapts" : "the other work adapts"}` : ""}
            </p>
            {f.sharedFiles.length > 0 && (
              <p>
                Same files:{" "}
                {f.sharedFiles.map((p, i) => (
                  <Fragment key={p}>
                    {i > 0 && ", "}
                    <a className="voice-agent" href={withProject(codeHref(p, mainAfter))} onClick={(e) => openInApp(e, codeHref(p, mainAfter))}>
                      {p}
                    </a>
                  </Fragment>
                ))}
              </p>
            )}
            {f.hunkOverlaps.length > 0 && (
              <p>
                Same lines:{" "}
                {f.hunkOverlaps.map((h, i) => (
                  <Fragment key={i}>
                    {i > 0 && "; "}
                    <span className="voice-agent">{h.path}</span> {lineRangeText(h.incoming)} and {lineRangeText(h.other)}
                  </Fragment>
                ))}
              </p>
            )}
            {f.interfaceHits.length > 0 && (
              <p>
                Interfaces:{" "}
                {f.interfaceHits.map((h, i) => (
                  <Fragment key={i}>
                    {i > 0 && "; "}
                    <span className="voice-agent">{h.symbol}</span> changed by {h.changedBy === "incoming" ? "this work" : names(f.otherAttemptId)}
                    {h.usedAt.length ? `, used in ${h.usedAt.slice(0, 3).join(", ")}` : ""}
                  </Fragment>
                ))}
              </p>
            )}
            {f.sharedSymbols.length > 0 && (
              <p>
                Same functions: <span className="voice-agent">{f.sharedSymbols.slice(0, 6).join(", ")}</span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ChecksTable({ checks, names, incoming, mainAfter }: { checks: CourseCheck[]; names: (id: string) => string; incoming: string; mainAfter: string }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(checks.filter((c) => c.verdict !== "clear").slice(-1).map((c) => c.id)));
  if (!checks.length) return <p className="ink-3">No conflict checks recorded.</p>;
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className="ctable-wrap">
      <table className="ctable">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">After</th>
            <th scope="col">Result</th>
            <th scope="col">Decided by</th>
            <th scope="col">Duration</th>
            <th scope="col">Confidence</th>
            <th scope="col">Work nearby</th>
            <th scope="col">
              <span className="vh">Evidence</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => {
            const isOpen = open.has(c.id);
            return (
              <Fragment key={c.id}>
                <tr className={isOpen ? "is-open" : undefined}>
                  <td className="voice-agent">{clock(c.at)}</td>
                  <td>{TRIGGER_TEXT[c.trigger] ?? c.trigger}</td>
                  <td>{verdictBadge(c)}</td>
                  <td>{checkSourceText(c.source)}</td>
                  <td className="voice-agent">{c.latencyMs} ms</td>
                  <td className="voice-agent">{prob(c.confidence)}</td>
                  <td className="voice-agent ink-2">{c.assessments.length ? c.assessments.map((a) => `${names(a.otherAttemptId)} ${prob(a.collision)}`).join(" · ") : `no work near ${incoming}`}</td>
                  <td>
                    <button type="button" className="ctable__why" aria-expanded={isOpen} aria-controls={`ev-${c.id}`} onClick={() => toggle(c.id)}>
                      {isOpen ? "Hide why" : "Why"}
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="ctable__evrow">
                    <td colSpan={8} id={`ev-${c.id}`}>
                      <Evidence c={c} names={names} mainAfter={mainAfter} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
