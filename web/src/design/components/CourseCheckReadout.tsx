/**
 * The readout of a conflict check: the chance of conflict, the overlap and the chance of duplicate.
 * Each number shows beside its limit.
 * It also shows the rule that decided who gives way.
 */
import type { CourseCheck, PolicyThresholds } from "../../../../src/core/types";
import { DEFAULT_THRESHOLDS, INTERFERENCE_LEVELS } from "../../../../src/core/types";
import { checkSourceText, prob, ruleLabel, RANGE_TEXT, TRIGGER_TEXT } from "../../state/format";
import { assessmentFor, factsFor } from "../../state/selectors";
import { Icon } from "../icons";

interface ReadoutProps {
  check: CourseCheck;
  /** The other work copy of the pair to show (defaults to the first assessment). */
  otherAttemptId?: string;
  thresholds?: PolicyThresholds;
  /** Agent name for a work copy id. */
  nameOf: (attemptId: string) => string;
  /** Name of the agent whose plan was checked. */
  incoming: string;
}

function Bar({ value, max = 1, threshold, label, text }: { value: number; max?: number; threshold: number; label: string; text?: string }) {
  const over = value >= threshold;
  return (
    <>
      <span className="b-readout__label">{label}</span>
      <span
        className="b-readout__bar"
        role="img"
        aria-label={`${label} ${prob(value)}${text ? ` (${text})` : ""}. Threshold ${prob(threshold)}.`}
      >
        <span className={["b-readout__fill", over && "is-over"].filter(Boolean).join(" ")} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
        <span className="b-readout__tick" style={{ left: `${(threshold / max) * 100}%` }} title={`Threshold ${prob(threshold)}`} />
      </span>
      <span className={["b-readout__num", over && "is-over"].filter(Boolean).join(" ")}>{max === 1 ? prob(value) : value.toFixed(1)}</span>
    </>
  );
}

/**
 * CourseCheckReadout: the conflict check as bars with the policy threshold marked,
 * the agent that adapts and the rule. Every number shows its source.
 */
export function CourseCheckReadout({ check, otherAttemptId, thresholds = DEFAULT_THRESHOLDS, nameOf, incoming }: ReadoutProps) {
  const a = assessmentFor(check, otherAttemptId);
  const f = factsFor(check, a?.otherAttemptId ?? otherAttemptId);
  const raw = check.raw as { escalatedFrom?: { source: string; confidence: number; latencyMs: number } } | undefined;
  const level = a ? INTERFERENCE_LEVELS[Math.max(0, Math.min(4, Math.round(a.interference)))].split(":")[0] : "";
  const giveWayName = a ? (a.giveWay === "incoming" ? incoming : nameOf(a.otherAttemptId)) : "";
  return (
    <div className="b-readout">
      <div className="b-readout__src">
        <span className="b-readout__tag" title="Who decided">
          {checkSourceText(check.source)}
        </span>
        <span className="voice-agent">{check.latencyMs} ms</span>
        <span>·</span>
        <span>
          confidence <span className="voice-agent ink-1">{prob(check.confidence)}</span>
        </span>
        <span>·</span>
        <span>after {TRIGGER_TEXT[check.trigger] ?? check.trigger}</span>
        {raw?.escalatedFrom && (
          <span className="ink-2">
            · asked again: the {checkSourceText(raw.escalatedFrom.source)} was not sure (confidence{" "}
            <span className="voice-agent">{prob(raw.escalatedFrom.confidence)}</span> &lt; <span className="voice-agent">{prob(thresholds.minConfidence)}</span>)
          </span>
        )}
      </div>
      {!a ? (
        <p className="ink-2">No other work is near. gitring passed the plan without a model call.</p>
      ) : (
        <>
          <div className="b-readout__grid">
            <Bar label="Chance of conflict" value={a.collision} threshold={thresholds.collision} />
            <Bar label="Overlap" value={a.interference} max={4} threshold={thresholds.interference} text={level} />
            <Bar label="Chance of duplicate" value={a.duplicate} threshold={thresholds.duplicate} />
          </div>
          <div className="b-readout__giveway">
            <Icon name="compass" size={12} />
            <span>
              Adapts: <span className="voice-agent ink-1">{giveWayName}</span> (
              <span className="voice-agent">{prob(a.giveWayConfidence)}</span>) · {ruleLabel(a.rule)}
            </span>
          </div>
          {f && (
            <div className="b-readout__facts">
              <span>
                Distance {f.range}: {RANGE_TEXT[f.range]}
                {f.previousRange !== undefined && f.previousRange !== f.range ? ` (was ${f.previousRange})` : ""}
                {f.closing ? " · closer now" : ""}
              </span>
              {f.sharedFiles.length > 0 && <span>files {f.sharedFiles.join(", ")}</span>}
              {f.sharedSymbols.length > 0 && <span>functions {f.sharedSymbols.map((s) => s.split("#")[1]).join(", ")}</span>}
              {[...new Set(f.interfaceHits.map((h) => h.symbol))].map((sym) => (
                <span key={sym}>interface {sym.split("#")[1]}</span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
