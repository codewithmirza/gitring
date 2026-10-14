/**
 * RepoBackend over Cloudflare Artifacts (production): the repositories of all projects live there.
 *
 * ArtifactsBackend is the last class of a chain of layers in src/platform/repo/artifacts-backend/.
 * Reads go through the Workers binding. A commit is a changeset pushed in one pack (see writes.ts).
 * What the real service answered is in ARTIFACTS_CHECKS at the end of this file.
 * Read next: src/platform/repo/artifacts-backend/README.md and src/platform/repo/backend.ts.
 */
import type { RepoBackend } from "./backend";
import { ArtifactsWrites } from "./artifacts-backend/writes";

export { NOTES_REF } from "./artifacts-backend/types";
export type { ArtifactsBackendOptions } from "./artifacts-backend/types";
export { artifactsErrorCode } from "./artifacts-backend/errors";
export { tokenSecret } from "./artifacts-backend/helpers";
export { fannedNotePath } from "./artifacts-backend/git-local";

export class ArtifactsBackend extends ArtifactsWrites implements RepoBackend {}

/**
 * ARTIFACTS_CHECKS: what the real service answered. The unit tests use a fake binding over bare repositories
 * served by `git http-backend`. On 11 October 2026 a copy of gitring with its own namespace ran 11 load runs
 * (up to 60 agents, 562 merged tasks) and a probe against the real Artifacts service. All 11 points are answered,
 * with two corrections (points 4 and 8). The numbers are in the Load bullet of README.md.
 *   1. An isomorphic-git shallow clone (`depth: 1, singleBranch`, protocol v1) works. Every merge uses it.
 *   2. Basic auth `x:<secret>` on the first request is accepted. No answer had status 401 in 7,248 git requests.
 *   3. A push that starts from an old commit is refused. The answer has status 200 and says `unpack ok` and
 *      `ng refs/heads/main stale ref`. isomorphic-git throws GitPushError, commit() reads the branch and throws
 *      RepoConflictError, and the branch keeps the commit of the other writer. Test: two writers, and the second
 *      one sends its push after the first one has moved the branch.
 *   4. CORRECTION: `log({ ref: "refs/notes/gitring" })` gives [] (the binding knows branch names only). So readNote
 *      always uses the git fallback: one binding.get, one log and two git requests, 0.25 to 1 s.
 *   5. `log({ ref })` of a missing branch gives [] and not an error, also on an empty repository
 *      (tested with `main`, `nope` and `refs/heads/nope`).
 *   6. A push of `refs/notes/gitring` (a ref that is not a branch) is accepted. Forks use `defaultBranchOnly: true`
 *      and start without notes.
 *   7. ArtifactsError.code arrives through the binding call: NOT_FOUND and ALREADY_EXISTS (no need for the message).
 *   8. CORRECTION: fork() does not return before the copy is ready (2 to 4 s) and the copy can be used at once. No
 *      FORK_IN_PROGRESS and no CREATE_IN_PROGRESS in 580 forks, so the 20 s retry budget stays unused.
 *   9. readTree gives the modes "100644", "40000" and "120000" (type "symlink"). A file with mode 100755 and a
 *      gitlink were not read back (the harbor reads the mode).
 *  10. A root commit to an empty repository, and a root commit to a new branch of a repository that has commits, work.
 *  11. A repository of 47 MB in 6,000 files: the first commit takes 17 s, and a merge (clone of the whole latest
 *      tree, one changed file, push) takes 9 s. Smaller: 12 MB 4 s, 23 MB 7 s. No limit was hit (128 MB of memory,
 *      cpu_ms 300000). The clone of the whole latest tree is the cost that grows with the size of the repository.
 */
