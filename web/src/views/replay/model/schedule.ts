/**
 * The playback schedule: when each step starts on the wall clock, with idle time compressed by the speed.
 */
import type { ReplayStep } from "./steps";

/** Idle time longer than this (history ms) is cut to this length. */
export const MAX_GAP_MS = 20_000;
/** The least wall time a step holds the screen at 1×, by weight. */
export const DWELL_MS: Record<1 | 2 | 3, number> = { 1: 420, 2: 1100, 3: 2200 };
export const SPEEDS = [1, 2, 5, 10, 30, 60, 120] as const;
export const OUTRO_MS = 1200;

export interface Schedule {
  speed: number;
  /** Wall time (ms from the start of the replay) at which each step starts. */
  starts: number[];
  /** Wall time of the end: the last step plus its hold and the outro. */
  end: number;
  /** Wall time of the title card before the first step. */
  intro: number;
}

/** Fast speeds shorten the holds too, but less than the history time: captions stay readable. */
export function pace(speed: number): number {
  return 1 + Math.log2(Math.max(1, speed)) * 0.45;
}

export function holdOf(step: ReplayStep, speed: number): number {
  return DWELL_MS[step.weight] / pace(speed);
}

/** When each step starts: history gaps divided by the speed (idle gaps cut), never shorter than the hold of the step before. */
export function scheduleOf(steps: ReplayStep[], speed: number, intro = 0): Schedule {
  const sp = Math.max(1, Math.min(SPEEDS[SPEEDS.length - 1], speed));
  const starts: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (i === 0) {
      starts.push(intro);
      continue;
    }
    const gap = Math.max(0, Math.min(MAX_GAP_MS, steps[i].at - steps[i - 1].at));
    starts.push(starts[i - 1] + Math.max(gap / sp, holdOf(steps[i - 1], sp)));
  }
  const end = steps.length ? starts[steps.length - 1] + holdOf(steps[steps.length - 1], sp) + OUTRO_MS : intro;
  return { speed: sp, starts, end, intro };
}

/** The step that runs at a wall time: the last step that started (-1 during the title card). */
export function indexAt(s: Schedule, wall: number): number {
  let lo = 0;
  let hi = s.starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.starts[mid] <= wall) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** How far the step at `index` is, 0–1, at a wall time. */
export function progressOf(s: Schedule, index: number, wall: number): number {
  if (index < 0) return s.intro > 0 ? Math.max(0, Math.min(1, wall / s.intro)) : 0;
  const from = s.starts[index];
  const to = index + 1 < s.starts.length ? s.starts[index + 1] : s.end - OUTRO_MS;
  if (to <= from) return 1;
  return Math.max(0, Math.min(1, (wall - from) / (to - from)));
}

/** The same place in the history on another schedule (a new speed): same step, same progress. */
export function retime(from: Schedule, to: Schedule, wall: number): number {
  const i = indexAt(from, wall);
  if (i < 0) return Math.min(wall, to.intro);
  if (wall >= from.end) return to.end;
  const p = progressOf(from, i, wall);
  const a = to.starts[i];
  const b = i + 1 < to.starts.length ? to.starts[i + 1] : to.end - OUTRO_MS;
  return a + p * Math.max(0, b - a);
}
