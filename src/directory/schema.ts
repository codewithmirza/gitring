/**
 * The SQL tables of the Directory. Every statement is safe to run again: the Directory runs all of them at start.
 *
 * Add a table or an index with CREATE ... IF NOT EXISTS. Never change a column of a stored table here: old data depends on it.
 * Read next: src/directory/layers/store.ts (runs this list) and src/directory/passkeys.ts (the passkey tables).
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, avatar TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, login TEXT, email TEXT, token TEXT, PRIMARY KEY (provider, subject))`,
  `CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used INTEGER)`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT, visibility TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS members (project_id TEXT NOT NULL, handle TEXT NOT NULL, user_id TEXT, role TEXT NOT NULL, PRIMARY KEY (project_id, handle))`,
  `CREATE INDEX IF NOT EXISTS members_user ON members (user_id)`,
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS states (state TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS budgets (owner TEXT PRIMARY KEY, starts TEXT NOT NULL)`,
  // Projects linked to a GitHub repository (lowercase "owner/name"): a push webhook reaches them.
  `CREATE TABLE IF NOT EXISTS github_links (repo TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (repo, project_id))`,
  `CREATE INDEX IF NOT EXISTS github_links_project ON github_links (project_id)`,
  // Webhook deliveries already handled (GitHub can send one twice; a replay must not open a task twice).
  `CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  // The preferences of a person (JSON): where they answer merge questions (contract C3).
  `CREATE TABLE IF NOT EXISTS prefs (user_id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  // Devices of a person that get push notifications for the inbox: the push address that the browser gave.
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id)`,
  // A login in GITRING_OWNERS stays with the account that used it first (logins can change hands).
  `CREATE TABLE IF NOT EXISTS owner_pins (handle TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, pinned_at INTEGER NOT NULL)`,
  // The waitlist gate: one record for each person who chose a pack, and the people that an owner let in.
  `CREATE TABLE IF NOT EXISTS waitlist (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, email TEXT, name TEXT NOT NULL, provider TEXT NOT NULL, pack TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS allowed (entry TEXT PRIMARY KEY, added_by TEXT, added_at INTEGER NOT NULL)`,
  // Use of each project in each month ("YYYY-MM"). Counters only: nothing here charges anyone.
  `CREATE TABLE IF NOT EXISTS usage (project_id TEXT NOT NULL, month TEXT NOT NULL, merges INTEGER NOT NULL DEFAULT 0, test_runs INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, month))`,
  // The public sample left the product (2026-10-10): archive its project.
  `UPDATE projects SET archived = 1 WHERE id = 'demo' AND source LIKE '%"sample"%'`,
];
