/**
 * A WorkerLoader for Node tests. It runs Dynamic Worker code in Node with native ES modules:
 * it writes the module map to a temp dir (with a package.json of type "module"), starts a
 * worker thread that imports the main module, and sends each fetch to that thread.
 *
 * Like workerd: one "isolate" (worker thread) per id, the code callback runs once per id, module
 * state survives between requests, a plain string module must have a ".js" name, and a failed start
 * rejects with "Failed to start Worker: Uncaught <Error>". Unlike workerd: Node compiles only the
 * imported graph, and globalOutbound / limits have no effect.
 *
 * Worker threads (not import() in the test) because vitest runs tests through Vite's module runner,
 * which does not report ES module link errors the way native ES modules do.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export interface NodeLoader extends WorkerLoader {
  /** Every id passed to get(), in call order. */
  readonly ids: string[];
  /** How many times a code callback ran. */
  codeCalls(): number;
  /** The WorkerCode returned for each id. */
  readonly codes: Map<string, WorkerLoaderWorkerCode>;
  cleanup(): Promise<void>;
}

interface WireRequest {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
}

type WireReply =
  | { id: number; ok: true; status: number; statusText: string; headers: [string, string][]; body: string }
  | { id: number; ok: false; phase: "start" | "fetch"; name: string; message: string };

// Runs inside the worker thread (CommonJS eval). It imports the main module natively.
const DRIVER = `
const { parentPort, workerData } = require("node:worker_threads");
const ready = import(workerData.entry).then((mod) => ({ mod }), (error) => ({ error }));
parentPort.on("message", async (msg) => {
  const loaded = await ready;
  if (loaded.error) {
    const e = loaded.error;
    parentPort.postMessage({ id: msg.id, ok: false, phase: "start", name: (e && e.name) || "Error", message: String((e && e.message) || e) });
    return;
  }
  try {
    const init = { method: msg.method, headers: msg.headers, redirect: "manual" };
    if (msg.body !== null) init.body = Buffer.from(msg.body, "base64");
    const res = await loaded.mod.default.fetch(new Request(msg.url, init));
    const body = Buffer.from(await res.arrayBuffer()).toString("base64");
    parentPort.postMessage({ id: msg.id, ok: true, status: res.status, statusText: res.statusText, headers: [...res.headers], body });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, phase: "fetch", name: (e && e.name) || "Error", message: String((e && e.message) || e) });
  }
});
`;

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

class Isolate {
  private next = 0;
  private readonly pending = new Map<number, (reply: WireReply) => void>();
  private dead: { name: string; message: string } | null = null;
  constructor(private readonly worker: Worker) {
    worker.unref();
    worker.on("message", (reply: WireReply) => {
      this.pending.get(reply.id)?.(reply);
      this.pending.delete(reply.id);
    });
    const die = (name: string, message: string) => {
      this.dead = { name, message };
      for (const [id, resolve] of this.pending) resolve({ id, ok: false, phase: "start", name, message });
      this.pending.clear();
    };
    worker.on("error", (err: Error) => die(err.name || "Error", err.message));
    worker.on("exit", (code: number) => die("Error", `The isolate stopped (exit code ${code}).`));
  }

  async fetch(request: Request): Promise<Response> {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const wire: WireRequest = {
      id: this.next++,
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: hasBody ? Buffer.from(await request.arrayBuffer()).toString("base64") : null,
    };
    const reply = await new Promise<WireReply>((resolve) => {
      if (this.dead) return resolve({ id: wire.id, ok: false, phase: "start", ...this.dead });
      this.pending.set(wire.id, resolve);
      this.worker.postMessage(wire);
    });
    if (!reply.ok) {
      const message = reply.phase === "start" ? `Failed to start Worker:\nUncaught ${reply.name}: ${reply.message}` : reply.message;
      throw Object.assign(new Error(message), { name: reply.phase === "start" ? "Error" : reply.name });
    }
    const body = NULL_BODY_STATUS.has(reply.status) ? null : Buffer.from(reply.body, "base64");
    return new Response(body, { status: reply.status, statusText: reply.statusText, headers: reply.headers });
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

export function nodeLoader(): NodeLoader {
  const dirs: string[] = [];
  const isolates = new Map<string, Promise<Isolate>>();
  const codes = new Map<string, WorkerLoaderWorkerCode>();
  const ids: string[] = [];
  let calls = 0;

  function start(id: string, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>): Promise<Isolate> {
    let isolate = isolates.get(id);
    if (!isolate) {
      isolate = (async () => {
        calls += 1;
        const code = await getCode();
        codes.set(id, code);
        const dir = await writeModules(code);
        dirs.push(dir);
        const entry = pathToFileURL(path.join(dir, code.mainModule)).href;
        return new Isolate(new Worker(DRIVER, { eval: true, workerData: { entry } }));
      })();
      isolates.set(id, isolate);
    }
    return isolate;
  }

  function stub(id: string, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>): WorkerStub {
    const entrypoint = {
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const request = new Request(input as RequestInfo, init);
        return (await start(id, getCode)).fetch(request);
      },
    };
    return {
      getEntrypoint: () => entrypoint as unknown as Fetcher,
      getDurableObjectClass: () => {
        throw new Error("nodeLoader does not support Durable Object classes");
      },
    } as unknown as WorkerStub;
  }

  return {
    ids,
    codes,
    codeCalls: () => calls,
    get(name: string | null, getCode) {
      const id = name ?? `anonymous:${ids.length}`;
      ids.push(id);
      return stub(id, getCode);
    },
    load(code: WorkerLoaderWorkerCode) {
      const id = `load:${ids.length}`;
      ids.push(id);
      return stub(id, () => code);
    },
    async cleanup() {
      const started = await Promise.allSettled([...isolates.values()]);
      await Promise.all(started.map((s) => (s.status === "fulfilled" ? s.value.terminate() : undefined)));
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}

async function writeModules(code: WorkerLoaderWorkerCode): Promise<string> {
  if (!(code.mainModule in code.modules)) throw new Error(`mainModule ${code.mainModule} is not in modules`);
  const dir = await mkdtemp(path.join(tmpdir(), "gitring-node-loader-"));
  await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
  for (const [name, mod] of Object.entries(code.modules)) {
    let source: string | undefined;
    if (typeof mod === "string") {
      if (!name.endsWith(".js")) throw new TypeError(`Module name must end with '.js' or '.py'. Got: ${name}`);
      source = mod;
    } else {
      source = (mod as WorkerLoaderModule).js;
    }
    if (typeof source !== "string") throw new TypeError(`nodeLoader supports only JavaScript modules. Got: ${name}`);
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  return dir;
}

/** A tree as a Map (what runChecks and servePreview take). */
export function treeMap(tree: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(tree));
}
