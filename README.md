# gitring

gitring lets many coding agents change one repository at the same time.

Each agent sends its plan (steps, files, functions) before it writes code. gitring compares the plan with the 20 nearest other plans. It also compares the plan with changes that merged into main after the work copy began. If two agents will collide, gitring sends a change request to one of them. It does not reject the agent, and the agent continues. A collision with any other plan appears later, at the merge, as a text conflict or a failed test.

gitring merges work into main only when the tests pass. When main moves, api mode and git mode differ (see [Connect agents](#connect-agents)). In api mode, gitring moves the work copy onto the new main. In git mode, the agent runs `git pull` and fixes conflicts itself. Agents fix merge conflicts. When agents cannot agree, a person chooses. For example, a person picks one of several results.

gitring runs on Cloudflare Workers, Durable Objects, Artifacts, Workers AI, Dynamic Workers and Containers. Agents connect through MCP or plain git.

## How it works

```
1. A person writes a task (web page, API, GitHub issue).
2. An agent sends its plan ............................... gitring_declare
3. Conflict check: gitring measures the distance to each other active plan and judges the 20 nearest
      0 same lines · 1 shared function · 2 same file · 3 one import · 4 two imports · 5 no relation
   ├── distance 4 or 5 ... clear, no AI call
   ├── distance 3 ........ fixed rules decide, no AI call
   └── distance 0 to 2 ... a small Workers AI model decides; an unclear answer goes to a larger model;
                           if the AI fails, fixed rules decide
   Result: clear, or a change request to ONE agent. The other agent continues.
4. The agent works. Each write, report or push runs step 3 again.
5. The agent runs the tests (gitring_check) and asks for a merge (gitring_submit).
6. Merge, one at a time in each project:
   fast-forward → 3-way merge → tests on main + work → commit to main with a git note (the record of why)
   If the text conflicts or the combined tests fail, the work goes back to its agent (redo policy).
7. gitring tells the agents near the changed files that main moved.
```

| Term | Meaning |
|---|---|
| task | A change that a person wants: a goal, and test files if you add them. |
| plan | The steps, files and functions that an agent will change, and its approach. |
| work copy | A git copy (fork) of main for one agent on one task. |
| conflict check | gitring compares one plan with the 20 nearest other plans. It also compares the plan with changes that merged into main after the work copy began. |
| change request | A message from gitring to one agent: change your plan or your code. Never a rejection. |
| rebase | Work in progress gets the new main after a merge. In api mode, gitring does this (3-way, per file). In git mode, the agent does it with `git pull`. |
| redo | The task is done again on the new main, when the first work cannot merge. |
| history | The record of each merge: task, plan, change requests, tests and decisions (git notes and commit trailers). |

When two plans meet, these rules decide which agent continues and which agent adapts. The first rule that decides wins:

```
R1 merged work continues; work in progress adapts
R2 work that waits to merge continues
R3 the agent that changes a function signature continues; the agents that call it adapt
R5 high priority continues
R4 the earlier plan continues
R6 the smaller change adapts
```

Symbol analysis supports JavaScript and TypeScript. Other languages use files and line ranges.

## Run it

To run gitring on Cloudflare, you need Workers (paid plan), Artifacts, Workers AI, Dynamic Workers (Worker Loader) and Containers. Local development uses the Artifacts and Workers AI of your account. To try gitring with no Cloudflare account, see [Try it without a paid account](#try-it-without-a-paid-account).

```bash
npm install                      # npm 11 or later (npx npm@11 install)
npx wrangler login
cp .dev.vars.example .dev.vars   # then fill in the values
npm run dev                      # http://localhost:5173
```

The local server keeps its own storage (`.wrangler/state`), so sign-in on localhost needs its own one-time setup. Open `http://localhost:5173/setup?token=<GITRING_SETUP_TOKEN from .dev.vars>`:

- **GitHub**: the button makes a second app, `git-ring localhost`, with localhost callback URLs and no webhook (GitHub cannot reach your computer).
- **Google**: add the origin `http://localhost:5173` and the redirect URI `http://localhost:5173/auth/google/callback` to your OAuth client, then paste its ID and secret.

MCP clients and your own scripts do not need sign-in: send the `GITRING_KEY` from `.dev.vars` as `Authorization: Bearer <key>` to `http://localhost:5173`.

Tests:

```bash
npm test               # unit tests (Vitest)
npm run typecheck
```

## Try it without a paid account

You can run gitring on your computer. You do not need a Cloudflare account for this.

```bash
npm install
npm run dev:local
```

The command needs `git`. It does three things:

1. It builds the app.
2. It starts a test version of Artifacts. The test version keeps real git repositories in `tmp/local`.
3. It starts `wrangler dev` with `wrangler.local.jsonc`. Every binding runs on your computer.

The command prints a key. Send it as `Authorization: Bearer <key>` to `/api` and `/mcp` at the address that wrangler shows. Make an empty project like this:

```bash
curl -X POST http://localhost:8787/api/projects \
  -H "Authorization: Bearer <key>" -H "content-type: application/json" \
  -d '{"name":"demo","source":{"kind":"empty"},"settings":{"checks":{"runner":"worker"}}}'
```

Then connect an agent as described in [Connect agents](#connect-agents). Use the project id from the answer and the key from the command.

The local run has these limits:

- **No Workers AI**: fixed rules make the conflict check. The built-in agents need Workers AI, so they do not run.
- **Tests**: the `worker` runner runs `tests/*.test.js` files. There are no test containers. Work with no test needs the project setting that allows it (see [Tests of the work](#tests-of-the-work)).
- **Import**: it cannot import a repository. Start with an empty project.
- **Web page**: the web page needs a sign-in with GitHub or Google. This run has none set up. Use the API and MCP.
- **Data**: each start deletes the data of the run before.
- **Artifacts**: the test version is not Cloudflare Artifacts, and it can differ in details. Deploy to Cloudflare to test the real service.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/codewithmirza/gitring)

The button copies this repository to your GitHub or GitLab account, then builds and deploys it with Workers Builds. The new Worker needs the secrets in the table below. The [Cloudflare page for the button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) does not list Artifacts, Worker Loader or Containers as resources that it sets up.

To deploy from your own computer instead, run these commands:

```bash
npx wrangler secret put GITRING_SECRET        # seals sign-in credentials: openssl rand -base64 32
npx wrangler secret put GITRING_SETUP_TOKEN   # opens /setup before an owner signs in: openssl rand -hex 16
npx wrangler secret put GITRING_OWNERS        # github:your-login,google:you@example.com
npm run deploy                                # vite build + wrangler deploy
```

After you deploy, open `https://<your-worker>/setup?token=<GITRING_SETUP_TOKEN>`:

1. **GitHub**: one click creates a GitHub App for your Worker (sign-in, repository lists and imports, issue and push webhooks, GitHub sync). GitHub shows the app before it creates it.
2. **Google**: create an OAuth client of type Web application, with the redirect URI that the page shows, and paste its ID and secret.

Push to deploy with Workers Builds: production branch `main`, build command `npm run build`, deploy command `npx wrangler deploy`, root directory empty.

| Secret | Use |
|---|---|
| `GITRING_SECRET` | Required. Seals the GitHub App and Google credentials (AES-GCM). |
| `GITRING_SETUP_TOKEN` | Opens `/setup` before an owner signs in. |
| `GITRING_OWNERS` | Owners of the deployment: they open `/setup` and act on every project. |
| `GITRING_KEY` | Optional operator key for scripts. It acts as an owner on every project. |
| `GITRING_CONTACT` | Optional contact address on the privacy and terms pages. |
| `GITHUB_WEBHOOK_SECRET` | Optional. A plain repository webhook (without the app). The Connect page of a project shows its URL (`/hooks/github?project=<id>&key=…`). |
| `SLACK_SIGNING_SECRET` | Optional. The Slack slash command. The Connect page of a project shows its command URL (`/hooks/slack?project=<id>&key=…`). |

## Accounts and projects

- People sign in with GitHub or Google. Account adds the other sign-in, connects or disconnects GitHub, lists API keys and connected apps (MCP clients), and signs out everywhere.
- Roles per project: **owner** (settings, members), **member** (tasks, agents, merges), **viewer** (watch). Anyone can watch a public project; only members act on it.
- **New project** is one search field. It lists the GitHub repositories where the gitring app is installed and you have access, a pasted URL, a folder, `git push` and an empty project. For a repository, gitring guesses the name, the branch, the install and test commands (from lockfiles and manifests: Node, Python, Go, Rust, Ruby, Java, Deno, Make; a small model reads the README only when the rules find no test command) and the GitHub sync mode. One button creates the project.

  | Source | How |
  |---|---|
  | GitHub repository | Public: Artifacts imports it with its history. Private: gitring reads the branch tip through the GitHub App (one commit, at most 25 MB, checked file by file against GitHub's tree). Code of a private repository only goes into a private project. |
  | Import URL | Artifacts imports a public https repository (GitHub, GitLab, Bitbucket or any host), with its history. |
  | git push | gitring makes an empty repository and shows the owner a push command with a 24-hour token. Use it for large or private repositories on any host. |
  | Folder | The browser uploads a folder (without `.git`, dependencies and build output; at most 20 MB) as the first commit. |
  | Empty | A README. Agents write the code. |
- gitring keeps the GitHub App token of a person sealed (AES-GCM), refreshes it before it expires (one refresh at a time: GitHub refresh tokens work once), and asks GitHub as that person, so lists and guesses show only what the person may see.
- Built-in AI agents have an hourly budget: `AI_AGENTS_PER_USER_HOUR` per person and `AI_AGENTS_PER_HOUR` for the deployment (`wrangler.jsonc`). Over the budget, agents wait and start by themselves.

## Tests of the work

gitring merges work only when the tests pass: once on the work copy, and again on main plus the work before the merge.

| Runner | Where | Used by |
|---|---|---|
| container | A Cloudflare container per work copy (Node.js 24 on Debian). gitring copies the text files of the tree into it (see Limits). It runs the install command (default `npm ci` or `npm install`), then the test command (default `npm test`). Exit code 0 passes. | Every project (the default) |
| worker | A Dynamic Worker runs `tests/*.test.js` with gitring's small test harness. No dependencies, no network. | Small JavaScript projects without dependencies |

If the worker runner finds no test, gitring does not call the work verified. A person decides. An owner can allow work with no tests in the project settings.

Owners change the runner, the commands and the time limit in Settings → Tests. Test containers have no direct Internet access: a Worker entrypoint lets requests to package registries (npm, PyPI, Go proxy, Debian, crates.io, RubyGems, Maven, Gradle, JSR) pass and refuses all other hosts.

## Limits

These limits come from the design, not from speed tests.

- **Conflict check**: gitring judges the 20 nearest plans. A collision with any other plan appears later, at the merge, as a text conflict or a failed test.
- **Merge**: one change merges at a time in each project. Other work waits in the merge queue.
- **Test containers**: a container gets text files only. It gets at most 6,000 files, and each file has at most 1 MB. It gets no folder of dependencies or build output, such as `node_modules`, `vendor`, `dist`, `build`, `out` or `target`. It gets no binary file. The install command must make the dependencies. A test that needs such a file or folder does not work in the container. Container test runs have an hourly budget. The defaults are 240 for each project owner and 2,000 for the deployment (`CHECK_RUNS_PER_OWNER_HOUR`, `CHECK_RUNS_PER_HOUR` in `wrangler.jsonc`).
- **Redo**: gitring gives work back to the same agent at most 3 times. With the policy "Same agent only", a person decides after that. With the other policies, a built-in agent does the task again, at most 2 times. When the redos fail, a person decides.
- **Project size**: one coordinator for each project (a Durable Object) keeps the tasks and work copies of the project in memory. Plan for hundreds of active work copies in one project, up to about 2,000. Use several projects beyond that.
- **Symbol analysis**: it covers JavaScript and TypeScript only. Other languages use files and line ranges.
- **Artifacts**: Cloudflare sets these limits. Artifacts is in open beta, so they can change. See the [Artifacts limits page](https://developers.cloudflare.com/artifacts/platform/limits/) (numbers from 1 October 2026).
  - A repository holds at most 1 GB. A file holds at most 32 MB.
  - An account holds at most 1 TB. Cloudflare can raise this on request.
  - Each namespace allows 2,000 control requests every 10 seconds. Each repository allows 2,000 git requests every 10 seconds.
  - A project is one repository, and each work copy is one more. All projects of a deployment share one namespace.
  - gitring does not delete repositories. The repository of a finished work copy stays until you delete it.
- **Cost**: a deployment on Cloudflare needs a paid plan (Workers Paid). Cloudflare bills Artifacts operations and storage from 14 October 2026 (see [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)). Test containers also bill by use.

## Connect agents

gitring speaks MCP (streamable HTTP) at `https://<your-worker>/mcp`. Add it as a connector; the client signs you in with OAuth, and you allow it once:

| Client | How |
|---|---|
| Claude (claude.ai, desktop) | Settings → Connectors → Add custom connector → paste the URL → Connect → Allow. |
| Claude Code | `claude mcp add --transport http --scope user gitring https://<your-worker>/mcp`, then `/mcp` to sign in. |
| Cursor | The "Add to Cursor" button on the Connect page, or `.cursor/mcp.json` → `{ "mcpServers": { "gitring": { "url": "https://<your-worker>/mcp" } } }` |
| Codex | `codex mcp add gitring --url https://<your-worker>/mcp`, then `codex mcp login gitring`. |

OAuth 2.1 details: protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`, server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`, dynamic client registration (RFC 7591) and client ID metadata documents, authorization code with PKCE (S256 only), tokens bound to `<origin>/mcp` (RFC 8707), revocation (RFC 7009). Access tokens last one hour. Refresh tokens last 30 days and rotate at each use: each sign-in of an app is one token family, and a refresh token that comes back after its rotation ends that family. Only hashes of codes and tokens are stored. Account → Connected apps shows each app with its last use; Revoke ends its tokens.

Scripts and hooks send a personal API key instead (Account → API keys): `Authorization: Bearer gk_…`.

```bash
claude mcp add --transport http gitring https://<your-worker>/mcp --header "Authorization: Bearer $GITRING_KEY"   # Claude Code with a key
```

| Tool | What it does |
|---|---|
| `gitring_intents` | Lists your projects, or the open tasks of one project. |
| `gitring_declare` | Starts work on a task: send the plan, get a work copy and the first conflict check. |
| `gitring_traffic` | Shows the other active work near your plan. |
| `gitring_read`, `gitring_list` | Read files of your work copy (api mode). |
| `gitring_write` | Writes whole files into your work copy (api mode). Runs a conflict check. |
| `gitring_log` | Reports progress. In git mode, reports a push at once. Runs a conflict check. |
| `gitring_ack` | Confirms that you applied a change request. |
| `gitring_check` | Runs the tests of your work copy. In git mode, gitring tests your latest push. |
| `gitring_submit` | Asks for a merge. gitring tests again, then merges or asks a person to choose. |
| `gitring_update` | Brings the new main into your work copy. In git mode: a read-only remote and token for main. |

Two modes:

- **api mode** (default): the agent reads and writes files through gitring. gitring holds the working tree and merges writes made from an old copy. When main moves, gitring rebases the work copy. If the two changes overlap in a file, the file goes back to the version on main. The agent makes its change again.
- **git mode**: `gitring_declare` returns a remote for the work copy and a token (6 hours). The agent clones, commits and pushes with plain git. gitring reads the latest push at `gitring_check` and `gitring_submit`; `gitring_log` with the head SHA gets a conflict check at once. gitring does not rebase the work copy. When main moves, the agent merges it into its work (`gitring_update`, then `git pull`) and fixes the conflicts itself. Then gitring moves the base of the work copy to that main. If the agent does not merge main, gitring still merges text that does not overlap. It gives work with a text conflict back to the agent.

**Claude Code hook**: change requests can also arrive in the middle of a task, after each file edit. Add this to `.claude/settings.json` in the agent's repository, and give your repository folder as `workdir` in `gitring_declare`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command",
  "command": "curl -s -X POST -H 'content-type: application/json' -H \"Authorization: Bearer $GITRING_KEY\" --data-binary @- 'https://<your-worker>/hooks/claude/<project-id>'" } ] } ] } }
```

## Redo when work cannot merge

When the work of an outside agent cannot merge on the new main (a text conflict, or tests that fail on main plus the work), gitring follows the project's redo policy (Settings → Merging):

| Policy | What happens |
|---|---|
| Same agent first (default) | The work goes back to the same agent with a change request. If the agent does not answer in the wait time (default 15 minutes), a built-in agent does the task again. |
| Same agent only | The work goes back to the same agent. If the agent does not answer, a person decides. |
| Built-in agent | A built-in agent does the task again at once. |

The same agent gets the work back at most 3 times. Work of built-in agents is always done again by a built-in agent.

## Send merged code to GitHub, bring GitHub changes in

Settings → GitHub links a project to a GitHub repository (a GitHub import links its repository) and chooses where merged code goes:

| Mode | What happens |
|---|---|
| Off | Merged code stays in Cloudflare Artifacts. Clone it from the Artifacts remote. |
| Pull request | After each merge, gitring pushes main to a branch (default `gitring`) and keeps one pull request open to the followed branch. People merge it on GitHub ("Create a merge commit", so that the next pull request shows only new work). gitring never overwrites commits that people push to its branch. |
| Straight to main | After each merge, gitring fast-forwards the followed branch. When GitHub has commits that gitring does not have, gitring brings them in first. |

The followed branch is the imported branch (default: the repository's default branch). gitring makes one GitHub commit for each merge with the GitHub Git Data API and installation tokens of the gitring GitHub App, in batches of 200.

**Bring GitHub changes in**: a push to the followed branch (webhook), "Bring GitHub changes in now" in Settings, or a blocked sync starts a pull. gitring compares the last GitHub commit that main has with GitHub's branch, takes GitHub's version of files that only GitHub changed, merges text where both changed different lines (3-way), and commits one "Bring GitHub changes into main" commit; on GitHub it becomes a merge commit, so GitHub's history stays whole. When GitHub and main changed the same lines, gitring opens a task with GitHub's diff for an agent or a person; when it merges, the rest of the changes come in. Work in progress moves onto the new main, and its agents get a change request. Pulls run in the merge queue, one at a time.

Rights: linking a repository needs read rights on GitHub; turning sync on needs push rights and the app on the repository. gitring checks them as the person (their GitHub token), and checks again once a day before it pushes, or reads a private repository.

## Hooks: other apps in and out

| In | |
|---|---|
| `POST /hooks/intents` | Any app with a member's API key: `{ project, title, goal, checks?, source?, launch? }` → a new task |
| `POST /hooks/github-app` | The gitring GitHub App: an issue labeled `gitring` by a project member → a task in each project that imports or links the repository; a push to a followed branch → GitHub changes come into main. Each delivery counts once. |
| `POST /hooks/github` | A plain repository webhook (`GITHUB_WEBHOOK_SECRET`; the URL from the Connect page holds the project and its key) → a task, for the project's own repository only. Each delivery counts once. |
| `POST /hooks/slack` | Slash command `/gitring Add a dark mode — Readers can switch…` (`SLACK_SIGNING_SECRET`; the command URL from the Connect page holds the project and its key). Each signed request counts once. |
| **Out** | Project webhooks (Settings → Webhooks) get `landing` (a merge), `correction` (a change request), `decision` and `intent` events as JSON or Slack messages |

## Security

- Sessions, API keys, OAuth codes and tokens: only SHA-256 hashes are stored. Provider credentials and GitHub tokens are sealed with AES-GCM (key from `GITRING_SECRET`).
- Sign-ins are bound to the browser that started them (a cookie with the OAuth state); an OAuth consent is bound the same way. Browser sessions cannot make cross-site writes.
- Rate limits per Cloudflare location (Workers Rate Limiting): sign-in starts and client registration 20 a minute per address, OAuth token calls 120, MCP 600 a minute per person, the API 1200, and 3000 credential lookups a minute per address (keys and cookies that are not valid stop at the edge). New OAuth clients: 30 an hour per address.
- The OAuth consent page names the address that gets the app's code (a registered app can call itself anything); the Allow button works after one second. A request that cannot go on shows a page, not a redirect.
- A change of access closes the live connections that it concerns (a removed member, a project that turns private, a sign-out): each one connects again and gets its role checked.
- Imports, outbound webhooks and client metadata documents go to public hosts only (no IP addresses, no local names).
- The web app has a strict Content Security Policy (inline scripts allowed by hash only); server pages allow no scripts except one by nonce. Live previews of agent code run sandboxed and can set no cookies or other headers on the gitring origin.
- Viewers of public projects do not see webhook addresses. Code of a private GitHub repository never goes into a public project.

## Project layout

The code keeps the names of its first design. This list gives each one a plain name.

```
src/core        pure logic: git objects, diffs, 3-way merge, JS symbol analysis, distance,
                conflict-check facts, rules, model input and output, change requests, merge records
src/harbor      HarborMaster: the project coordinator (one Durable Object for each project)
src/vessel      Vessel: the built-in agent runner (Workers AI)
src/directory   Directory: the account store (people, sessions, API keys, projects, roles)
src/drydock     Drydock: test containers; Seawall: their outbound network filter
src/platform    Artifacts backend, GitHub (client, repository lists, imports, sync, pulls), Workers AI calls,
                Dynamic Worker tests and previews
src/worker      routes, sign-in, OAuth server for MCP clients, MCP server, GitHub routes, rate limits, hooks
web/src         React web app and its design system (/design opens it in local development)
scripts         palette.py prints the colors of the day, dusk and night themes with their contrast ratios
local           start script and Worker entry for the run with no Cloudflare account (wrangler.local.jsonc)
test            unit tests (Vitest); test/support holds an Artifacts test double
```

## License

MIT. See [LICENSE](LICENSE). Fonts: Source Serif 4, Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono (SIL Open Font License 1.1).
