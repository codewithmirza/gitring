/**
 * Where the person answers merge questions: in the chat of the agent, in the app, or in both.
 */
import { useEffect, useState } from "react";
import type { ApprovalsIn } from "../../../../src/core/accounts";
import { APPROVALS_IN } from "../../../../src/core/accounts";
import { Segmented, SkeletonRows } from "../../design/components";
import { Icon } from "../../design/icons";
import { APPROVALS_IN_TEXT, loadPrefs, savePrefs } from "../../state/inbox";
import { Link } from "../../app/router";

/**
 * Where the person answers merge questions (contract C3): in the chat of the agent, in the gitring app, or in
 * both. One segmented control; the help under it says what the choice does.
 */
export function AnswersIn() {
  const [value, setValue] = useState<ApprovalsIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    loadPrefs()
      .then((p) => live && setValue(p.approvalsIn))
      .catch((e: Error) => live && setError(`gitring could not load your choice. ${e.message}`));
    return () => {
      live = false;
    };
  }, []);
  const change = async (next: ApprovalsIn) => {
    const before = value;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      setValue((await savePrefs({ approvalsIn: next })).approvalsIn);
    } catch (e) {
      setValue(before);
      setError(`gitring did not save your choice. ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="acct-sec" aria-labelledby="acct-answers-h" id="acct-answers">
      <div className="acct-sec__head">
        <h2 className="page__h2" id="acct-answers-h">
          Merge questions
        </h2>
        <p className="acct-sec__lede">An agent that you send can ask for a merge that needs your yes. Where do you answer merge questions?</p>
      </div>
      {value ? (
        <Segmented<ApprovalsIn>
          label="Where do you answer merge questions?"
          size="md"
          value={value}
          disabled={saving}
          onChange={(v) => void change(v)}
          options={APPROVALS_IN.map((v) => ({ value: v, label: APPROVALS_IN_TEXT[v].label }))}
        />
      ) : (
        !error && <SkeletonRows rows={1} label="Please wait for your choice" />
      )}
      {value && (
        <p className="acct-sec__lede" aria-live="polite">
          {APPROVALS_IN_TEXT[value].help} <Link to="/inbox">Open the inbox</Link>
        </p>
      )}
      {error && (
        <p className="acct-error" role="alert">
          <Icon name="cross" size={14} /> {error}
        </p>
      )}
    </section>
  );
}
