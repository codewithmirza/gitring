/**
 * The Tests section of the settings: how tests run (the gitring test runner or the project's own commands) and when.
 * The words come from ../trains-copy.ts.
 */
import { useEffect, useState } from "react";
import { Button, Checkbox, Field, Input, Segmented } from "../../design/components";
import type { CheckSettings, TestsWhen } from "../../../../src/core/types";
import { untestedHelp } from "../approval-copy";
import { TESTS_WHEN_OPTIONS, testsWhenHelp } from "../trains-copy";
import { SaveError, type SectionProps, useSave } from "./shared";

/** How tests run: the gitring test runner or the project's own commands in a container. */
export function ChecksSection({ projectId, owner, settings, onSaved }: SectionProps) {
  const cs: CheckSettings = settings.checks ?? { runner: "worker" };
  const [install, setInstall] = useState(cs.install ?? "");
  const [test, setTest] = useState(cs.test ?? "");
  const [timeout, setTimeoutSec] = useState(String(cs.timeoutSec ?? 600));
  const { busy, error, save } = useSave(projectId, onSaved);
  const saved = JSON.stringify(cs);

  useEffect(() => {
    setInstall(cs.install ?? "");
    setTest(cs.test ?? "");
    setTimeoutSec(String(cs.timeoutSec ?? 600));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const container = cs.runner === "container";
  const dirty = install !== (cs.install ?? "") || test !== (cs.test ?? "") || timeout !== String(cs.timeoutSec ?? 600);
  return (
    <section className="st-sec" aria-labelledby="st-checks">
      <h2 className="page__h2" id="st-checks">
        Tests
      </h2>
      <p className="np__help">gitring runs the tests of a work copy before the work copy is ready. Choose when gitring also tests main with the work.</p>
      <Segmented<TestsWhen>
        label="When are tests run?"
        value={settings.testsWhen ?? "before"}
        disabled={!owner || busy}
        onChange={(testsWhen) => owner && testsWhen !== (settings.testsWhen ?? "before") && void save({ testsWhen }, "Test settings saved")}
        options={TESTS_WHEN_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />
      <p className="np__help">{testsWhenHelp(settings.testsWhen ?? "before")}</p>
      <Segmented<CheckSettings["runner"]>
        label="Where tests run"
        value={cs.runner}
        disabled={!owner}
        onChange={(runner) => owner && runner !== cs.runner && void save({ checks: { ...cs, runner } }, "Test settings saved")}
        options={[
          { value: "container", label: "Container", icon: "anchor" },
          { value: "worker", label: "gitring test runner", icon: "compass" },
        ]}
      />
      <p className="np__help">
        {container
          ? "A Linux container with Node.js 24 runs the install command, then the test command. The container can reach package registries only."
          : "The test runner of gitring runs the files tests/*.test.js. It has no packages and no network."}
      </p>
      {!container && (
        <>
          <Checkbox
            label="Merge when no test runs"
            checked={Boolean(settings.allowUntested)}
            disabled={!owner || busy}
            onChange={(e) => owner && void save({ allowUntested: e.target.checked }, "Test settings saved")}
          />
          <p className="np__help">{untestedHelp(Boolean(settings.allowUntested))}</p>
        </>
      )}
      {container && (
        <>
          <div className="st-row">
            <Field label="Install command" optional help="Empty: npm ci with a package-lock.json, else npm install.">
              <Input className="voice-agent" value={install} onChange={(e) => setInstall(e.target.value)} placeholder="npm ci" disabled={!owner} spellCheck={false} />
            </Field>
            <Field label="Test command" optional help="Empty: npm test. Exit code 0 means the tests pass.">
              <Input className="voice-agent" value={test} onChange={(e) => setTest(e.target.value)} placeholder="npm test" disabled={!owner} spellCheck={false} />
            </Field>
            <Field label="Time limit (s)" help="60 to 1800.">
              <Input value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} inputMode="numeric" disabled={!owner} />
            </Field>
          </div>
          {owner && (
            <div>
              <Button
                busy={busy}
                disabled={!dirty}
                onClick={() =>
                  void save({ checks: { runner: "container", install: install.trim() || undefined, test: test.trim() || undefined, timeoutSec: Number(timeout) || 600 } }, "Test settings saved")
                }
              >
                Save test commands
              </Button>
            </div>
          )}
        </>
      )}
      <SaveError error={error} />
    </section>
  );
}
