/**
 * The two lists under the work copies of a task: its constraints and its test files.
 * An empty list is one quiet line, not a heading with a zero. Used by ../IntentsView.tsx.
 */
import type { Intent } from "../../../../src/core/types";
import { Icon } from "../../design/icons";
import { plural } from "../../state/format";

/** `onAdd` opens the form that adds a constraint. It is missing when the person may not change the task. */
export function Constraints({ intent, onAdd }: { intent: Intent; onAdd?: () => void }) {
  if (intent.constraints.length === 0) {
    return (
      <p className="intent__quiet">
        No constraints yet.{" "}
        {onAdd && (
          <button type="button" className="intent__quietact" onClick={onAdd}>
            Add one
          </button>
        )}
      </p>
    );
  }
  return (
    <section aria-labelledby="constraints-title">
      <h2 className="intent__h2" id="constraints-title">
        Constraints <span className="voice-agent ink-3">{intent.constraints.length}</span>
      </h2>
      <ul className="constraints">
        {intent.constraints.map((c) => {
          const human = intent.amendments.find((a) => a.text.includes(c))?.by.kind === "human";
          return (
            <li key={c} className={human ? "voice-human" : "voice-agent"}>
              <Icon name={human ? "human" : "buoy"} size={12} />
              <span>{c.replace(/`/g, "")}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The test names of a test file: the first argument of each `test("…")` call. */
function caseNames(content: string): string[] {
  return [...content.matchAll(/\btest\(\s*"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
}

export function TestFiles({ intent }: { intent: Intent }) {
  if (intent.checks.length === 0) return <p className="intent__quiet">No test files. gitring runs the tests of the repository.</p>;
  return (
    <section aria-labelledby="checks-title">
      <h2 className="intent__h2" id="checks-title">
        Test files <span className="voice-agent ink-3">{intent.checks.length}</span>
      </h2>
      <ul className="checklist">
        {intent.checks.map((c) => {
          const cases = caseNames(c.content);
          return (
            <li key={c.id}>
              <div className="checklist__head">
                <Icon name="check" size={14} />
                <span className="voice-agent">{c.path}</span>
                <span className="ink-3">{plural(cases.length, "test")}</span>
              </div>
              <p className="checklist__desc">{c.description}</p>
              {cases.length > 0 && (
                <ul className="checklist__cases voice-agent">
                  {cases.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
