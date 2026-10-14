/**
 * Derived views of ProjectState, one file for each view, all memoized on the identity of the slices they read.
 * This file is the front door: it re-exports the files of selectors/. Import from here, not from the folder.
 * A selector recomputes only when the slices it reads change. Never put a side effect in a selector.
 * Read selectors/README.md for the list of files.
 */
export { latestCheckFor, checkForCorrection, assessmentFor, factsFor } from "./selectors/check-lookups";
export { ACTIVE_STATUSES, isActiveAttempt, vesselColor, indexes } from "./selectors/indexes";
export type { Indexes } from "./selectors/indexes";
export { INTENT_GROUPS, selectIntentGroups } from "./selectors/intent-groups";
export type { IntentGroup } from "./selectors/intent-groups";
export { selectLogbook } from "./selectors/logbook";
export type { LogbookRow } from "./selectors/logbook";
export { memo, byId } from "./selectors/memo";
export { selectJudgmentQueue } from "./selectors/queue";
export type { ApprovalItem, OtherJudgmentItem, QuestionItem, JudgmentItem, Who } from "./selectors/queue";
export { rangeTone, selectRangeLines, correctionFile, selectBuoys } from "./selectors/range-lines";
export type { RangeTone, RangeLine, BuoyModel } from "./selectors/range-lines";
export { selectVessels } from "./selectors/vessels";
export type { RangeLink, VesselModel } from "./selectors/vessels";
