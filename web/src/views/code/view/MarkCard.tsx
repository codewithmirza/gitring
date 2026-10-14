/**
 * The card under a line mark: which agents work on that line, or which change request keeps an agent out.
 */
import { Link } from "../../../app/router";
import { ago, ATTEMPT_STATUS_TEXT } from "../../../state/format";
import { lineRangeText } from "../../labels";
import type { Lane } from "../annotations";
import { CodeLink } from "../CodeLink";
import { Dot } from "./Dot";

export function MarkCard({ lanes, line, path, now }: { lanes: Lane[]; line: number; path: string; now: number }) {
  const here = lanes.filter((l) => l.ranges.some((r) => line >= Math.min(r[0], r[1]) && line <= Math.max(r[0], r[1])));
  if (!here.length) return <p className="cv-markcard__none">No agent works on line {line}.</p>;
  return (
    <div className="cv-markcard">
      {here.map((l) => {
        const range = l.ranges.find((r) => line >= Math.min(r[0], r[1]) && line <= Math.max(r[0], r[1]))!;
        if (l.kind === "keepout" && l.keep) {
          const k = l.keep;
          return (
            <section key={l.key} className="cv-markcard__item is-keep">
              <p className="cv-markcard__title">
                <span className="cv-keep" aria-hidden="true" /> Change request to <strong>{k.to?.callsign ?? "an agent"}</strong>
              </p>
              <p>
                Keep out of {lineRangeText(range)}.{k.from ? ` ${k.from.callsign} changes these lines.` : ""}
              </p>
              <p className="cv-markcard__msg voice-agent">{k.correction.message}</p>
              <p className="cv-markcard__meta">
                {k.correction.status === "acknowledged" ? "The agent acknowledged it" : k.correction.status === "closed" ? "Closed at merge" : k.correction.status === "delivered" ? "Sent to the agent" : "Not sent to the agent yet"}
              </p>
              <p className="cv-markcard__meta">Made {ago(k.correction.createdAt, now)}</p>
              <div className="cv-markcard__actions">
                {k.to && (
                  <Link className="b-btn b-btn--secondary b-btn--sm" to={`/tasks/${encodeURIComponent(k.to.intentId)}`}>
                    Open the task
                  </Link>
                )}
                {k.from && (
                  <CodeLink className="b-btn b-btn--ghost b-btn--sm" to={{ ref: k.from.id, path, view: "diff" }}>
                    Show the change of {k.from.callsign}
                  </CodeLink>
                )}
              </div>
            </section>
          );
        }
        const wc = l.wc!;
        return (
          <section key={l.key} className="cv-markcard__item">
            <p className="cv-markcard__title">
              <Dot color={wc.color} /> <strong>{wc.callsign}</strong> changes {lineRangeText(range)}
            </p>
            <p className="voice-human cv-markcard__task">{wc.intentTitle}</p>
            {l.approx && <p className="cv-markcard__note">These line numbers are on the base of its work copy. Main moved since then, so they can be a little off.</p>}
            {wc.approach && <p className="cv-markcard__msg voice-agent">{wc.approach}</p>}
            <p className="cv-markcard__meta">{ATTEMPT_STATUS_TEXT[wc.status]}</p>
            <p className="cv-markcard__meta">Updated {ago(wc.updatedAt, now)}</p>
            <div className="cv-markcard__actions">
              <CodeLink className="b-btn b-btn--secondary b-btn--sm" to={{ ref: wc.id, path, view: "diff" }}>
                Show the change
              </CodeLink>
              <Link className="b-btn b-btn--ghost b-btn--sm" to={`/overview?v=${encodeURIComponent(wc.id)}`}>
                Open the work copy
              </Link>
            </div>
          </section>
        );
      })}
    </div>
  );
}
