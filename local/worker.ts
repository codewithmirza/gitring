/**
 * Entry of the local run (wrangler.local.jsonc). The Worker is the real one.
 * Only the Artifacts binding of the project coordinator (HarborMaster) is new:
 * it sends each call to the test version of Artifacts (see local/start.mjs), which keeps real git
 * repositories on your computer. It does not run on Cloudflare.
 */
import { HarborMaster as AppHarborMaster } from "../src/harbor/harbor";

export { default } from "../src/worker/index";
export { Vessel } from "../src/vessel/vessel";
export { Directory } from "../src/directory/directory";
export { Drydock, Seawall } from "../src/drydock/drydock";

class LocalArtifacts {
  constructor(private readonly base: string) {}

  private async call(repo: string | undefined, method: string, args: unknown[]): Promise<unknown> {
    const res = await fetch(`${this.base}/rpc`, { method: "POST", body: JSON.stringify({ repo, method, args }) });
    const body = (await res.json()) as { result?: unknown; error?: { code: string; message: string } };
    if (body.error) throw Object.assign(new Error(body.error.message), { name: "ArtifactsError", code: body.error.code });
    return body.result;
  }

  create(name: string, opts?: unknown) {
    return this.call(undefined, "create", [name, opts]);
  }
  delete(name: string) {
    return this.call(undefined, "delete", [name]);
  }
  list() {
    return this.call(undefined, "list", []);
  }
  async import(): Promise<never> {
    throw new Error("This local run cannot import a repository. Start with an empty project.");
  }
  async get(name: string) {
    await this.call(undefined, "get", [name]);
    const c = (method: string, ...args: unknown[]) => this.call(name, method, args);
    return {
      info: () => c("info"),
      createToken: (scope?: string, ttl?: number) => c("createToken", scope, ttl),
      listTokens: () => c("listTokens"),
      revokeToken: (token: string) => c("revokeToken", token),
      log: (opts?: unknown) => c("log", opts),
      readCommit: (hash: string) => c("readCommit", hash),
      readTree: (hash: string) => c("readTree", hash),
      readFile: async () => null,
      readBlob: async (hash: string) => {
        const out = (await c("readBlob", hash)) as { base64: string } | null;
        return out ? new Blob([Uint8Array.from(atob(out.base64), (ch) => ch.charCodeAt(0))]) : null;
      },
      fork: (target: string, opts?: unknown) => c("fork", target, opts),
      [Symbol.dispose]() {},
    };
  }
}

export class HarborMaster extends AppHarborMaster {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, { ...env, ARTIFACTS: new LocalArtifacts(env.LOCAL_ARTIFACTS_URL ?? "http://127.0.0.1:8792") });
  }
}
