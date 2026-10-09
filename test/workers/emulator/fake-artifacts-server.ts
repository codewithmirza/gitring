/**
 * Node process for the workerd probe of ArtifactsBackend: real `git http-backend` (data plane)
 * plus the FakeArtifacts binding exposed as JSON over HTTP (control plane + reads), so a Worker
 * running in wrangler dev can drive ArtifactsBackend end to end.
 *
 *   node_modules/.bin/esbuild test/workers/emulator/fake-artifacts-server.ts --bundle --platform=node \
 *     --format=esm --outfile=<scratch>/fake-artifacts-server.mjs
 *   node <scratch>/fake-artifacts-server.mjs <repos-dir> 8792
 *
 * POST /rpc { repo?, method, args } → { result } | { error: { code, message } }
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { FakeArtifacts, startGitHttpServer } from "../../git/fake-artifacts";

const [root = "./tmp/agentA-repos", portArg = "8792"] = process.argv.slice(2);
mkdirSync(root, { recursive: true });

const git = await startGitHttpServer(root);
const binding = new FakeArtifacts({ root, baseUrl: git.url });
git.authorize = (repo, password, service) => binding.checkToken(repo, password, service);
const handles = new Map<string, ArtifactsRepo>();

async function call(repo: string | undefined, method: string, args: unknown[]): Promise<unknown> {
  if (!repo) {
    if (method === "get") {
      const name = String(args[0]);
      handles.set(name, await binding.get(name));
      return true;
    }
    const fn = (binding as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
    if (!["create", "delete", "list"].includes(method) || !fn) throw Object.assign(new Error(`unknown method ${method}`), { code: "INVALID_INPUT" });
    return fn.apply(binding, args);
  }
  const handle = handles.get(repo) ?? (await binding.get(repo));
  handles.set(repo, handle);
  const fn = (handle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
  if (!fn) throw Object.assign(new Error(`unknown method ${method}`), { code: "INVALID_INPUT" });
  const out = await fn.apply(handle, args);
  if (out instanceof Blob) return { base64: Buffer.from(await out.arrayBuffer()).toString("base64") };
  return out;
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      try {
        const { repo, method, args } = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { repo?: string; method: string; args?: unknown[] };
        const result = await call(repo, method, args ?? []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: result ?? null }));
      } catch (err) {
        const e = err as { code?: string; message?: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: e.code ?? "INTERNAL_ERROR", message: e.message ?? String(err) } }));
      }
    })();
  });
});
server.listen(Number(portArg), "127.0.0.1", () => {
  console.log(`fake artifacts rpc on http://127.0.0.1:${portArg}, git on ${git.url}, repos in ${root}`);
});
