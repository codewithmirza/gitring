/**
 * HarborMaster persistence: SQLite (Durable Object storage) with JSON documents.
 * The DO keeps an in-memory mirror; this class is the write-through layer.
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS corrections (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS radar (a TEXT NOT NULL, b TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (a, b))`,
  `CREATE TABLE IF NOT EXISTS worktree (attempt_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (attempt_id, path))`,
  `CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, text TEXT, binary INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS queue (attempt_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS hooks (key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL)`,
  // The last version of each file that an agent read or wrote (to merge writes made from a stale copy).
  `CREATE TABLE IF NOT EXISTS seen (attempt_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT, PRIMARY KEY (attempt_id, path))`,
  // Files that gitring reset to the main version in a re-plot: the agent must read them before it writes them.
  `CREATE TABLE IF NOT EXISTS mustread (attempt_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (attempt_id, path))`,
];

export type DocTable = "intents" | "attempts" | "agents" | "corrections" | "decisions";

export class Db {
  constructor(private readonly sql: SqlStorage) {
    for (const s of SCHEMA) this.sql.exec(s);
  }

  /* meta */
  getMeta<T>(key: string): T | undefined {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? (JSON.parse(rows[0].value) as T) : undefined;
  }
  /** `undefined` removes the key. */
  setMeta(key: string, value: unknown): void {
    if (value === undefined) {
      this.sql.exec("DELETE FROM meta WHERE key = ?", key);
      return;
    }
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, JSON.stringify(value));
  }

  /* documents */
  putIntent(doc: { id: string }): void {
    this.sql.exec("INSERT OR REPLACE INTO intents (id, json) VALUES (?, ?)", doc.id, JSON.stringify(doc));
  }
  putAttempt(doc: { id: string; intentId: string }): void {
    this.sql.exec("INSERT OR REPLACE INTO attempts (id, intent_id, json) VALUES (?, ?, ?)", doc.id, doc.intentId, JSON.stringify(doc));
  }
  putAgent(doc: { id: string }): void {
    this.sql.exec("INSERT OR REPLACE INTO agents (id, json) VALUES (?, ?)", doc.id, JSON.stringify(doc));
  }
  putCorrection(doc: { id: string; attemptId: string }): void {
    this.sql.exec("INSERT OR REPLACE INTO corrections (id, attempt_id, json) VALUES (?, ?, ?)", doc.id, doc.attemptId, JSON.stringify(doc));
  }
  putDecision(doc: { id: string; at: number }): void {
    this.sql.exec("INSERT OR REPLACE INTO decisions (id, at, json) VALUES (?, ?, ?)", doc.id, doc.at, JSON.stringify(doc));
  }
  putCheck(doc: { id: string; attemptId: string; at: number }): void {
    this.sql.exec("INSERT OR REPLACE INTO checks (id, attempt_id, at, json) VALUES (?, ?, ?, ?)", doc.id, doc.attemptId, doc.at, JSON.stringify(doc));
  }
  putLanding(doc: { id: string; at: number }, note: string): void {
    this.sql.exec("INSERT OR REPLACE INTO landings (id, at, json, note) VALUES (?, ?, ?, ?)", doc.id, doc.at, JSON.stringify(doc), note);
  }
  landingNote(id: string): string | null {
    const rows = this.sql.exec<{ note: string | null }>("SELECT note FROM landings WHERE id = ?", id).toArray();
    return rows.length ? rows[0].note : null;
  }
  appendLog(doc: { at: number }): void {
    this.sql.exec("INSERT INTO logs (at, json) VALUES (?, ?)", doc.at, JSON.stringify(doc));
  }
  putRadar(a: string, b: string, doc: unknown): void {
    this.sql.exec("INSERT OR REPLACE INTO radar (a, b, json) VALUES (?, ?, ?)", a, b, JSON.stringify(doc));
  }

  all<T>(table: DocTable | "landings" | "radar"): T[] {
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM ${table}`)
      .toArray()
      .map((r) => JSON.parse(r.json) as T);
  }
  recentChecks<T>(limit: number): T[] {
    return this.sql
      .exec<{ json: string }>("SELECT json FROM checks ORDER BY at DESC LIMIT ?", limit)
      .toArray()
      .map((r) => JSON.parse(r.json) as T)
      .reverse();
  }
  checksFor<T>(attemptId: string): T[] {
    return this.sql
      .exec<{ json: string }>("SELECT json FROM checks WHERE attempt_id = ? ORDER BY at ASC", attemptId)
      .toArray()
      .map((r) => JSON.parse(r.json) as T);
  }
  recentLogs<T>(limit: number): T[] {
    return this.sql
      .exec<{ json: string }>("SELECT json FROM logs ORDER BY seq DESC LIMIT ?", limit)
      .toArray()
      .map((r) => JSON.parse(r.json) as T)
      .reverse();
  }

  /* worktree overlay (API-mode attempts) */
  worktree(attemptId: string): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const r of this.sql
      .exec<{ path: string; content: string | null; deleted: number }>(
        "SELECT path, content, deleted FROM worktree WHERE attempt_id = ? ORDER BY path",
        attemptId,
      )
      .toArray()) {
      out.set(r.path, r.deleted ? null : (r.content ?? ""));
    }
    return out;
  }
  writeWorktree(attemptId: string, path: string, content: string | null): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO worktree (attempt_id, path, content, deleted) VALUES (?, ?, ?, ?)",
      attemptId,
      path,
      content,
      content === null ? 1 : 0,
    );
  }
  clearWorktree(attemptId: string): void {
    this.sql.exec("DELETE FROM worktree WHERE attempt_id = ?", attemptId);
  }

  /* the version of a file the agent saw last (read or write); null = the agent saw no file */
  seen(attemptId: string, path: string): string | null | undefined {
    const rows = this.sql.exec<{ content: string | null }>("SELECT content FROM seen WHERE attempt_id = ? AND path = ?", attemptId, path).toArray();
    return rows.length ? rows[0].content : undefined;
  }
  setSeen(attemptId: string, path: string, content: string | null): void {
    this.sql.exec("INSERT OR REPLACE INTO seen (attempt_id, path, content) VALUES (?, ?, ?)", attemptId, path, content);
  }
  mustRead(attemptId: string, path: string): boolean {
    return this.sql.exec("SELECT 1 FROM mustread WHERE attempt_id = ? AND path = ?", attemptId, path).toArray().length > 0;
  }
  setMustRead(attemptId: string, path: string, on: boolean): void {
    if (on) this.sql.exec("INSERT OR REPLACE INTO mustread (attempt_id, path) VALUES (?, ?)", attemptId, path);
    else this.sql.exec("DELETE FROM mustread WHERE attempt_id = ? AND path = ?", attemptId, path);
  }

  /* blob text cache (content-addressed: never stale) */
  getBlobText(sha: string): { text: string | null } | undefined {
    const rows = this.sql.exec<{ text: string | null; binary: number }>("SELECT text, binary FROM blobs WHERE sha = ?", sha).toArray();
    if (!rows.length) return undefined;
    return { text: rows[0].binary ? null : rows[0].text };
  }
  putBlobText(sha: string, text: string | null): void {
    this.sql.exec("INSERT OR REPLACE INTO blobs (sha, text, binary) VALUES (?, ?, ?)", sha, text, text === null ? 1 : 0);
  }

  /* landing queue */
  enqueue(attemptId: string, at: number): void {
    this.sql.exec("INSERT OR REPLACE INTO queue (attempt_id, at) VALUES (?, ?)", attemptId, at);
  }
  dequeue(attemptId: string): void {
    this.sql.exec("DELETE FROM queue WHERE attempt_id = ?", attemptId);
  }
  queue(): string[] {
    return this.sql
      .exec<{ attempt_id: string }>("SELECT attempt_id FROM queue ORDER BY at ASC")
      .toArray()
      .map((r) => r.attempt_id);
  }

  /* hook keys (Claude Code hook → attempt) */
  setHook(key: string, attemptId: string): void {
    this.sql.exec("INSERT OR REPLACE INTO hooks (key, attempt_id) VALUES (?, ?)", key, attemptId);
  }
  hook(key: string): string | undefined {
    const rows = this.sql.exec<{ attempt_id: string }>("SELECT attempt_id FROM hooks WHERE key = ?", key).toArray();
    return rows[0]?.attempt_id;
  }
}
