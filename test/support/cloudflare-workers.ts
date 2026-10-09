/**
 * Test stand-in for the "cloudflare:workers" module, so that Durable Object classes load in Node.
 * Only the base class is here: tests give it a ctx with node:sqlite storage (see sqlite-storage.ts).
 */
export class DurableObject<E = unknown> {
  protected ctx: unknown;
  protected env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<E = unknown> {
  protected ctx: unknown;
  protected env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
