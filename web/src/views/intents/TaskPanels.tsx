/**
 * The panels of the task header: change the goal, pause the task, and the versions of the goal.
 */
import { useState, type RefObject } from "react";
import type { Intent } from "../../../../src/core/types";
import { Button, InlinePanel, toast } from "../../design/components";
import { Icon } from "../../design/icons";
import { harbor } from "../../state/api";
import { ago } from "../../state/format";
import { sourceText } from "./helpers";

/** `focus` says which field takes the focus when the panel opens: the goal, or the new constraint. */
export function AmendPanel({
  intent,
  onClose,
  returnFocus,
  focus = "goal",
}: {
  intent: Intent;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  focus?: "goal" | "constraint";
}) {
  const [goal, setGoal] = useState(intent.goal);
  const [constraint, setConstraint] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = goal.trim() !== intent.goal.trim() || constraint.trim();
  const submit = async () => {
    if (!changed) {
      setError("Change the goal or add a constraint first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await harbor().amendIntent(intent.id, {
        goal: goal.trim() !== intent.goal ? goal.trim() : undefined,
        constraints: constraint.trim() ? [constraint.trim()] : undefined,
        reason: reason.trim() || "Changed in the web app.",
      });
      toast({ tone: "info", title: `Goal changed (version ${intent.version + 1})`, text: "Active work copies get a change request with the new text." });
      onClose();
    } catch (e) {
      setError(`The change did not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlinePanel label="Change the goal" onClose={onClose} returnFocus={returnFocus} onSubmit={() => void submit()} className="amend">
      <label className="inline__label" htmlFor="amend-goal">
        Goal
      </label>
      <textarea
        id="amend-goal"
        className="b-textarea voice-human"
        rows={3}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        data-autofocus={focus === "goal" ? "" : undefined}
      />
      <div className="amend__row">
        <div className="amend__field">
          <label className="inline__label" htmlFor="amend-constraint">
            Add a constraint <span className="ink-3">(optional)</span>
          </label>
          <input
            id="amend-constraint"
            className="b-input voice-human"
            value={constraint}
            onChange={(e) => setConstraint(e.target.value)}
            placeholder="Show at most 20 results."
            data-autofocus={focus === "constraint" ? "" : undefined}
          />
        </div>
        <div className="amend__field">
          <label className="inline__label" htmlFor="amend-reason">
            Reason <span className="ink-3">(optional)</span>
          </label>
          <input id="amend-reason" className="b-input voice-human" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Long result lists are slow on phones." />
        </div>
      </div>
      <p className="inline__help">gitring keeps every version. Active work copies get the change as a change request.</p>
      {error && (
        <p className="inline__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="inline__actions">
        <Button type="submit" size="sm" variant="primary" icon="amend" busy={busy}>
          Save as version {intent.version + 1}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </InlinePanel>
  );
}

export function PausePanel({ intent, onClose, returnFocus }: { intent: Intent; onClose: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await harbor().park(intent.id, reason.trim() || "Paused in the web app.");
      toast({ tone: "info", title: "Task paused", text: `“${intent.title}” stops. Its work copies stay visible.` });
      onClose();
    } catch (e) {
      setError(`The task did not pause: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlinePanel label="Pause the task" onClose={onClose} returnFocus={returnFocus} onSubmit={() => void submit()} className="pause">
      <p className="inline__lead">A pause stops all work copies of this task. gitring keeps them. You can open a new task later.</p>
      <label className="inline__label" htmlFor="pause-reason">
        Reason <span className="ink-3">(optional, the history keeps it)</span>
      </label>
      <input id="pause-reason" className="b-input voice-human" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The shop does not need a search yet." data-autofocus />
      {error && (
        <p className="inline__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="inline__actions">
        <Button type="submit" size="sm" variant="danger" icon="park" busy={busy}>
          Pause the task
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Keep the task active
        </Button>
      </div>
    </InlinePanel>
  );
}

/* ───────────── spec ───────────── */

export function LivingSpec({ intent, now }: { intent: Intent; now: number }) {
  const versions = [
    { version: 1, at: intent.createdAt, by: intent.createdBy, reason: `Opened from ${sourceText(intent)}.`, text: "" },
    ...intent.amendments,
  ].reverse();
  return (
    <section className="spec" aria-labelledby="spec-title">
      <h2 className="spec__title" id="spec-title">
        Versions <span className="voice-agent ink-3">v{intent.version}</span>
      </h2>
      <ol className="timeline">
        {versions.map((a, i) => (
          <li key={`${a.version}-${a.at}-${i}`} className={["timeline__item", a.by.kind === "human" ? "is-human" : "is-system"].join(" ")}>
            <span className="timeline__dot" aria-hidden="true" />
            <div className="timeline__head">
              <span className="voice-agent">v{a.version}</span>
              <span className="timeline__by">
                <Icon name={a.by.kind === "human" ? "human" : "compass"} size={12} />
                {a.by.name}
              </span>
              <span className="ink-3">{ago(a.at, now)}</span>
            </div>
            <p className={a.by.kind === "human" ? "voice-human timeline__reason" : "timeline__reason"}>{a.reason}</p>
            {a.text && <p className={a.by.kind === "human" ? "voice-human timeline__text" : "voice-agent timeline__text"}>{a.text}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
