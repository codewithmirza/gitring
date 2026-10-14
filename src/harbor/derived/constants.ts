/**
 * The tables and the limits of the derived data, with the reason for each.
 * Imported by the other files of this folder. Change a table only with a way to build it again from main.
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS dd_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dd_steps (seq INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, parent TEXT NOT NULL, tree TEXT NOT NULL, kind TEXT NOT NULL, landing_id TEXT, subject TEXT NOT NULL, files INTEGER NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dd_paths (path TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, PRIMARY KEY (path, seq))`,
  `CREATE TABLE IF NOT EXISTS dd_blame (path TEXT NOT NULL, seq INTEGER NOT NULL, runs TEXT, PRIMARY KEY (path, seq))`,
  `CREATE TABLE IF NOT EXISTS dd_text (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, body TEXT NOT NULL)`,
];
/** The search index over dd_text (external content: the text is stored once). */
export const FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS dd_fts USING fts5(path UNINDEXED, body, content='dd_text', content_rowid='id', tokenize='trigram')`;

/** A merge that touches at most this many files is computed when it lands. A bigger one waits for the first question. */
export const EAGER_FILES = 64;
/** ...and only when at most this many changes of main wait (else the history waits for the first question). */
export const EAGER_STEPS = 8;
/** At most this many changed files of one change get a path history and a blame. */
export const MAX_STEP_FILES = 5000;
/** A move of main without a merge: at most this many of its commits become changes of their own (the rest count as one). */
export const MAX_WALK = 200;
/** A question waits this long for the history to catch up. Then the rest continues in the background. */
export const QUERY_BUDGET_MS = 20_000;
export const BACKGROUND_BUDGET_MS = 120_000;
/** Blob reads in flight. */
export const TEXT_READS = 16;
export const MAX_LIMIT = 100;
export const SEARCH_FILES = 20;
export const SEARCH_LINES = 5;
export const COMPARE_FILES = 300;
/** The diff text of one compare answer: it must fit the answer limits of MCP clients. */
export const COMPARE_CHARS = 60_000;
