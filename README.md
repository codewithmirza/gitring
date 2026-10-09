# Gitring

Gitring lets many coding agents change one repository at the same time.

An agent declares its course (plan, files, symbols) before it writes code. Gitring checks the course against the work of all other agents. If two courses can collide, Gitring sends a correction, not a rejection, and the agent keeps working. When an intent lands, Gitring moves all work in progress onto the new main. Humans do not fix merge conflicts.

Gitring runs on Cloudflare Workers, Artifacts, Durable Objects, Dynamic Workers and Workers AI. Agents connect through MCP or plain git.

## How it works

```
agent ──gitring_declare (plan, files, symbols)──► Gitring ── course check ──► CLEAR
  ▲                                                     │                  or
  └──────── correction in the next tool result ◄────────┘              CORRECTION
agent ──gitring_log / gitring_write / git push──► course check again
agent ──gitring_submit──► checks in a Dynamic Worker ──► landing ladder ──► main + logbook note
main moves ──► Gitring re-plots all work in progress onto the new main
```

| Term | Meaning |
|---|---|
| intent | A goal plus executable checks. |
| course | An agent's plan: steps, files, symbols. Declared before code. |
| traffic | The other agents near your work: their courses, files and logs. |
| course check | A decision: will two pieces of work collide if both continue? |
| correction | An amendment to an agent's brief. Never a rejection. |
| re-plot | After each landing, Gitring moves work in progress onto the new main (3-way, per file). |
| landing ladder | Fast-forward → 3-way merge → re-derive from the intent on the new main. |
| logbook | The record of each landing: intent, course, corrections, checks and decisions (git notes and commit trailers). |

When two courses close in, the rules of the road decide who gives way. The first rule that decides wins:

```
R1 landed work has the right of way
R2 work that waits to land stands on
R3 the agent that changes an interface stands on; its users adapt
R5 high priority stands on
R4 the earlier course stands on
R6 the smaller change gives way
```

Symbol analysis and checks support JavaScript and TypeScript. Other languages fall back to file and line ranges.

## Run it

Gitring needs a Cloudflare account with Workers (paid plan), Artifacts, Workers AI, Dynamic Workers (Worker Loader) and Containers. Local development uses the Artifacts and Workers AI of your account.

```bash
npm install                      # npm 11 or later (npx npm@11 install)
npx wrangler login
cp .dev.vars.example .dev.vars   # then fill in the three values
npm run dev                      # http://localhost:5173
```

Tests:

```bash
npm test               # unit tests
npm run typecheck
GITRING_URL=https://<your-worker> GITRING_KEY=gk_… npm run e2e:scenario   # real AI agents on a new sample project
GITRING_URL=https://<your-worker> GITRING_KEY=gk_… npm run e2e:guard      # re-plot and the stale-write guard
```

## Deploy to Cloudflare

```bash
npx wrangler secret put GITRING_SECRET        # seals sign-in credentials: openssl rand -base64 32
npx wrangler secret put GITRING_SETUP_TOKEN   # opens /setup before an owner signs in: openssl rand -hex 16
npx wrangler secret put GITRING_OWNERS        # github:your-login,google:you@example.com
npm run deploy                                # vite build + wrangler deploy
```

Then open `https://<your-worker>/setup?token=<GITRING_SETUP_TOKEN>`:

1. **GitHub**: one click creates a GitHub App for your Worker (sign-in, issue webhooks). GitHub shows the app before it creates it.
2. **Google**: create an OAuth client of type Web application, with the redirect URI that the page shows, and paste its ID and secret.

Push to deploy with Workers Builds: production branch `main`, build command `npm run build`, deploy command `npx wrangler deploy`, root directory empty.

| Secret | Use |
|---|---|
| `GITRING_SECRET` | Required. Seals the GitHub App and Google credentials (AES-GCM). |
| `GITRING_SETUP_TOKEN` | Opens `/setup` before an owner signs in. |
| `GITRING_OWNERS` | Owners of the deployment: they open `/setup` and act on every project. |
| `GITRING_KEY` | Optional operator key for scripts. It acts as an owner on every project. |
| `GITHUB_WEBHOOK_SECRET` | Optional. A plain repository webhook (without the app): `/hooks/github?project=<id>`. |
| `SLACK_SIGNING_SECRET` | Optional. The Slack slash command: `/hooks/slack?project=<id>`. |

## Accounts and projects

- People sign in with GitHub or Google. Roles per project: **owner** (settings, members), **member** (intents, agents, landings), **viewer** (watch).
- A project starts from one of these sources. Main lives in Cloudflare Artifacts for all of them.

  | Source | How |
  |---|---|
  | Import URL | Artifacts imports a public https repository (GitHub, GitLab, Bitbucket or any host), with its history. |
  | git push | Gitring makes an empty repository and shows the owner a push command with a 24-hour token. Use it for private repositories from any host. |
  | Folder | The browser uploads a folder (without `.git`, dependencies and build output; at most 20 MB) as the first commit. |
  | Empty | A README. Agents write the code. |
  | Sample | A copy of the sample bookshop with five intents and checks. |
- Anyone can watch a public project. Only members act on it.
- Personal API keys (Connect → API keys) let MCP clients, hooks and scripts act as you.
- Built-in AI agents have an hourly budget: `AI_AGENTS_PER_USER_HOUR` per person and `AI_AGENTS_PER_HOUR` for the deployment (`wrangler.jsonc`). Over the budget, agents wait and start by themselves.

## Checks

Work lands only when its checks pass: once on the attempt, and again on main plus the attempt before it lands.

| Runner | Where | Used by |
|---|---|---|
| container | A Cloudflare container per attempt (Node.js 24 on Debian). Gitring copies the tree in, runs the install command (default `npm ci` or `npm install`), then the test command (default `npm test`). Exit code 0 passes. | Imported, pushed, uploaded and empty projects |
| worker | A Dynamic Worker runs `tests/*.test.js` with Gitring's small test harness. No dependencies, no network. | The sample |

Owners change the runner, the commands and the time limit in Project settings → Checks. Check containers have no direct Internet access: a Worker entrypoint (`Seawall`) lets requests to package registries (npm, PyPI, Go proxy, Debian) pass and refuses all other hosts.

## Connect agents

Gitring speaks MCP (streamable HTTP) at `/mcp`. Tools: `gitring_intents`, `gitring_declare`, `gitring_log`, `gitring_traffic`, `gitring_read`, `gitring_list`, `gitring_write`, `gitring_check`, `gitring_submit`, `gitring_ack`. Every call needs a personal API key: `Authorization: Bearer gk_…`.

```bash
export GITRING_KEY=gk_…
claude mcp add --transport http gitring https://<your-worker>/mcp --header "Authorization: Bearer $GITRING_KEY"   # Claude Code
```

Codex: `~/.codex/config.toml` → `[mcp_servers.gitring]` with `url = "https://<your-worker>/mcp"` and `bearer_token_env_var = "GITRING_KEY"`.

Cursor: `.cursor/mcp.json` → `{ "mcpServers": { "gitring": { "url": "https://<your-worker>/mcp", "headers": { "Authorization": "Bearer ${env:GITRING_KEY}" } } } }`

Two modes:

- **api mode** (default): the agent reads and writes files through Gitring. Gitring holds the working tree, re-plots it when main moves, and merges writes made from a stale copy.
- **git mode**: `gitring_declare` returns an Artifacts fork remote and a short-lived token. The agent clones, commits and pushes with plain git, then calls `gitring_log` with the head SHA.

Try an outside agent end to end: `GITRING_URL=https://<your-worker> GITRING_KEY=gk_… npm run agent:external` (git mode, on a new private sample project). Add `-- --mode api` for api mode.

**Claude Code hook**: corrections can also arrive in the middle of a task, after each file edit. Add this to `.claude/settings.json` in the agent's repository, and pass `workdir` in `gitring_declare`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command",
  "command": "curl -s -X POST -H 'content-type: application/json' -H \"Authorization: Bearer $GITRING_KEY\" --data-binary @- 'https://<your-worker>/hooks/claude-code?project=<id>'" } ] } ] } }
```

See it work: `GITRING_URL=https://<your-worker> GITRING_KEY=gk_… npm run agent:hook`.

## Hooks: other apps in and out

| In | |
|---|---|
| `POST /hooks/intents` | Any app with a member's API key: `{ project, title, goal, checks?, source?, launch? }` → a new intent |
| `POST /hooks/github-app` | The Gitring GitHub App: an issue labeled `gitring` by a project member → an intent in each project imported from that repository |
| `POST /hooks/github` | A plain repository webhook (`GITHUB_WEBHOOK_SECRET`, `?project=`) → the same |
| `POST /hooks/slack` | Slash command `/gitring Add a dark mode — Readers can switch…` (`SLACK_SIGNING_SECRET`, `?project=`) |
| **Out** | Project webhooks get `landing`, `correction` and `decision` events as JSON or Slack messages |

## Project layout

```
src/core        pure logic: git objects, diffs, 3-way merge, JS symbol analysis, range,
                course-check facts, rules of the road, Clef I/O, corrections, compose, logbook
src/harbor      HarborMaster Durable Object (the coordinator for one project)
src/vessel      Vessel Durable Object (built-in agents on Workers AI)
src/directory   Directory Durable Object: people, sessions, API keys, projects, roles
src/drydock     Drydock Durable Object: check containers; Seawall, their outbound gate
src/sim         Sector Durable Object (scale simulation)
src/platform    Artifacts backend, Workers AI calls, Dynamic Worker checks and previews
src/worker      routes, sign-in, MCP server, hooks
web/src         React UI and its design system
sample          the sample project: a small bookshop on Workers and its intents with checks
scripts         outside agent (MCP, git or api mode), Claude Code hook demo, e2e runs
test            unit tests (Vitest); test/support holds an Artifacts test double
```

## License

MIT. See [LICENSE](LICENSE). Fonts: Source Serif 4, Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono (SIL Open Font License 1.1).
