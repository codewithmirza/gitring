/**
 * The fixed numbers, limits and plain texts of the project coordinator, with the reason for each.
 * Imported by the layers in ../master/. Never put a value here that depends on one project or one request.
 */
import type * as T from "../../core/types";
import { MAX_CARRY_TOTAL_BYTES } from "../../core/land/carry";

/** Commits that gitring makes. ".invalid" is a reserved domain: no person can own this address. */
export const GITRING_AUTHOR = { name: "gitring", email: "noreply@gitring.invalid" };
export const BUILD_ID = "0.9.2+20261011e";
export const MAX_LOGS = 500;

export const MAX_CHECKS = 300;
/** Above this many radar pairs, a check forgets the pairs of work that left the traffic (see trimRadar). */
export const MAX_RADAR_PAIRS = 2000;
export const TERMINAL: ReadonlySet<T.AttemptStatus> = new Set(["landed", "abandoned", "alternate", "failed", "stale"]);
/** Default built-in AI agent starts per hour for the whole deployment (AI_AGENTS_PER_HOUR overrides). */
export const LLM_STARTS_PER_HOUR = 40;
/** Default built-in AI agent starts per hour and person (AI_AGENTS_PER_USER_HOUR overrides). */
export const LLM_STARTS_PER_USER_HOUR = 12;
/**
 * A merge run that no run has finished stays "in progress" this long. After that, the queue starts it
 * again (the object that ran it stopped: evicted or crashed).
 */
export const LANDING_LEASE_MS = 5 * 60_000;
/** One merge starts at most this many times (crashes included). Then a person decides. */
export const MAX_LANDING_STARTS = 4;
/** The steward counts the facts this often while agents work (project setting `steward`). */
export const STEWARD_EVERY_MS = 3 * 60_000;
/** The model words at most this many new findings in one sweep (each call can take seconds). */
export const STEWARD_WORDS_PER_SWEEP = 3;
/** What people and agents read when the gitring test harness ran no test (nothing is verified). */
export const NO_TEST_RAN = "No test ran. A person must decide to merge.";
/** The UTF-8 byte order mark as text. gitring's text of a file never starts with it (TextDecoder takes it away). */
export const BOM = "﻿";
/**
 * Bytes that one blob reader keeps after a read (a merge reads a file for its size, then for the commit).
 * The project object has 128 MB of memory: these limits, and MAX_CARRY_TOTAL_BYTES, keep a merge far below it.
 */
export const READER_CACHE_BYTES = MAX_CARRY_TOTAL_BYTES;
/** The test container gets at most this many bytes of files without text, and reads at most this many such files. */
export const MAX_TEST_TREE_BYTES = 16_000_000;
export const MAX_TEST_TREE_READS = 5000;
/** Blobs of unknown size that gitring reads at once (it learns the size of a blob only when it reads it). */
export const SIZE_READS = 4;
/** Characters of text that the cache of blob ids keeps (about 8 MB of memory). */
export const TEXT_ID_CHARS = 4_000_000;
