/**
 * Durable Object `ctx.storage.sql` over node:sqlite (in memory): exec() returns a cursor with
 * toArray(), one() and iteration, like SqlStorageCursor.
 */
type NodeSqlite = typeof import("node:sqlite");

export interface SqlCursorLike<T> extends Iterable<T> {
  toArray(): T[];
  one(): T;
}

export function sqliteCtx(): { storage: { sql: { exec<T = Record<string, unknown>>(q: string, ...b: unknown[]): SqlCursorLike<T> } }; close(): void } {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as NodeSqlite;
  const db = new DatabaseSync(":memory:");
  return {
    storage: {
      sql: {
        exec<T>(query: string, ...bindings: unknown[]): SqlCursorLike<T> {
          const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as never[];
          const rows = db.prepare(query).all(...args) as T[];
          return {
            toArray: () => rows,
            one: () => {
              if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}.`);
              return rows[0];
            },
            [Symbol.iterator]: () => rows[Symbol.iterator](),
          };
        },
      },
    },
    close: () => db.close(),
  };
}
