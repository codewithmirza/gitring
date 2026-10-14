/**
 * The interest page: a survey, not a shop. The person picks the pack they would use and says "Count me in".
 * No payment, no card field. A person who chose already sees the confirmation and may change the choice.
 */
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../design/components";
import { PLANS, priceLabel, type Plan, type PlanId } from "../../../../src/core/plans";
import { NOTE_MAX, type WaitlistEntry } from "../../../../src/core/waitlist";
import { leaveWaitlist, saveChoice } from "../../state/waitlist";
import { INTEREST } from "./copy";

function PlanCard({ plan, checked, onPick, name }: { plan: Plan; checked: boolean; onPick: () => void; name: string }) {
  return (
    <label className={`wl-plan${checked ? " is-checked" : ""}`}>
      <input className="wl-plan__radio" type="radio" name={name} value={plan.id} checked={checked} onChange={onPick} />
      <span className="wl-plan__head">
        <span className="wl-plan__name">{plan.name}</span>
        <span className="wl-plan__check" aria-hidden="true" />
      </span>
      <span className="wl-plan__price">
        {priceLabel(plan)}
        {plan.monthlyUsd > 0 && <span className="wl-plan__per"> {INTEREST.perMonth}</span>}
      </span>
      <span className="wl-plan__tag">{INTEREST.planned}</span>
      <span className="wl-plan__line">{plan.tagline}</span>
      <ul className="wl-plan__points">
        {plan.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <span className="wl-plan__who">{plan.forWho}</span>
    </label>
  );
}

function Confirmation({ entry, onChange, onLeave, busy }: { entry: WaitlistEntry; onChange: () => void; onLeave: () => void; busy: boolean }) {
  const plan = PLANS.find((p) => p.id === entry.pack);
  return (
    <section className="wl-done" aria-live="polite">
      <h1 className="wl-title wl-title--sm" tabIndex={-1}>
        {INTEREST.done}
      </h1>
      <p className="wl-lede">{INTEREST.next}</p>
      {plan && (
        <p className="wl-chosen">
          <strong>{plan.name}</strong> · {priceLabel(plan)}
          {plan.monthlyUsd > 0 ? ` ${INTEREST.perMonth}` : ""}
        </p>
      )}
      {entry.note && <p className="wl-note">{entry.note}</p>}
      <div className="wl-actions">
        <Button variant="secondary" onClick={onChange}>
          {INTEREST.changeAsk}
        </Button>
        <Button variant="ghost" onClick={onLeave} busy={busy}>
          {INTEREST.leave}
        </Button>
      </div>
    </section>
  );
}

export function Interest({ entry }: { entry: WaitlistEntry | null }) {
  const [didLeave, setDidLeave] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pack, setPack] = useState<PlanId | null>(entry?.pack ?? null);
  const [note, setNote] = useState(entry?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const group = useId();
  const noteId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pack) return setProblem(INTEREST.pickFirst);
    setBusy(true);
    setProblem(null);
    try {
      await saveChoice(pack, note);
      setEditing(false);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    setBusy(true);
    try {
      await leaveWaitlist();
      setPack(null);
      setNote("");
      setDidLeave(true);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (entry && !editing) {
    return (
      <>
        <Confirmation
          entry={entry}
          busy={busy}
          onChange={() => {
            setPack(entry.pack);
            setNote(entry.note);
            setEditing(true);
          }}
          onLeave={() => void leave()}
        />
        {problem && (
          <p className="wl-error" role="alert">
            {problem}
          </p>
        )}
      </>
    );
  }

  return (
    <form className="wl-survey" onSubmit={(e) => void submit(e)} aria-labelledby={`${group}-h`}>
      <h1 id={`${group}-h`} className="wl-title wl-title--sm" tabIndex={-1}>
        {INTEREST.title}
      </h1>
      {didLeave && !entry && <p className="wl-ok">{INTEREST.left}</p>}
      <p className="wl-lede">{INTEREST.lede}</p>
      <p className="wl-free">{INTEREST.free}</p>
      <div className="wl-plans" role="radiogroup" aria-labelledby={`${group}-h`}>
        {PLANS.map((p) => (
          <PlanCard key={p.id} plan={p} name={group} checked={pack === p.id} onPick={() => setPack(p.id)} />
        ))}
      </div>
      <label className="wl-label" htmlFor={noteId}>
        {INTEREST.noteLabel}
      </label>
      <textarea id={noteId} className="wl-textarea" value={note} maxLength={NOTE_MAX} rows={3} placeholder={INTEREST.notePlaceholder} onChange={(e) => setNote(e.target.value)} />
      {problem && (
        <p className="wl-error" role="alert">
          {problem}
        </p>
      )}
      <div className="wl-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {entry ? INTEREST.change : INTEREST.submit}
        </Button>
        {entry && (
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
