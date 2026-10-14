/**
 * The short effects that the map plays for each step (a flying request, a pulse), and their progress at a wall time.
 */
import { indexAt, type Schedule } from "./schedule";
import type { ReplayScript, ReplayStep } from "./steps";

export type EffectKind = "course" | "sweep" | "flight" | "pop" | "ack" | "wake" | "ring" | "lease" | "commit" | "replot";

export interface Effect {
  /** The step id: the same effect keeps its key from frame to frame. */
  id: string;
  kind: EffectKind;
  step: ReplayStep;
  /** 0–1. */
  p: number;
  tone: "accent" | "magenta" | "clear" | "danger" | "caution";
  /** The effect shows its tag. A newer tag at the same work copy replaces it, so two tags never overlap. */
  labelled: boolean;
}

/** Effects with a tag next to the work copy (tests, an answer, the lease). */
const TAGGED: ReadonlySet<EffectKind> = new Set<EffectKind>(["pop", "ack", "ring", "lease"]);

/** Wall duration of each effect (ms). */
export const EFFECT_MS: Record<EffectKind, number> = { course: 1300, sweep: 1500, flight: 1400, pop: 700, ack: 900, wake: 800, ring: 1000, lease: 1100, commit: 1800, replot: 1400 };
const LONGEST_EFFECT = Math.max(...Object.values(EFFECT_MS));

/** The map effect of a step, or null. */
export function effectOf(step: ReplayStep): Pick<Effect, "kind" | "tone"> | null {
  switch (step.kind) {
    case "plan":
      return { kind: "course", tone: "accent" };
    case "check":
      return { kind: "sweep", tone: step.check?.verdict === "clear" ? "accent" : "magenta" };
    case "request":
      return { kind: "flight", tone: "magenta" };
    case "deliver":
      return { kind: "pop", tone: "magenta" };
    case "ack":
      return { kind: "ack", tone: "clear" };
    case "work":
      return step.files?.length ? { kind: "wake", tone: "accent" } : null;
    case "tests":
      return step.tests?.waits ? null : { kind: "ring", tone: step.tests?.ok ? "clear" : "danger" };
    case "composed":
      return { kind: "ring", tone: step.tests?.ok ? "clear" : "danger" };
    case "lease":
      return { kind: "lease", tone: "accent" };
    case "commit":
      return { kind: "commit", tone: "clear" };
    case "replot":
      return { kind: "replot", tone: "caution" };
    case "stale":
      return { kind: "ring", tone: "danger" };
    default:
      return null;
  }
}

/** The effects that run at a wall time, oldest first, each with its progress. */
export function effectsAt(script: ReplayScript, s: Schedule, wall: number): Effect[] {
  const out: Effect[] = [];
  // Work copies with a newer tag (also one that ended): an older tag does not come back.
  const tagged = new Set<string>();
  const last = indexAt(s, wall);
  for (let i = last; i >= 0 && s.starts[i] > wall - LONGEST_EFFECT; i--) {
    const step = script.steps[i];
    const e = effectOf(step);
    if (!e) continue;
    const owner = TAGGED.has(e.kind) ? (step.attemptId ?? "") : null;
    const labelled = owner === null || !tagged.has(owner);
    if (owner !== null) tagged.add(owner);
    const p = (wall - s.starts[i]) / EFFECT_MS[e.kind];
    if (p < 0 || p >= 1) continue;
    out.push({ id: step.id, kind: e.kind, tone: e.tone, step, p, labelled });
  }
  return out.reverse();
}
