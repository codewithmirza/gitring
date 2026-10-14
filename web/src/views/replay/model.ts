/**
 * Replay model: the history of a project (timeline records, see src/core/timeline.ts) as a script of
 * steps, the world at each step, a playback schedule and the short map effects of each step.
 *
 *   buildScript(records, agents)  records to steps, oldest first, one caption and one stage each
 *   worldAt(script, i)            what the map and the panels show after step i
 *   scheduleOf(steps, speed)      when each step starts on the wall clock (idle time compressed)
 *   effectsAt(script, s, wall)    the map effects that run at a wall time, with their progress
 *
 * This file is the front door of model/. It is a pure module (no React, no DOM).
 * test/web/replay.test.ts checks the mapping step by step.
 */
export { firstSentences, buildScript, nearest } from "./model/build-script";
export { easeOut, easeInOut } from "./model/easing";
export { EFFECT_MS, effectOf, effectsAt } from "./model/effects";
export type { EffectKind, Effect } from "./model/effects";
export { MAX_GAP_MS, DWELL_MS, SPEEDS, OUTRO_MS, pace, holdOf, scheduleOf, indexAt, progressOf, retime } from "./model/schedule";
export type { Schedule } from "./model/schedule";
export { stageOf } from "./model/steps";
export type { StepKind, TestSummary, ReplayStep, ReplayScript } from "./model/steps";
export { worldAt } from "./model/world";
export type { TaskState, WorldTask, WorldBuoy, WorldCommit, World } from "./model/world";

export type { Stage } from "./captions";
