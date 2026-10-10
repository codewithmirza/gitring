import { useRef, useState } from "react";
import type { Intent } from "../../../src/core/types";
import { Button, Checkbox, Popover, Segmented, toast } from "../design/components";
import { harbor } from "../state/api";
import { modelShort } from "../state/format";
import { useStore } from "../state/store";
import { useCanAct } from "../state/account";

const FANOUT = ["1", "2", "3", "4"] as const;

export function FanoutPicker({
  fanout,
  setFanout,
  models,
  setModels,
  available,
}: {
  fanout: number;
  setFanout: (n: number) => void;
  models: string[];
  setModels: (m: string[]) => void;
  available: string[];
}) {
  return (
    <div className="launch">
      <div className="launch__row">
        <span className="launch__label" id="fanout-label">
          Agents
        </span>
        <Segmented
          label="Number of agents that work in parallel"
          value={String(fanout) as (typeof FANOUT)[number]}
          onChange={(v) => setFanout(Number(v))}
          options={FANOUT.map((v) => ({ value: v, label: v, ariaLabel: `${v} ${v === "1" ? "agent" : "agents"}` }))}
        />
      </div>
      <fieldset className="launch__models">
        <legend className="launch__label">Models</legend>
        {available.map((m) => (
          <Checkbox
            key={m}
            label={<span className="voice-agent">{modelShort(m)}</span>}
            checked={models.includes(m)}
            onChange={(e) => setModels(e.target.checked ? [...models, m] : models.filter((x) => x !== m))}
          />
        ))}
      </fieldset>
      <p className="launch__help">
        {fanout === 1
          ? "One agent. gitring merges its work when the tests pass."
          : `${fanout} agents work in parallel, each in its own work copy. Compare the results, then merge one.`}
      </p>
    </div>
  );
}

/** "Start agents" control for a task: 1–4 built-in agents and their models. */
export function LaunchButton({
  intent,
  size = "sm",
  variant = "secondary",
  label = "Start agents",
}: {
  intent: Intent;
  size?: "sm" | "md";
  variant?: "secondary" | "primary" | "ghost";
  /** Button text. The accessible name always names the task. */
  label?: string;
}) {
  const available = useStore((s) => s.state?.project.settings.agentModels ?? []);
  const defaultFanout = useStore((s) => s.state?.project.settings.fanout ?? 1);
  const [open, setOpen] = useState(false);
  const [fanout, setFanout] = useState(Math.min(4, Math.max(1, defaultFanout)));
  const [models, setModels] = useState<string[]>(available);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const closed = intent.status === "landed" || intent.status === "parked" || intent.status === "merged-into";
  const canAct = useCanAct();

  const launch = async () => {
    setBusy(true);
    try {
      const res = await harbor().launch(intent.id, fanout, models.length ? models : undefined);
      toast({
        tone: "info",
        title: `${res.attempts.length} ${res.attempts.length === 1 ? "agent starts" : "agents start"}`,
        text: `“${intent.title}”. Watch the conflict checks on the overview.`,
      });
      setOpen(false);
    } catch (e) {
      toast({ tone: "danger", title: "The agents did not start", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!canAct) return null;
  return (
    <>
      <Button
        ref={anchor}
        size={size}
        variant={variant}
        icon="launch"
        disabled={closed}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Start agents for ${intent.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        title={closed ? "This task is closed." : undefined}
      >
        {label}
      </Button>
      <Popover anchor={anchor.current} open={open} onClose={() => setOpen(false)} label={`Start agents for ${intent.title}`} align="end">
        <div className="launch__pop">
          <p className="launch__title">
            Start agents for <span className="voice-human">{intent.title}</span>
          </p>
          <FanoutPicker fanout={fanout} setFanout={setFanout} models={models} setModels={setModels} available={available} />
          <Button variant="primary" icon="launch" block busy={busy} onClick={launch}>
            {fanout === 1 ? "Start 1 agent" : `Start ${fanout} agents`}
          </Button>
        </div>
      </Popover>
    </>
  );
}
