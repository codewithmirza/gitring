# src/platform/repo

How gitring touches git storage. Everything goes through the `RepoBackend` interface, so tests can use a git emulator in place of Cloudflare Artifacts.

| File | What it is for |
|---|---|
| `backend.ts` | The `RepoBackend` interface and its types. The only way gitring touches git storage. |
| `artifacts.ts` | The backend on Cloudflare Artifacts (production). The front door of `artifacts-backend/`. |
| `artifacts-backend/` | The layers of the Artifacts backend. Start with its `README.md`. |
| `push.ts` | A small git smart-HTTP client that pushes a pack of new objects and moves refs. |
| `pack.ts` | Writes a git pack for a push in a Worker. |
| `memory-fs.ts` | An in-memory filesystem for isomorphic-git inside a Worker. |
| `blob-cache.ts` | A cache of small blobs in front of Artifacts reads. |
