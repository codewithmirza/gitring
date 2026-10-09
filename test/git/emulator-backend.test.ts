/**
 * EmulatorBackend against a fake DurableObjectNamespace whose stubs behave like Workers RPC:
 * arguments and results are structured-cloned, and thrown errors lose their class and fields.
 */
import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/core/git/objects";
import { RepoConflictError } from "../../src/platform/repo/backend";
import { EmulatorBackend, EmulatorService } from "../support/git-emulator/service";
import { GitStore, MemoryObjectStore } from "../support/git-emulator/store";

function fakeNamespace() {
  const instances = new Map<string, EmulatorService>();
  const calls: string[] = [];
  const ns = {
    idFromName(name: string) {
      return { name, toString: () => `id:${name}`, equals: () => false };
    },
    get(id: { name: string }) {
      let svc = instances.get(id.name);
      if (!svc) {
        svc = new EmulatorService(new GitStore(new MemoryObjectStore()));
        instances.set(id.name, svc);
      }
      const target = svc;
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            return async (...args: unknown[]) => {
              calls.push(`${id.name}.${method}`);
              const fn = (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
              try {
                return structuredClone(await fn.apply(target, structuredClone(args)));
              } catch (err) {
                throw new Error((err as Error).message); // RPC keeps the message, not the class
              }
            };
          },
        },
      );
    },
  };
  return { ns: ns as unknown as DurableObjectNamespace<never>, instances, calls };
}

const author = { name: "Vessel", email: "v@gitring.dev" };

describe("EmulatorBackend", () => {
  it("talks to one DO per namespace and implements RepoBackend", async () => {
    const { ns, instances, calls } = fakeNamespace();
    const backend = new EmulatorBackend(ns as never, "proj-1");
    expect(backend.kind).toBe("emulator");

    expect(await backend.ensureRepo("canon")).toEqual({ name: "canon", defaultBranch: "main" });
    const c1 = await backend.commit({
      repo: "canon",
      branch: "main",
      parent: "",
      message: "Seed",
      author,
      changes: [
        { path: "src/products.js", content: "export const formatPrice = (c) => `$${c / 100}`;\n" },
        { path: "assets/logo.bin", content: new Uint8Array([137, 80, 78, 71]) },
      ],
      note: "seed note",
    });
    const fork = await backend.fork("canon", "att-1", { description: "attempt" });
    expect(fork).toEqual({ name: "att-1", defaultBranch: "main" });
    expect(fork.token).toBeUndefined();
    expect(await backend.resolve("att-1", "main")).toBe(c1.sha);

    const tree = await backend.readTree("canon", c1.tree);
    const assets = await backend.readTree("canon", tree!.find((e) => e.name === "assets")!.hash);
    const logo = await backend.readBlob("canon", assets![0].hash);
    expect(logo).toBeInstanceOf(Uint8Array);
    expect([...logo!]).toEqual([137, 80, 78, 71]);
    expect((await backend.readCommit("canon", c1.sha))?.message).toBe("Seed");
    expect((await backend.log("canon", "main")).map((c) => c.hash)).toEqual([c1.sha]);
    expect(await backend.readNote("canon", c1.sha)).toBe("seed note");
    expect(await backend.createToken("canon", "write", 600)).toBeUndefined();
    expect(await backend.remoteUrl("canon")).toBeUndefined();
    expect((await backend.listRepos()).map((r) => r.name)).toEqual(["att-1", "canon"]);

    // Everything went to the single DO named after the namespace.
    expect([...instances.keys()]).toEqual(["proj-1"]);
    expect(calls.every((c) => c.startsWith("proj-1."))).toBe(true);

    // A second namespace is a separate DO with its own repos.
    const other = new EmulatorBackend(ns as never, "proj-2");
    await expect(other.resolve("canon", "main")).rejects.toThrow(/NOT_FOUND/);
  });

  it("re-creates RepoConflictError (with expected/actual) across the RPC boundary", async () => {
    const { ns } = fakeNamespace();
    const backend = new EmulatorBackend(ns as never, "p");
    await backend.ensureRepo("r");
    const c1 = await backend.commit({ repo: "r", branch: "main", parent: "", message: "1", author, changes: [{ path: "a", content: "1" }] });
    const c2 = await backend.commit({ repo: "r", branch: "main", parent: c1.sha, message: "2", author, changes: [{ path: "a", content: "2" }] });
    const err = await backend
      .commit({ repo: "r", branch: "main", parent: c1.sha, message: "3", author, changes: [{ path: "a", content: "3" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoConflictError);
    expect(err).toMatchObject({ name: "RepoConflictError", expected: c1.sha, actual: c2.sha });

    // Other errors still surface (message preserved).
    await expect(backend.commit({ repo: "r", branch: "main", parent: c2.sha, message: "x", author, changes: [{ path: "../x", content: "" }] })).rejects.toThrow(
      /invalid path/,
    );
    await backend.deleteRepo("r");
    await expect(backend.log("r", "main")).rejects.toThrow(/NOT_FOUND/);
    expect(utf8.decode(utf8.encode("ok"))).toBe("ok");
  });
});
