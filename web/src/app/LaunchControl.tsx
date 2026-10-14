/**
 * Chooses how many built-in agents work on a task and which models they use, and the button that starts them.
 * Used by the composer, the task rail and the tasks page. The wait for the test budget comes from ./actions.ts.
 */
import { useEffect, useId, useState } from "react";
import type { Intent } from "../../../src/core/types";
import { Button, Checkbox, Popover, Segmented, toast, usePopover } from "../design/components";
import { harbor } from "../state/api";
import { modelShort } from "../state/format";
import { useStore } from "../state/store";
import { useCanAct } from "../state/account";
import { Link, navigate } from "./router";
import { budgetWait, timeOfDay } from "./actions";

const FANOUT = ["1", "2", "3", "4"] as const;
const EMPTY: string[] = [];

/** How many built-in agents work on a task, and which models they use (round robin). */
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
  const modelsId = useId();
  if (!available.length) {
    return (
      <p className="launch__help">
        This gitring has no built-in agents. <Link to="/connect">Connect your own agent</Link>: it takes the task through MCP.
      </p>
    );
  }
  return (
    <div className="launch">
      <div className="launch__row">
        <span className="launch__label">Agents</span>
        <Segmented
          label="Number of agents that work in parallel"
          value={String(fanout) as (typeof FANOUT)[number]}
          onChange={(v) => setFanout(Number(v))}
          options={FANOUT.map((v) => ({ value: v, label: v, ariaLabel: `${v} ${v === "1" ? "agent" : "agents"}` }))}
        />
      </div>
      {/* A group, not a fieldset: a legend floats beside the first box and the next boxes wrap under it. */}
      <div className="launch__row" role="group" aria-labelledby={modelsId}>
        <span className="launch__label" id={modelsId}>
          Models
        </span>
        <div className="launch__models">
          {available.map((m) => (
            <Checkbox
              key={m}
              label={<span className="voice-agent">{modelShort(m)}</span>}
              checked={models.includes(m)}
              onChange={(e) => setModels(e.target.checked ? [...models, m] : models.filter((x) => x !== m))}
            />
          ))}
        </div>
      </div>
      <p className="launch__help">
        {fanout === 1
          ? "One agent works in its own work copy."
          : `${fanout} agents work in parallel, each in its own work copy. Compare the results, then merge one.`}
        {models.length === 0 ? " No model is selected: gitring uses all models." : ""}
      </p>
    </div>
  );
}

/** Start built-in agents on a task and report the result (with the budget wait, if any). */
export async function launchTask(intent: Pick<Intent, "id" | "title">, fanout: number, models: string[]): Promise<boolean> {
  try {
    const res = await harbor().launch(intent.id, fanout, models.length ? models : undefined);
    const wait = budgetWait(res.attempts);
    const n = res.attempts.length;
    toast(
      wait
        ? { tone: "info", title: `${n} ${n === 1 ? "agent waits" : "agents wait"}`, text: `Agents start at ${timeOfDay(wait)}. Your hourly AI budget is used.` }
        : {
            tone: "info",
            title: `${n} ${n === 1 ? "agent starts" : "agents start"}`,
            text: `“${intent.title}”. Watch the conflict checks on the overview.`,
            action: { label: "Open the overview", onClick: () => navigate("/overview") },
          },
    );
    return true;
  } catch (e) {
    toast({ tone: "danger", title: "The agents did not start", text: (e as Error).message });
    return false;
  }
}

/** "Start agents" control for a task: a popover from the button with 1–4 built-in agents and their models. */
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
  const available = useStore((s) => s.state?.project.settings.agentModels ?? EMPTY);
  const defaultFanout = useStore((s) => s.state?.project.settings.fanout ?? 1);
  const pop = usePopover();
  const [fanout, setFanout] = useState(Math.min(4, Math.max(1, intent.suggestedFanout ?? defaultFanout)));
  const [models, setModels] = useState<string[]>(available);
  const [busy, setBusy] = useState(false);
  const closed = intent.status === "landed" || intent.status === "parked" || intent.status === "merged-into";
  const canAct = useCanAct();
  useEffect(() => setModels(available), [available]);

  const launch = async () => {
    setBusy(true);
    if (await launchTask(intent, fanout, models)) pop.close();
    setBusy(false);
  };

  if (!canAct) return null;
  return (
    <>
      <Button
        {...pop.triggerProps}
        size={size}
        variant={variant}
        icon="launch"
        disabled={closed}
        aria-label={`Start agents for ${intent.title}`}
        onClick={(e) => {
          e.stopPropagation();
          pop.toggle();
        }}
        title={closed ? "This task is closed." : undefined}
      >
        {label}
      </Button>
      <Popover {...pop.popoverProps} label={`Start agents for ${intent.title}`} align="end" width={320}>
        <div className="launch__pop">
          <p className="launch__title">
            Start agents for <span className="voice-human">{intent.title}</span>
          </p>
          <FanoutPicker fanout={fanout} setFanout={setFanout} models={models} setModels={setModels} available={available} />
          {available.length > 0 && (
            <Button variant="primary" icon="launch" block busy={busy} onClick={() => void launch()} data-autofocus="">
              {fanout === 1 ? "Start 1 agent" : `Start ${fanout} agents`}
            </Button>
          )}
        </div>
      </Popover>
    </>
  );
}
