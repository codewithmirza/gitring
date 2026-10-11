import { noTestRan, type CheckRun } from "../../../../src/core/types";
import { Icon } from "../icons";
import { ProgressRule } from "./ProgressRule";

interface EvidenceBarProps {
  run?: CheckRun | null;
  /** Show this many pending segments while tests run. */
  pending?: number;
  /** "Alone" or "Combined with main". */
  label?: string;
  showFailures?: boolean;
  checking?: boolean;
}

/**
 * EvidenceBar: one segment per test (pass = solid clear, fail = hatched danger)
 * plus "7/7 pass". role="img" with a text alternative.
 */
export function EvidenceBar({ run, pending = 0, label, showFailures = true, checking }: EvidenceBarProps) {
  if (!run) {
    const n = Math.max(pending, 1);
    return (
      <div className="b-evidence" role="img" aria-label={checking ? "Tests run now." : "No test results yet."}>
        <div className="b-evidence__bar" aria-hidden="true">
          {Array.from({ length: n }, (_, i) => (
            <span key={i} className="b-evidence__seg is-pending" />
          ))}
        </div>
        {checking && <ProgressRule label="Tests run" />}
        <div className="b-evidence__label">
          {label && <span>{label}</span>}
          <span className="b-evidence__count">{checking ? "Tests run…" : "No results yet"}</span>
        </div>
      </div>
    );
  }
  const total = run.passed + run.failed;
  const fails = run.cases.filter((c) => !c.ok);
  // No test ran: nothing is verified. Say so, do not show "0/0 pass" with a check mark.
  const untested = noTestRan(run);
  const alt = untested
    ? `${label ? label + ": " : ""}No test ran.`
    : `${label ? label + ": " : ""}${total} tests: ${run.passed} pass` +
      (fails.length ? `, ${fails.length} fail: ${fails.map((f) => f.name).join("; ")}` : "") +
      (run.error ? `. Test runner error: ${run.error}` : "");
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
        <span className={["b-evidence__count", untested ? "" : run.ok ? "is-ok" : "is-fail"].filter(Boolean).join(" ")}>
          <Icon name={untested ? "info" : run.ok ? "check" : "cross"} size={12} />
          {untested ? "No test ran" : `${run.passed}/${total} pass`}
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
