/**
 * Derived data of main (path history, blame, search) and the history questions that read it: the front door.
 * The class DerivedHistory is the last layer of the chain in derived/README.md. The tables and the rules are in that README.
 * The merge layers call `landed` after each merge. HarborReads (master/reads.ts) holds the instance.
 * Never read the whole history here: each change is computed from its parent, so the cost follows the change.
 * Read next: derived/README.md.
 */
import { DerivedCompare } from "./derived/compare";

export { EAGER_FILES } from "./derived/constants";
export { lineCount } from "./derived/helpers";
export { diffTrees } from "./derived/tree-diff";
export type { DerivedSource, WorkCopyFiles } from "./derived/types";

export class DerivedHistory extends DerivedCompare {}
