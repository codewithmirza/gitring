/**
 * Shared empty values for the store selectors of the code view. A stable empty value keeps a selector from waking the view.
 */
import type { FileNode } from "../../../../../src/core/types";
import type { FileMarks, LastMerge, WorkCopy } from "../annotations";

export const NO_FILES: FileNode[] = [];
export const NO_MARKS = new Map<string, FileMarks>();
export const NO_LAST = new Map<string, LastMerge>();
export const NO_WC: WorkCopy[] = [];
export const NO_ATTEMPTS: never[] = [];
export const NO_LANDINGS: never[] = [];
