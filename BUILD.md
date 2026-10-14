# The agentic-first build: where it stands

This file is for a person or an agent who continues the build. It says what is done, what is open, and how to go on. The full specification (every workstream, every contract, the rules for builders) is in `private/build/PLAN.md` on Mirza's computer; that folder is not in git. This file carries enough to continue without it.

Last update: 14 Oct 2026, evening. All workstreams of the agentic-first build are merged into `agentic` and `main`. Wave 3 (readable code, the design agent) is in progress: see the next section.

## Branches

- `agentic` is the integration branch. Every finished workstream merges into it as soon as it passes.
- `main` is production. Cloudflare Workers Builds watches the GitHub repo and, for each commit on `main`, runs `npm run build` and `npx wrangler deploy`. So push to `main` only code that passed typecheck, build and the full suite, then run the public checks (`/api/health`, unsigned `/mcp` answers 401, the OAuth discovery documents).
- For checkpoints use `integrate`, `agentic` and the `ws/*` branches. They do not deploy. A usage limit must never trap work on one computer: push these branches often.
- Push `agentic`, `main` and every `ws/*` branch after each commit: `git push origin main agentic ws/<name>`. Push each branch by name; never `--all` or `--mirror` (the repo policy). Nothing under `private/` is ever tracked.
- `ws/<name>` branches hold one workstream each. Worktrees live in `.claude/worktrees/ws-<name>` (git-ignored); `node_modules` there is a junction to the main checkout.

## Done and merged into `agentic`

| Workstream | What it adds |
|---|---|
| agent channel | Change requests ride in every tool answer. `gitring_wait` replaces sleep loops. An ack is checked against the code. Requests an agent never answered become "closed at merge". Only the sender or an owner changes a work copy. |
| human loop | A person chooses where to answer merge questions (agent chat, app, both). `/inbox` across projects, with web push. Escalated conflict checks become questions a person answers. A comment on a diff line becomes a change request. The lost-change-request bug at submit is fixed. |
| agent-first projects | `gitring_create_project`, `gitring_templates`, `gitring_clone`. Starter templates whose tests run in a Dynamic Worker. "Describe what you want to build". The test-command guess for every source. GitHub is the last, optional source; sync is off by default. |
| passkeys | People sign up and sign in with a passkey only. No outside account is needed. |
| merge fidelity | Git mode carries binary files and modes. The approval digest covers the agent's own contribution, so a rebase keeps a person's yes. Recovery when a merge crashes mid-way. |
| GLM + hygiene | Built-in agents on `@cf/zai-org/glm-5.3-flash` (and `glm-5.3`) with the 1M context. Signed webhooks. Rate limits on hooks and previews. No tokens inside shell commands. |
| engine | "Closing" works. Plans declare `uses`, so interface conflicts show before code. Class members are symbols. JSX and path aliases parse. Fair R4 after a redo. |
| replay | `/replay`: the inside of gitring played back on the map (for people, and for the demo video). |
| history API | Derived data per merge (path history, blame, search). `gitring_why`, `gitring_history`, `gitring_search`, `gitring_diff`, and "Why?" on a line in the Code view. |
| CLI | `cli/gitring.mjs`: login (device grant), projects, new, clone, tasks, task, inbox, yes, back, watch. |
| changesets | Commits that cost the size of the change: incremental objects, a minimal receive-pack client, O(1) notes, a blob cache, lazy forks for api-mode work copies. Measured: about 610 bytes per one-line commit, small tree or 605 files. |
| trains | Trains of independent work tested once. A post-merge test mode with bisect and automatic revert. "Largest train" and "When are tests run?" in Settings. |
| meaning | Approvals by the kind of change (comment, layout, docs, tests, logic) and rules by folder, checked at plan time and at submit. |
| steward | A watching agent per project that puts real anomalies into the inbox. Off by default. |
| docs | README, plugin skill and a README test. |

Also: the plugin test runs on Windows.

## Wave 3: readable code and the design agent (in progress)

Mirza asked for two things: every file easy to read, and better UX and UI through a design knowledge agent (idea from the talk "How to scale intent, quality, and artistry with AI" by Katie Dill, Stripe).

Already on `main`:
- `docs/CODE-STYLE.md`: the rules of a readable file, the glossary of code names and plain names, how to split a file.
- `docs/design/INTENT.md` and `docs/design/CRITIQUE.md`: what gitring looks like and why, the review checks, the loop "review, fix, look again".
- `.claude/agents/gitring-design.md`: the design agent. Ask Claude Code: "use the gitring-design agent to review the Tasks screen".
- `test/structure.test.ts`: the size, header and README rules. Its three lists are debts. Fix a debt, then delete its line.

In progress (branches, each in a worktree `.claude/worktrees/ws-<name>`): `ws/s-harbor` (split of `src/harbor/harbor.ts` into a chain of layers under `src/harbor/master/`), `ws/s-core` (`symbols.ts`, `types.ts`), `ws/s-server` (`directory.ts`, `worker/index.ts`, `oauth.ts`, `artifacts.ts`), `ws/s-web` (the big views and CSS), `ws/s-cli` (`cli/gitring.mjs`, scripts), `ws/design` (`scripts/shots.mjs`, `docs/design/SCREENS.md`, the first review in `docs/design/reviews/`).

Rules of this wave: code moves, behavior does not change; a split file stays as the front door with the same exports; each branch stays green (typecheck and its focused tests) at every commit.

Next: merge each branch into `agentic`, delete the stale lines of `test/structure.test.ts`, run the full suite, fast-forward `main`, push. Then fix the S1 and S2 findings of the first design review on the split web code and look at the screenshots again (`node scripts/shots.mjs`). Then write `docs/CODE-MAP.md`.

## Open items

1. `test/harbor/concurrency.test.ts` passes on its own (15 passed, 48 s for the file). It timed out once inside the full suite on a busy machine. Keep an eye on it.
2. (Done) The derived-history test with the large diff has its own 60 s limit.
3. A final review of the whole diff `4545b81..agentic`: correctness, security, plain words, no GitHub-first wording, tests.
4. The demo video. The toolkit is in `private/video/` (see its README). Recording waits until the code is done.

## How to continue

1. `git checkout agentic` in the main checkout. `npm ci` if `node_modules` is missing (npm 11: `npx npm@11 ci`).
2. Merge a finished branch: `git merge --no-ff ws/<name>`. Conflicts so far were unions of both sides (imports, tool lists, CSS blocks, a type's fields).
3. After each merge: `npm run typecheck`, the focused tests of the touched areas, then commit. Then the full suite: `npx vitest run --config vitest.config.ts --reporter=dot`.
4. Known Windows-only failures, not regressions: 3 tests in `test/checks/container.test.ts` (GNU tar and bash), the symlink test in `test/git/objects.test.ts`, and the timing limits in `test/harbor/concurrency.test.ts` when the machine is busy.
5. Commits: author Mirza; a plain subject; the last line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push as the branches section says. Never rewrite history. Deploys need a yes from Mirza.
