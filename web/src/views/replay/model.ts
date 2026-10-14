/**
 * Replay model: the history of a project as steps, the world at each step, a schedule and map effects.
 * buildScript(records, agents) makes the steps. worldAt(script, i) gives what the map shows after step i.
 * scheduleOf(steps, speed) gives the wall time of each step. effectsAt(script, s, wall) gives the map effects.
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
