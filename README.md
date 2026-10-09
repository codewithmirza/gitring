# Bearing

Bearing lets many coding agents change one repository at the same time.

An agent declares its course (plan, files, symbols) before it writes code. Bearing checks the course against the work of all other agents. If two courses can collide, Bearing sends a correction, not a rejection, and the agent keeps working. When an intent lands, Bearing moves all work in progress onto the new main. Humans do not fix merge conflicts.

Bearing runs on Cloudflare Workers, Artifacts, Durable Objects, Dynamic Workers and Workers AI. Agents connect through MCP or plain git.

## How it works

```
agent ──bearing_declare (plan, files, symbols)──► Bearing ── course check ──► CLEAR
  ▲                                                     │                  or
  └──────── correction in the next tool result ◄────────┘              CORRECTION
agent ──bearing_log / bearing_write / git push──► course check again
agent ──bearing_submit──► checks in a Dynamic Worker ──► landing ladder ──► main + logbook note
main moves ──► Bearing re-plots all work in progress onto the new main
```

| Term | Meaning |
|---|---|
| intent | A goal plus executable checks. |
| course | An agent's plan: steps, files, symbols. Declared before code. |
| traffic | The other agents near your work: their courses, files and logs. |
| course check | A decision: will two pieces of work collide if both continue? |
| correction | An amendment to an agent's brief. Never a rejection. |
| re-plot | After each landing, Bearing moves work in progress onto the new main (3-way, per file). |
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

Bearing needs a Cloudflare account with Workers (paid plan), Artifacts, Workers AI and Dynamic Workers (Worker Loader). Local development uses the Artifacts and Workers AI of your account.

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
BEARING_URL=https://<your-worker> BEARING_KEY=bk_… npm run e2e:scenario   # real AI agents on a new sample project
BEARING_URL=https://<your-worker> BEARING_KEY=bk_… npm run e2e:guard      # re-plot and the stale-write guard
```

## Deploy to Cloudflare

```bash
npx wrangler secret put BEARING_SECRET        # seals sign-in credentials: openssl rand -base64 32
npx wrangler secret put BEARING_SETUP_TOKEN   # opens /setup before an owner signs in: openssl rand -hex 16
npx wrangler secret put BEARING_OWNERS        # github:your-login,google:you@example.com
npm run deploy                                # vite build + wrangler deploy
```

Then open `https://<your-worker>/setup?token=<BEARING_SETUP_TOKEN>`:

1. **GitHub**: one click creates a GitHub App for your Worker (sign-in, issue webhooks). GitHub shows the app before it creates it.
2. **Google**: create an OAuth client of type Web application, with the redirect URI that the page shows, and paste its ID and secret.

Push to deploy with Workers Builds: production branch `main`, build command `npm run build`, deploy command `npx wrangler deploy`, root directory empty.

| Secret | Use |
|---|---|
| `BEARING_SECRET` | Required. Seals the GitHub App and Google credentials (AES-GCM). |
| `BEARING_SETUP_TOKEN` | Opens `/setup` before an owner signs in. |
| `BEARING_OWNERS` | Owners of the deployment: they open `/setup` and act on every project. |
| `BEARING_KEY` | Optional operator key for scripts. It acts as an owner on every project. |
| `GITHUB_WEBHOOK_SECRET` | Optional. A plain repository webhook (without the app): `/hooks/github?project=<id>`. |
| `SLACK_SIGNING_SECRET` | Optional. The Slack slash command: `/hooks/slack?project=<id>`. |

## Accounts and projects

- People sign in with GitHub or Google. Roles per project: **owner** (settings, members), **member** (intents, agents, landings), **viewer** (watch).
- A project starts from a copy of the sample, from an empty repository, or from an import of a public https git repository (GitHub, GitLab, Bitbucket or any host). Main lives in Cloudflare Artifacts.
- Anyone can watch a public project. Only members act on it.
- Personal API keys (Connect → API keys) let MCP clients, hooks and scripts act as you.
- Built-in AI agents have an hourly budget: `AI_AGENTS_PER_USER_HOUR` per person and `AI_AGENTS_PER_HOUR` for the deployment (`wrangler.jsonc`). Over the budget, agents wait and start by themselves.

## Connect agents

Bearing speaks MCP (streamable HTTP) at `/mcp`. Tools: `bearing_intents`, `bearing_declare`, `bearing_log`, `bearing_traffic`, `bearing_read`, `bearing_list`, `bearing_write`, `bearing_check`, `bearing_submit`, `bearing_ack`. Every call needs a personal API key: `Authorization: Bearer bk_…`.

```bash
export BEARING_KEY=bk_…
claude mcp add --transport http bearing https://<your-worker>/mcp --header "Authorization: Bearer $BEARING_KEY"   # Claude Code
```

Codex: `~/.codex/config.toml` → `[mcp_servers.bearing]` with `url = "https://<your-worker>/mcp"` and `bearer_token_env_var = "BEARING_KEY"`.

Cursor: `.cursor/mcp.json` → `{ "mcpServers": { "bearing": { "url": "https://<your-worker>/mcp", "headers": { "Authorization": "Bearer ${env:BEARING_KEY}" } } } }`

Two modes:

- **api mode** (default): the agent reads and writes files through Bearing. Bearing holds the working tree, re-plots it when main moves, and merges writes made from a stale copy.
- **git mode**: `bearing_declare` returns an Artifacts fork remote and a short-lived token. The agent clones, commits and pushes with plain git, then calls `bearing_log` with the head SHA.

Try an outside agent end to end: `BEARING_URL=https://<your-worker> BEARING_KEY=bk_… npm run agent:external` (git mode, on a new private sample project). Add `-- --mode api` for api mode.

**Claude Code hook**: corrections can also arrive in the middle of a task, after each file edit. Add this to `.claude/settings.json` in the agent's repository, and pass `workdir` in `bearing_declare`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command",
  "command": "curl -s -X POST -H 'content-type: application/json' -H \"Authorization: Bearer $BEARING_KEY\" --data-binary @- 'https://<your-worker>/hooks/claude-code?project=<id>'" } ] } ] } }
```

See it work: `BEARING_URL=https://<your-worker> BEARING_KEY=bk_… npm run agent:hook`.

## Hooks: other apps in and out

| In | |
|---|---|
| `POST /hooks/intents` | Any app with a member's API key: `{ project, title, goal, checks?, source?, launch? }` → a new intent |
| `POST /hooks/github-app` | The Bearing GitHub App: an issue labeled `bearing` by a project member → an intent in each project imported from that repository |
| `POST /hooks/github` | A plain repository webhook (`GITHUB_WEBHOOK_SECRET`, `?project=`) → the same |
| `POST /hooks/slack` | Slash command `/bearing Add a dark mode — Readers can switch…` (`SLACK_SIGNING_SECRET`, `?project=`) |
| **Out** | Project webhooks get `landing`, `correction` and `decision` events as JSON or Slack messages |

## Project layout

```
src/core        pure logic: git objects, diffs, 3-way merge, JS symbol analysis, range,
                course-check facts, rules of the road, Clef I/O, corrections, compose, logbook
src/harbor      HarborMaster Durable Object (the coordinator for one project)
src/vessel      Vessel Durable Object (built-in agents on Workers AI)
src/directory   Directory Durable Object: people, sessions, API keys, projects, roles
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
