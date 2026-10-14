/**
 * The two panels that finish a work copy: merge it into main with a reason, or ask for a redo on the new main.
 */
import { useState, type RefObject } from "react";
import type { Attempt, Intent } from "../../../../src/core/types";
import { Button, InlinePanel, toast } from "../../design/components";
import { Icon } from "../../design/icons";
import { navigate } from "../../app/router";
import { harbor } from "../../state/api";
import { METHOD_TEXT, shortSha } from "../../state/format";
import { suggestedReason } from "./helpers";

export function MergePanel({
  attempt,
  all,
  callsign,
  intent,
  mainSha,
  result,
  onClose,
  returnFocus,
}: {
  attempt: Attempt;
  all: Attempt[];
  callsign: string;
  intent: Intent;
  mainSha: string;
  result: string;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [reason, setReason] = useState(() => suggestedReason(attempt, all));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = all.filter((x) => x.id !== attempt.id && !["landed", "alternate", "abandoned", "failed"].includes(x.status)).length;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await harbor().land(attempt.id, reason.trim() || suggestedReason(attempt, all));
      if (res.landing) {
        toast({
          tone: "clear",
          title: `Merged into main ${shortSha(res.landing.mainAfter)}`,
          text: `“${intent.title}” · ${METHOD_TEXT[res.landing.method] ?? res.landing.method}.`,
          action: { label: "Read the merge record", onClick: () => navigate(`/history/${res.landing!.id}`) },
        });
      } else {
        toast({ tone: "info", title: res.waits ? "The merge waits" : "Redo scheduled", text: res.message ?? "The work copy does not merge cleanly with main. gitring does it again on the new main." });
      }
      onClose();
    } catch (e) {
      setError(`The merge did not start: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlinePanel label={`Merge the work of ${callsign}`} onClose={onClose} returnFocus={returnFocus} onSubmit={() => void submit()} className="lane__panel">
      <p className="inline__lead">
        gitring combines this work copy with main <span className="voice-agent">{shortSha(mainSha)}</span>, runs the tests of all merged tasks, then merges it.
        {others === 1 ? " The other work copy stays as an alternative." : others > 1 ? ` The other ${others} work copies stay as alternatives.` : ""}
      </p>
      <label className="inline__label" htmlFor={`why-${attempt.id}`}>
        Why this work copy? <span className="ink-3">(filled in from the tests and the diff)</span>
      </label>
      <textarea id={`why-${attempt.id}`} className="b-textarea voice-human" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && (
        <p className="inline__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="inline__actions">
        <Button type="submit" size="sm" variant="primary" icon="anchor" busy={busy} data-autofocus="">
          {result}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </InlinePanel>
  );
}

export function RedoPanel({ attempt, callsign, onClose, returnFocus }: { attempt: Attempt; callsign: string; onClose: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await harbor().rederive(attempt.id, reason.trim());
      toast({ tone: "info", title: "Redo started", text: `${callsign} sends a new plan on the current main.` });
      onClose();
    } catch (e) {
      setError(`The redo did not start: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlinePanel label={`Redo the work of ${callsign}`} onClose={onClose} returnFocus={returnFocus} onSubmit={() => void submit()} className="lane__panel">
      <p className="inline__lead">A new work copy starts from the task on the current main. This work copy stays as an alternative.</p>
      <label className="inline__label" htmlFor={`redo-${attempt.id}`}>
        What must change? <span className="ink-3">(optional, the agent reads it)</span>
      </label>
      <textarea
        id={`redo-${attempt.id}`}
        className="b-textarea voice-human"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="The toggle hides the search field on small screens."
        data-autofocus
      />
      {error && (
        <p className="inline__error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      <div className="inline__actions">
        <Button type="submit" size="sm" variant="primary" icon="rederive" busy={busy}>
          Redo on the new main
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </InlinePanel>
  );
}
