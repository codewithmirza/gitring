/**
 * Turns values into plain text for the terminal: ages, tables, clock times, task words and JSON.
 * Called by the commands that print a list, and by context.mjs (plainText cleans every line).
 * Never print text from a person or an agent without plainText: it can carry escape codes.
 */

// ───── Words ─────

/** The words for the status of a task (the code name of the status is the key). */
export const TASK_WORDS = {
  draft: "Draft",
  open: "Open",
  underway: "Agents work on it",
  judging: "Needs a person",
  landing: "In the merge queue",
  landed: "Merged",
  parked: "Paused",
  "merged-into": "Duplicate",
};

/** "3 minutes", "2 hours", "4 days". */
export function age(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "less than a minute";
  if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = Math.floor(m / 60);
  if (h < 48) return h === 1 ? "1 hour" : `${h} hours`;
  return `${Math.floor(h / 24)} days`;
}

/**
 * The text without control characters. Titles, notes and logs come from other people and agents: an escape
 * sequence in them must not reach the terminal (it can move the cursor, hide text or write the clipboard).
 */
export function plainText(text) {
  return String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

// ───── Layout ─────

/** Rows of text in columns. */
export function table(rows) {
  if (!rows.length) return [];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? String(cell ?? "") : String(cell ?? "").padEnd(widths[i]))).join("  ").trimEnd());
}

/** The time of day, as 14:05:09, in the time zone of this computer. */
export function clock(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** A short title from a description: its first sentence, at most 80 characters. */
export function titleFrom(text) {
  const first = String(text).trim().split(/(?<=[.!?])\s|\n/)[0].replace(/[.!?]+$/, "").trim();
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}...` : first;
}

/** Print a value as JSON and answer the exit code 0 (for the option --json). */
export function printJson(ctx, value) {
  ctx.out(JSON.stringify(value, null, 2));
  return 0;
}
