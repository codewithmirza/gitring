/**
 * Small lookups into conflict checks: the latest check of a work copy, the check of a change request, its facts.
 */
import type { Correction, CourseCheck, ProjectState } from "../../../../src/core/types";
import { indexes } from "./indexes";

export function latestCheckFor(st: ProjectState, attemptId: string): CourseCheck | undefined {
  const list = indexes(st).checksByAttempt.get(attemptId) ?? [];
  return list.reduce<CourseCheck | undefined>((m, c) => (!m || c.at >= m.at ? c : m), undefined);
}

export function checkForCorrection(st: ProjectState, c: Correction): CourseCheck | undefined {
  return indexes(st).checkById.get(c.checkId);
}

export function assessmentFor(check: CourseCheck | undefined, otherAttemptId: string | undefined) {
  if (!check) return undefined;
  return check.assessments.find((a) => a.otherAttemptId === otherAttemptId) ?? check.assessments[0];
}

export function factsFor(check: CourseCheck | undefined, otherAttemptId: string | undefined) {
  if (!check) return undefined;
  return check.facts.find((f) => f.otherAttemptId === otherAttemptId) ?? check.facts[0];
}
