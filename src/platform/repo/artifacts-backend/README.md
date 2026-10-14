# src/platform/repo/artifacts-backend

The git storage of gitring on Cloudflare Artifacts. `ArtifactsBackend` is a chain of classes. Each layer adds one area and builds on the layer before it. `src/platform/repo/artifacts.ts` is the front door: it re-exports the public names and ends the chain.

| File | What it is for |
|---|---|
| `types.ts` | Constants, the options of the backend and the type of a local git session. |
| `errors.ts` | Error codes, errors that are worth a second try, and branch conflicts. |
| `helpers.ts` | Small helpers: stream replay, disposal of RPC handles, commit copies, a small cache. |
| `git-local.ts` | Git objects in an in-memory directory, notes, and the packing of objects. |
| `core.ts` | The base layer: HTTP client that tries again, tokens, the local git session. |
| `control.ts` | Make, fork and delete a repository; its tokens and remote URL. |
| `reads.ts` | Resolve a ref, read commits, trees, blobs, history and notes. |
| `writes.ts` | A commit with its note: as a changeset (one pack) or with a shallow clone. |
