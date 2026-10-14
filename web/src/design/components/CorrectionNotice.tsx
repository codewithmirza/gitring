import { useId, useState } from "react";
import type { Correction, CourseCheck } from "../../../../src/core/types";
import { ago, codeSpans, CORRECTION_KIND_TEXT, ruleLabel } from "../../state/format";
import { Icon } from "../icons";
import { CourseCheckReadout } from "./CourseCheckReadout";

interface CorrectionNoticeProps {
  correction: Correction;
  /** Name of the agent that continues. */
  from?: string;
  /** Name of the agent that adapts (the receiver). */
  to: string;
  check?: CourseCheck;
  nameOf?: (attemptId: string) => string;
  size?: "sm" | "lg";
  /** Open the conflict check readout at first render. */
  expanded?: boolean;
  now?: number;
}

const STATUS = {
  pending: { icon: "clock" as const, text: "Pending" },
  delivered: { icon: "send" as const, text: "Delivered" },
  acknowledged: { icon: "check" as const, text: "Acknowledged" },
  superseded: { icon: "cross" as const, text: "Replaced" },
  // The work merged before the agent confirmed the change request.
  closed: { icon: "merge" as const, text: "Closed at merge" },
};

/** A rebase change request carries the agent's earlier diffs after the sentences, as ```diff blocks. */
function splitDiffs(message: string): { text: string; diffs: { path: string; diff: string }[] } {
  const diffs: { path: string; diff: string }[] = [];
  const re = /\n\nYour earlier change to ([^\n:]+):\n```diff\n([\s\S]*?)\n```/g;
  const text = message.replace(re, (_m, path: string, diff: string) => {
    diffs.push({ path, diff });
    return "";
  });
  return { text: text.trim(), diffs };
}

export function CorrectionMessage({ text }: { text: string }) {
  return (
    <>
      {codeSpans(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/**
 * CorrectionNotice: a change request to an agent. Magenta 2px rule, marker icon,
 * kind, STE message, constraints, status. Not a card: no shadow, a 6% tint only.
 */
export function CorrectionNotice({ correction: c, from, to, check, nameOf, size = "sm", expanded = false, now = Date.now() }: CorrectionNoticeProps) {
  const [open, setOpen] = useState(expanded);
  const rid = useId();
  const st = STATUS[c.status];
  // Other agents edit the same lines: one change request names them all.
  const more = c.alsoStandOn?.length ?? 0;
  const constraints = [
    ...(c.constraints.useSignatures ?? []).map((s) => `Use ${s.signature}`),
    ...(c.constraints.avoidRegions ?? []).map((r) => `Keep out of ${r.path}, ${r.lines[0] === r.lines[1] ? `line ${r.lines[0]}` : `lines ${r.lines[0]}–${r.lines[1]}`}`),
    ...(c.constraints.notes ?? []),
  ];
  return (
    <article
      className={["b-corr", size === "lg" && "b-corr--lg", c.status === "superseded" && "is-superseded"].filter(Boolean).join(" ")}
      aria-label={`Change request ${c.id} for ${to}: ${CORRECTION_KIND_TEXT[c.kind]}, ${ruleLabel(c.rule)}, ${st.text}`}
    >
      <div className="b-corr__head">
        <span className="b-corr__kind">
          <Icon name="buoy" />
          {CORRECTION_KIND_TEXT[c.kind]}
        </span>
        <span className="b-corr__rule">{ruleLabel(c.rule)}</span>
        <span className={["b-corr__status", c.status === "acknowledged" && "is-acknowledged"].filter(Boolean).join(" ")}>
          <Icon name={st.icon} />
          {st.text}
        </span>
      </div>
      <p className="b-corr__msg">
        <CorrectionMessage text={splitDiffs(c.message).text} />
      </p>
      {splitDiffs(c.message).diffs.map((d) => (
        <details key={d.path} className="b-corr__diff">
          <summary>
            Your earlier change to <span className="voice-agent">{d.path}</span>
          </summary>
          <pre aria-label={`Earlier change to ${d.path}`}>
            {d.diff.split("\n").map((line, i) => (
              <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "is-add" : line.startsWith("-") && !line.startsWith("---") ? "is-del" : undefined}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </details>
      ))}
      {constraints.length > 0 && (
        <ul className="b-corr__constraints" aria-label="Constraints">
          {constraints.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      <div className="b-corr__meta">
        <span>
          {from ? (
            <>
              <span className="voice-agent ink-2">{from}</span>
              {more > 0 ? ` and ${more} more continue` : " continues"} → <span className="voice-agent ink-2">{to}</span> adapts
            </>
          ) : (
            <>
              To <span className="voice-agent ink-2">{to}</span>
            </>
          )}
        </span>
        <span>
          <span className="voice-agent">{c.id}</span> · {ago(c.createdAt, now)}
        </span>
      </div>
      {c.ackNote && (
        <div className="b-corr__meta">
          <Icon name="check" size={12} />
          <span className="b-corr__ack">“{c.ackNote}”</span>
        </div>
      )}
      {c.check?.applied === false && c.status === "delivered" && (
        <div className="b-corr__meta" role="note">
          <Icon name="info" size={12} />
          <span>The agent confirmed it, but the code check failed: {c.check.reason}</span>
        </div>
      )}
      {check && nameOf && (
        <>
          <button type="button" className="b-corr__toggle" aria-expanded={open} aria-controls={rid} onClick={() => setOpen(!open)}>
            <Icon name="chevron-right" />
            {open ? "Hide the conflict check" : "Show the conflict check"}
          </button>
          {open && (
            <div id={rid}>
              <CourseCheckReadout check={check} otherAttemptId={c.standOnAttemptId} nameOf={nameOf} incoming={nameOf(check.attemptId)} />
            </div>
          )}
        </>
      )}
    </article>
  );
}
