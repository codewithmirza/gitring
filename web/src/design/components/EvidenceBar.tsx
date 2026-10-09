import type { CheckRun } from "../../../../src/core/types";
import { Icon } from "../icons";
import { ProgressRule } from "./ProgressRule";

interface EvidenceBarProps {
  run?: CheckRun | null;
  /** Show this many pending segments while checks run. */
  pending?: number;
  /** "Alone" or "Composed with main". */
  label?: string;
  showFailures?: boolean;
  checking?: boolean;
}

/**
 * EvidenceBar: one segment per check case (pass = solid clear, fail = hatched danger)
 * plus "7/7 pass". role="img" with a text alternative.
 */
export function EvidenceBar({ run, pending = 0, label, showFailures = true, checking }: EvidenceBarProps) {
  if (!run) {
    const n = Math.max(pending, 1);
    return (
      <div className="b-evidence" role="img" aria-label={checking ? "Checks run now." : "No check results yet."}>
        <div className="b-evidence__bar" aria-hidden="true">
          {Array.from({ length: n }, (_, i) => (
            <span key={i} className="b-evidence__seg is-pending" />
          ))}
        </div>
        {checking && <ProgressRule label="Checks run" />}
        <div className="b-evidence__label">
          {label && <span>{label}</span>}
          <span className="b-evidence__count">{checking ? "Checks run…" : "No results yet"}</span>
        </div>
      </div>
    );
  }
  const total = run.passed + run.failed;
  const fails = run.cases.filter((c) => !c.ok);
  const alt =
    `${label ? label + ": " : ""}${total} checks: ${run.passed} pass` +
    (fails.length ? `, ${fails.length} fail: ${fails.map((f) => f.name).join("; ")}` : "") +
    (run.error ? `. Runner error: ${run.error}` : "");
  const cases = run.cases.length ? run.cases : Array.from({ length: total }, (_, i) => ({ ok: i < run.passed, name: "", file: "", ms: 0 }));
  return (
    <div className="b-evidence">
      <div className="b-evidence__bar" role="img" aria-label={alt}>
        {cases.map((c, i) => (
          <span
            key={i}
            className={["b-evidence__seg", !c.ok && "is-fail"].filter(Boolean).join(" ")}
            title={`${c.ok ? "Pass" : "Fail"} · ${c.name}${c.file ? ` · ${c.file}` : ""}`}
          />
        ))}
      </div>
      <div className="b-evidence__label" aria-hidden="true">
        <span className={["b-evidence__count", run.ok ? "is-ok" : "is-fail"].join(" ")}>
          <Icon name={run.ok ? "check" : "cross"} size={12} />
          {run.passed}/{total} pass
        </span>
        {label && <span>{label}</span>}
        <span className="voice-agent ink-3">{run.ms} ms</span>
      </div>
      {showFailures && fails.length > 0 && (
        <ul className="b-evidence__fails">
          {fails.map((f) => (
            <li key={f.file + f.name}>
              <Icon name="cross" />
              <span>
                <span className="voice-agent">{f.name}</span>
                {f.error && <span className="ink-3"> · {f.error}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
