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

## Run it on your computer

You do not need a Cloudflare account. Offline mode uses a local Artifacts emulator (same git objects and hashes), the rules of the road instead of the Clef model, and scripted agents.

```bash
npm install            # npm 11 or later (npx npm@11 install)
npm run dev:offline
# open http://localhost:5173, then: connection button (top right) → Run scripted
```

Tests:

```bash
npm test               # unit tests
npm run typecheck
npm run e2e:scenario   # five colliding intents, end to end (needs the dev server)
npm run e2e:guard      # re-plot and the stale-write guard (needs the dev server)
```

## Deploy to Cloudflare

Your account needs Workers (paid plan), Artifacts, Workers AI and Dynamic Workers (Worker Loader).

```bash
npx wrangler login
npm run deploy         # vite build + wrangler deploy
```

Optional secrets (`npx wrangler secret put <NAME>`):

| Secret | Use |
|---|---|
| `BEARING_KEY` | Closes MCP, hooks and write APIs. Clients send `Authorization: Bearer <key>`. |
| `GITHUB_WEBHOOK_SECRET` | Verifies GitHub webhook signatures. |
| `SLACK_SIGNING_SECRET` | Verifies Slack slash-command signatures. |

Guardrails for a public deployment: at most 40 built-in AI agents per hour for the whole deployment (after that, new built-in agents run scripted), agent models only from `AGENT_MODELS` in `wrangler.jsonc` and the defaults, and sanitized settings. Open `/?project=<name>` for a separate project.

## Connect agents

Bearing speaks MCP (streamable HTTP) at `/mcp`. Tools: `bearing_intents`, `bearing_declare`, `bearing_log`, `bearing_traffic`, `bearing_read`, `bearing_list`, `bearing_write`, `bearing_check`, `bearing_submit`, `bearing_ack`.

```bash
claude mcp add --transport http bearing https://<your-worker>/mcp     # Claude Code
codex mcp add bearing --url https://<your-worker>/mcp                 # Codex
```

Cursor: `.cursor/mcp.json` → `{ "mcpServers": { "bearing": { "url": "https://<your-worker>/mcp" } } }`

Two modes:

- **api mode** (default): the agent reads and writes files through Bearing. Bearing holds the working tree, re-plots it when main moves, and merges writes made from a stale copy.
- **git mode**: `bearing_declare` returns an Artifacts fork remote and a short-lived token. The agent clones, commits and pushes with plain git, then calls `bearing_log` with the head SHA.

Try an outside agent end to end: `BEARING_URL=https://<your-worker> npm run agent:external` (git mode). Add `-- --mode api` for api mode.

**Claude Code hook**: corrections can also arrive in the middle of a task, after each file edit. Add this to `.claude/settings.json` in the agent's repository, and pass `workdir` in `bearing_declare`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command",
  "command": "curl -s -X POST -H 'content-type: application/json' --data-binary @- 'https://<your-worker>/hooks/claude-code?project=demo'" } ] } ] } }
```

See it work: `BEARING_URL=https://<your-worker> npm run agent:hook`.

## Hooks: other apps in and out

| In | |
|---|---|
| `POST /hooks/intents` | Any app: `{ title, goal, checks?, source?, launch? }` → a new intent |
| `POST /hooks/github` | Issues opened or labeled `bearing` → intents |
| `POST /hooks/slack` | Slash command `/bearing Add a dark mode — Readers can switch…` |
| **Out** | Project webhooks get `landing`, `correction` and `decision` events as JSON or Slack messages |

## Project layout

```
src/core        pure logic: git objects, diffs, 3-way merge, JS symbol analysis, range,
                course-check facts, rules of the road, Clef I/O, corrections, compose, logbook
src/harbor      HarborMaster Durable Object (the coordinator for one project)
src/vessel      Vessel Durable Object (built-in agents: Workers AI or scripted)
src/sim         Sector Durable Object (scale simulation)
src/platform    Artifacts backend + emulator, Workers AI calls, Dynamic Worker checks and previews
src/worker      routes, MCP server, hooks
web/src         React UI and its design system
demo            Saltmarsh Books: seed app, intents with checks, reference solutions
scripts         outside agent (MCP, git or api mode), Claude Code hook demo, e2e runs
test            unit tests (Vitest), worker tests, UI screenshot tools
```

## License

MIT. See [LICENSE](LICENSE). Fonts: Source Serif 4, Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono (SIL Open Font License 1.1).
