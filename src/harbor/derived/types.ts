/**
 * The types of the derived data: what it reads from the project object, and the rows and steps it works with.
 * DerivedSource is the contract with the project object (see ../master/reads.ts).
 */
import type * as T from "../../core/types";
import type { CommitMeta, TreeEntry } from "../../platform/repo/backend";
import type { Snapshot } from "../../core/git/snapshot";
import { type StepKind } from "../../core/history";

/** A work copy: its files (base plus the work, text files only) and who works on it. */
export interface WorkCopyFiles {
  attempt: T.Attempt;
  files: Map<string, string>;
  /** Paths that the work deleted. */
  deleted: string[];
  callsign: string;
  title: string;
}

/** What the derived data reads from the project object. */
export interface DerivedSource {
  sql: SqlStorage;
  /** The repository and main, or undefined while the project has no main (before the start, during an import). */
  main(): { repo: string; sha: string; tree: string } | undefined;
  landings(): readonly T.Landing[];
  /** The why-record (git note) of a merge. */
  note(landingId: string): string | null;
  callsign(agentId: string): string;
  title(intentId: string): string;
  commit(sha: string): Promise<CommitMeta | null>;
  readTree(tree: string): Promise<TreeEntry[] | null>;
  /** The text of a blob. Null: binary or very large. */
  text(blob: string): Promise<string | null>;
  /** The files of a tree with the text of the text files (cached by the project object). */
  treeText(tree: string): Promise<{ snapshot: Snapshot; text: Map<string, string> }>;
  workCopy(id: string): Promise<WorkCopyFiles | undefined>;
  /** Run work after the answer (the platform keeps the object alive for it). */
  background(work: Promise<unknown>): void;
}

/** A row of dd_steps (a type, not an interface: SQL rows need an index signature). */
export type StepRow = {
  seq: number;
  sha: string;
  parent: string;
  tree: string;
  kind: StepKind;
  landing_id: string | null;
  subject: string;
  files: number;
  at: number;
};

export interface PlannedStep {
  sha: string;
  kind: StepKind;
  landing?: T.Landing;
}

export interface TreeChange {
  path: string;
  status: "A" | "M" | "D";
  old?: TreeEntry;
  now?: TreeEntry;
}

export type Engine = "fts5" | "scan";

/** One side of a compare. A work copy: the tree of its base, and the work on top. */
export interface CompareSide {
  label: string;
  tree: string;
  work?: { files: Map<string, string>; changed: Set<string>; deleted: Set<string> };
}
