# gitring

gitring is a home for code that many agents change at the same time.

Each agent sends its plan before it writes code. The plan names the steps, the files, the functions it changes, and the functions it uses. gitring compares the plan with the other active plans, and with the changes that merged after the work copy began. When two plans collide, gitring sends a change request to one of them. It does not reject the agent, and the agent continues. Work merges into main only when the tests pass, one merge at a time in each project. A person says yes first when the project asks. Each merge keeps a record of why.

Source control made for people breaks at the scale of agents. Anthropic wrote so on 13 October 2026, in [its post about source control](https://www.anthropic.com/engineering/redesigning-source-control). Its merges had gone from 2,500 to more than 30,000 a day. gitring takes the lessons. Every question about the code is an API, so agents need no clone. An agent waits for news with one call instead of a poll loop. One identity holds one work copy. The tests and named rules are the neutral judge of a dispute. A person decides what the rules cannot.

gitring runs on Cloudflare Workers, Durable Objects, Artifacts, Workers AI, Dynamic Workers and Containers. Agents connect through MCP or plain git. People use the web app, its inbox, or the `gitring` command line.

## How it works

```
1. A task exists. An agent or a person writes it, or an app sends it (API key, Slack, a GitHub issue).
2. An agent sends its plan ............................... gitring_declare
3. Conflict check. gitring measures the range to every other active plan:
      0 same lines or same function · 1 one side changes what the other uses · 2 same file
      3 one import apart · 4 two imports apart · 5 no relation
   It judges at most 20 plans within one import (range 0 to 3), and every plan that comes closer than before.
   ├── range 4 or 5 ... clear, no AI call (a plan that comes closer is judged)
   ├── range 3 ........ fixed rules decide, no AI call, when the model cannot change the answer (the note below)
   └── range 0 to 2 ... a small Workers AI model decides; an unclear answer goes to a larger model;
                        if the AI fails, fixed rules decide; if the models are not sure, a person decides
   Result: clear, or a change request to ONE agent. The other agent continues.
4. The agent works. Each write, report, push, check or wait runs step 3 again.
5. The agent runs the tests (gitring_check) and asks for a merge (gitring_submit).
   A person says yes first when the project asks, or when the work looks risky. The work waits. The agent does not stop.
6. Merge, one at a time in each project:
   fast-forward → 3-way merge → tests on main + work → commit to main with a git note (the record of why)
   If the text conflicts or the combined tests fail, the work goes back to its agent (redo policy).
7. gitring tells the agents near the changed files that main moved. gitring_wait brings the news.
```

The note on range 3: gitring skips the model only when the model cannot change the answer. A pair at range 3 or more cannot reach a change request under the default thresholds. So the fixed rules decide when four things hold. Every judged pair is at range 3 or more. No pair comes closer than at the last check. No changed function is used by another plan. The two tasks share few words. In every other case gitring calls the model.

| Term | What it is |
|---|---|
| task | A change that a person or an agent wants: a goal, and test files if you add them. |
| plan | The steps, files and functions that an agent will change, the functions that it uses, and its approach. |
| work copy | A git copy (fork) of main for one agent on one task. |
| conflict check | gitring compares one plan with at most 20 plans within one import, and with every plan that comes closer. It also compares the plan with changes that merged into main after the work copy began. |
| change request | A message from gitring to one agent: change your plan or your code. Never a rejection. |
| rebase | Work in progress gets the new main after a merge. In api mode, gitring does this (3-way, per file). In git mode, the agent does it with `git pull`. |
| approval | A merge that waits for a person. The person says yes (gitring merges) or sends the work back (the agent changes it). |
| question | A choice for a person: which of two plans adapts, or what happens to work that did not merge. |
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

A plan may name the functions that it uses but does not change (`uses` in `gitring_declare`). Then two plans can be at range 1 before any code exists: one changes a function, the other uses it. gitring keeps the range of every pair. A pair that comes closer than at the last check is judged again, at any range.

An agent confirms a change request with `gitring_ack`, and gitring checks the code. The request stays open while the code still edits its lines, or calls the old form of a function. A request that the agent never answered closes at the merge, and the record says so.

A merge carries every change of the work: text, binary files, file modes, symlinks, and vendored folders of main. A few changes stay out: a file over 10 MB, a new folder of tool output, and a submodule. Files without text past 16 MB in one merge stay out too. gitring tells the agent about each of them.

Symbol analysis covers JavaScript and TypeScript, with JSX and TSX. It knows class members (`Cart.add`), `require()` calls, and the path aliases of `tsconfig.json` or `jsconfig.json`. Other languages use files and line ranges.

## Start

### An agent starts a project

An agent creates a project with one call, `gitring_create_project`. It starts from a template, empty, from files that the agent sends, or from any public git URL. gitring makes the git repository and guesses the install and test commands. The call can open the first task and start built-in agents on it. The answer has the project id, the app link, a `git clone` command (6-hour read token) and the next steps. `gitring_templates` lists the templates. `gitring_clone` gives the clone command of a project later.

### A person starts a project

New project in the app is one page. The field on top is "Describe what you want to build". It makes a project from the best template, opens the first task, and starts one built-in agent. Below it come the sources, in this order:

| Source | How |
|---|---|
| Template | Starter code with tests: a library, a Worker API or a static site (the table below). |
| Empty | A README, a `.gitignore` and an `AGENTS.md` that tells agents to use gitring. Agents write the code. |
| Upload a folder | The browser uploads a folder (without `.git`, dependencies and build output; at most 20 MB) as the first commit. |
| Push with git | gitring makes an empty repository and shows a push command with a 24-hour token. Use it for large or private repositories on any host. |
| Import from a git URL | Artifacts imports a public https repository (GitLab, Codeberg, Bitbucket, GitHub or any host), with its history. |
| Your GitHub repositories | The last group, shown when GitHub is connected. Public: Artifacts imports it with its history. Private: gitring reads the branch tip through the GitHub App (one commit, at most 25 MB). Code of a private repository only goes into a private project. GitHub sync starts off. |

For every source, gitring guesses the name, the branch, and the install and test commands. It reads lockfiles and manifests (Node, Python, Go, Rust, Ruby, Java, Deno, Make). A small model reads the README only when the rules find no test command.

| Template | What it holds |
|---|---|
| `empty` | A README, a `.gitignore` and an `AGENTS.md`. Agents write the first files and tests. |
| `js-library` | A small library in plain ES modules, with tests that run in the gitring test runner. |
| `worker-api` | A Cloudflare Worker that answers JSON. The routes are a pure module with tests. |
| `static-site` | An `index.html` page and a small JavaScript module with tests. |

Every template has an `AGENTS.md` that tells agents to send a plan to gitring before they write code.

### Accounts and roles

- People create an account with a passkey: a fingerprint, a face, a PIN or a security key. The passkey stays on their own device, and gitring keeps only the public key. No outside account is needed. Google and GitHub are optional sign-ins that a deployment can add. Account adds passkeys and sign-ins, lists API keys and connected apps (MCP clients), and signs out everywhere.
- Roles per project: **owner** (settings, members), **member** (tasks, agents, merges), **viewer** (watch). Anyone can watch a public project; only members act on it.
- A work copy belongs to the person who sent its agent. Only that person or an owner can change it, and only that person's agent gets its change requests.
- Owners of a deployment are named in `GITRING_OWNERS`: `user:<account id>` (the id is on the Account page), `google:<email>` or `github:<login>`.
- Built-in agents run on GLM 5.3 Flash and GLM 5.3 (Workers AI, a context of 1,048,576 tokens). They have an hourly budget: `AI_AGENTS_PER_USER_HOUR` for each person and `AI_AGENTS_PER_HOUR` for the deployment (`wrangler.jsonc`). Over the budget, agents wait and start by themselves.

### Run your own gitring

To run gitring on Cloudflare, you need Workers (paid plan), Artifacts, Workers AI, Dynamic Workers (Worker Loader) and Containers. Local development uses the Artifacts and Workers AI of your account. To try gitring with no Cloudflare account, see [Try it without a paid account](#try-it-without-a-paid-account).

```bash
npm install                      # npm 11 or later (npx npm@11 install)
npx wrangler login
cp .dev.vars.example .dev.vars   # then fill in the values
npm run dev                      # http://localhost:5173
```

The local server keeps its own storage (`.wrangler/state`). Passkeys need no setup: create an account with one on the sign-in page. The optional sign-ins need a one-time setup on `http://localhost:5173/setup?token=<GITRING_SETUP_TOKEN from .dev.vars>`:

- **GitHub**: the button makes a second app, `git-ring localhost`, with localhost callback URLs and no webhook (GitHub cannot reach your computer).
- **Google**: add the origin `http://localhost:5173` and the redirect URI `http://localhost:5173/auth/google/callback` to your OAuth client. Paste its ID and secret.

MCP clients and your own scripts do not need sign-in: send the `GITRING_KEY` from `.dev.vars` as `Authorization: Bearer <key>` to `http://localhost:5173`.

Tests:

```bash
npm test               # unit tests and end-to-end tests with 8 to 60 agents (Vitest)
npm run typecheck
npm run bench          # the coordination logic on many simulated plans: no network, no Artifacts, no AI
npm run load -- --help # a load test for a deployed gitring: it costs money, so it asks for --yes
npm run meet -- --help # three scripted agents meet on a small project: you read the real answers
```

The end-to-end tests run the real coordinator on a test version of Artifacts. They do not prove how the real service behaves. `npm run load` does that on a deployed copy.

`npm run load` runs many agents at the same time through the real MCP door. It never makes a project: give it one with `--project`. It reads the address from `GITRING_URL` and the key from `GITRING_KEY`, and it never prints the key. The options:

| Option | What it does |
|---|---|
| `--agents N` | Agents that work at the same time (default 10, at most 500). |
| `--tasks M` | Tasks for each agent (default 2, at most 100). |
| `--shared P` | Of 100 tasks, how many also add a line to one shared file, so that plans meet (default 30). `0` gives tasks on separate files. |
| `--rounds R` | Tries for one task before the agent gives up (default 4). |
| `--wait S` | Seconds that an agent waits for the merge of one task (default 120, at most 3600). A project merges one change at a time, so use more seconds for many agents. |
| `--ignore-requests` | The agents confirm change requests but do not wait for the agent that continues. Without it, they wait. |
| `--seed N` | The same seed gives the same plan of the run. |
| `--yes` | Needed to start. The run costs money (Artifacts operations, Workers AI, test containers). |

`GITRING_LOAD_TRACE=1` prints the first line of each answer of each agent, to find out why a task did not merge.

#### Try it without a paid account

You can run gitring on your computer. You do not need a Cloudflare account for this.

```bash
npm install
npm run dev:local
```

The command needs `git`. It does three things:

1. It builds the app.
2. It starts a test version of Artifacts. The test version keeps real git repositories in `tmp/local`.
3. It starts `wrangler dev` with `wrangler.local.jsonc`. Every binding runs on your computer.

The command prints a key. Send it as `Authorization: Bearer <key>` to `/api` and `/mcp` at the address that wrangler shows. Make a project like this:

```bash
curl -X POST http://localhost:8787/api/projects \
  -H "Authorization: Bearer <key>" -H "content-type: application/json" \
  -d '{"name":"demo","source":{"kind":"template","template":"js-library"}}'
```

Then connect an agent. For Claude Code, run this command with the key from above:

```bash
claude mcp add --transport http gitring http://localhost:8787/mcp --header "Authorization: Bearer <key>"
```

[Connect agents](#connect-agents) shows other clients. Give the agent the project id from the answer to the `curl` command. An agent can also make its own project with `gitring_create_project`.

To read what the coordination says before you connect a real agent, run three scripted agents. They meet on a small shop project (the files of `examples/shop`). The script prints each real answer of the MCP tools:

```bash
GITRING_URL=http://localhost:8787 GITRING_KEY=<key> npm run meet -- --approval --wait 0
```

Agent A and Agent B change the same function. Agent B gets a change request and applies it. Both changes merge. Agent C changes the parameters of two functions, and a person must say yes. The script makes one private project and archives it at the end (`--keep` keeps it). The agents are scripts: the run shows the answers of gitring, not the behavior of a model. It also works on a deployed gitring, with a personal API key (Account → API keys).

To try real agents on a deployed gitring, make a project from a template. Or upload the folder `examples/shop` (New project → Upload a folder). Give two agents a task that changes `formatPrice`.

To measure the real Cloudflare services without a risk for your live deployment, run a second copy. Copy `wrangler.jsonc` to `wrangler.loadtest.jsonc`. In the copy, change `name`, the `artifacts` namespace and `ARTIFACTS_NAMESPACE` (a new name makes a new namespace). Also change the `namespace_id` of each rate limit: all Workers of an account share these ids. Delete the `containers` entry. Deploy with `wrangler deploy --config wrangler.loadtest.jsonc`. Set the secrets `GITRING_SECRET` and `GITRING_KEY` with `wrangler secret put <name> --config wrangler.loadtest.jsonc`. Make a project with the settings `{"checks":{"runner":"worker"}}` (this runner has no test container and no hourly budget). Put the files of `examples/shop` in it, and run `npm run load` against it with `GITRING_KEY` as the key. When you finish, delete the Worker (`wrangler delete --config wrangler.loadtest.jsonc`) and the repositories of the namespace. The Cloudflare API lists them 50 at a time: `GET /accounts/<id>/artifacts/namespaces/<name>/repos`, then `cursor`.

The local run has these limits:

- **No Workers AI**: fixed rules make the conflict check. The built-in agents need Workers AI, so they do not run.
- **Tests**: the `worker` runner runs `tests/*.test.js` files. There are no test containers. Work with no test merges only when the project allows it (see [Tests of the work](#tests-of-the-work)).
- **Import**: it cannot import a repository. Start from a template, empty, with an upload or with `git push`.
- **Web page**: create an account with a passkey. Passkeys need a host name, so open `localhost`, not `127.0.0.1`. GitHub and Google sign-in are not set up in this run.
- **Data**: each start deletes the data of the run before.
- **Artifacts**: the test version is not Cloudflare Artifacts, and it can differ in details. Deploy to Cloudflare to test the real service.

#### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/codewithmirza/gitring)

The button copies this repository to your GitHub or GitLab account, then builds and deploys it with Workers Builds. The new Worker needs the secrets in the table below. The [Cloudflare page for the button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) does not list Artifacts, Worker Loader or Containers as resources that it sets up.

To deploy from your own computer instead, run these commands:

```bash
npx wrangler secret put GITRING_SECRET        # seals sign-in credentials and signs chat questions: openssl rand -base64 32
npx wrangler secret put GITRING_SETUP_TOKEN   # opens /setup before an owner signs in: openssl rand -hex 16
npx wrangler secret put GITRING_OWNERS        # user:u_0123456789,google:you@example.com
npm run deploy                                # vite build + wrangler deploy
```

After you deploy, open `https://<your-worker>/setup?token=<GITRING_SETUP_TOKEN>`. Passkeys are ready with no setup. The page adds the optional sign-ins:

1. **GitHub**: one click creates a GitHub App for your Worker. It gives sign-in, repository lists and imports, issue and push webhooks, and GitHub sync. GitHub shows the app before it creates it.
2. **Google**: create an OAuth client of type Web application with the redirect URI that the page shows. Paste its ID and secret.

Push to deploy with Workers Builds: production branch `main`, build command `npm run build`, deploy command `npx wrangler deploy`, root directory empty.

| Secret | Use |
|---|---|
| `GITRING_SECRET` | Required. Seals the GitHub App and Google credentials (AES-GCM) and signs the merge questions in chat. |
| `GITRING_SETUP_TOKEN` | Opens `/setup` before an owner signs in. |
| `GITRING_OWNERS` | Owners of the deployment: they open `/setup` and act on every project. `user:<id>`, `google:<email>` or `github:<login>`. |
| `ALLOWLIST_EMAILS` | Optional. Turns on the waitlist gate. The emails (separated by commas) of the people who may use gitring. See [Waitlist gate](#waitlist-gate). |
| `WAITLIST_ENABLED` | Optional variable. `true` turns the gate on, also with no list. `false` turns it off. |
| `GITRING_KEY` | Optional operator key for scripts. It acts as an owner on every project. |
| `GITRING_CONTACT` | Optional contact address on the privacy and terms pages. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional. Push notifications for the inbox. Make them with `npx web-push generate-vapid-keys`. Without them, the app hides the switch. |
| `GITHUB_WEBHOOK_SECRET` | Optional. A plain repository webhook (without the app). The Connect page of a project shows its URL (`/hooks/github?project=<id>&key=…`). |
| `SLACK_SIGNING_SECRET` | Optional. The Slack slash command. The Connect page of a project shows its command URL (`/hooks/slack?project=<id>&key=…`). |

### Waitlist gate

A public gitring can keep people on a waitlist while it is closed. With the gate on, a person may sign in with Google or GitHub. If the person is not on the list, they see two pages: the interest page and its confirmation. The interest page asks which pack the person would use. It takes no payment and no card. For that person, the API, the live views, the previews, the hooks and MCP answer 403. The code is `waitlist`. A key or a session that the person made before also gets 403.

The gate is off by default. A self-hosted gitring and the local run have no gate. Turn it on in production:

```bash
npx wrangler secret put ALLOWLIST_EMAILS      # you@example.com,teammate@example.com
npx wrangler secret put GITRING_OWNERS        # google:you@example.com
npm run deploy
```

- A person gets in when a verified email of their sign-in is in `ALLOWLIST_EMAILS`. Owners (`GITRING_OWNERS`) get in too. An owner can let more people in.
- An owner opens `/admin/waitlist`. It shows who chose which pack and the planned monthly value of all choices. It has a CSV file and a form to let a person in. The same data is at `GET /api/admin/waitlist` (add `?format=csv` for the file) and `/api/admin/allowed`.
- With the gate on, a new account starts with Google or GitHub. A person who has an account can still sign in with a passkey.
- `GET /api/projects/<id>/usage` shows the counters of a project for this month: merges, container test runs and built-in agent tokens. The counters charge nobody. gitring has no payment code.
- The planned packs and the reasons for their prices are in [docs/PRICING.md](docs/PRICING.md). The cards on the interest page read `src/core/plans.ts`.

## Connect agents

gitring speaks MCP (streamable HTTP) at `https://<your-worker>/mcp`. Add it as a connector; the client signs you in with OAuth, and you allow it once:

| Client | How |
|---|---|
| Claude (claude.ai, desktop, mobile) | Settings → Connectors → Add custom connector → paste the URL → Connect → Allow. |
| Claude Code | `claude mcp add --transport http --scope user gitring https://<your-worker>/mcp`, then `/mcp` to sign in. The [plugin](#claude-code-plugin) adds a skill and a hook. |
| Cursor | The "Add to Cursor" button on the Connect page, or `.cursor/mcp.json` → `{ "mcpServers": { "gitring": { "url": "https://<your-worker>/mcp" } } }` |
| Codex | `codex mcp add gitring --url https://<your-worker>/mcp`, then `codex mcp login gitring`. Or put `[mcp_servers.gitring]` with `url = "https://<your-worker>/mcp"` in `~/.codex/config.toml`. |
| VS Code (Copilot agent mode) | Command Palette → MCP: Add Server → HTTP → the URL. Or `.vscode/mcp.json` → `{ "servers": { "gitring": { "type": "http", "url": "https://<your-worker>/mcp" } } }`. If VS Code does not start the sign-in, send a personal API key in `headers`. |
| Gemini CLI | `gemini mcp add --transport http gitring https://<your-worker>/mcp`, then `/mcp auth gitring`. Sign-in needs a browser on the same computer. Without one, add `--header "Authorization: Bearer $GITRING_KEY"`. |

OAuth 2.1 details:

- Protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` (and one for each address below). Server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`.
- Dynamic client registration (RFC 7591) and client ID metadata documents. Authorization code with PKCE (S256 only). The device authorization grant (RFC 8628) for the [gitring command line](#the-command-line-for-people).
- Tokens are bound to the address that the client names in the `resource` parameter (RFC 8707). A token for `<origin>/mcp` does not work at `<origin>/mcp/github`, and the other way round. A client that sends no `resource` gets a token for `/mcp` only.
- Access tokens last one hour. Refresh tokens last 30 days and rotate at each use. Each sign-in of an app is one token family. A refresh token that comes back after its rotation ends that family. Revocation (RFC 7009). Only hashes of codes and tokens are stored.
- Account → Connected apps shows each app with its last use; Revoke ends its tokens.

Scripts and hooks send a personal API key instead (Account → API keys): `Authorization: Bearer gk_…`.

```bash
claude mcp add --transport http gitring https://<your-worker>/mcp --header "Authorization: Bearer $GITRING_KEY"   # Claude Code with a key
```

### The tools

| Tool | What it does |
|---|---|
| `gitring_intents` | Lists your projects, or the open tasks of one project. |
| `gitring_declare` | Starts work on a task. Send the plan (steps, files, functions, `uses`), get a work copy and the first conflict check. |
| `gitring_traffic` | Shows the other active work near your plan, and the tasks that merged after your work copy started. |
| `gitring_read`, `gitring_list` | Read files of your work copy (api mode). New change requests come after the file, in a second part. |
| `gitring_write` | Writes whole files into your work copy (api mode). Runs a conflict check. |
| `gitring_log` | Reports progress. In git mode, reports a push at once. Runs a conflict check. |
| `gitring_ack` | Confirms that you applied a change request. gitring checks the code. Code that still edits the lines of the request, or calls an old form of a function, keeps it open. |
| `gitring_check` | Runs the tests of your work copy. In git mode, gitring tests your latest push. |
| `gitring_submit` | Asks for a merge. gitring tests again. Then it merges, or a person says yes first when the project asks (see Approvals). |
| `gitring_status` | Shows where a work copy is: with a person, sent back, in the merge queue or merged. It changes nothing. |
| `gitring_update` | Brings the new main into your work copy. In git mode: a read-only remote and token for main, and the git command to merge it. |
| `gitring_wait` | Waits for news about your work copy. News is a change request, a move of main, the answer of a person, or a new status. It answers when the news arrives, or after 25 seconds (50 at most). Use it instead of a sleep. |
| `gitring_create_project` | Creates a project that you own: from a template, empty, from files, or from a public git URL. It can open the first task and start built-in agents. |
| `gitring_templates` | Lists the starter templates. |
| `gitring_clone` | Gives a `git clone` command with a 6-hour read token. The token goes in a header, not in the URL. |
| `gitring_why` | Names the merge that last changed a line, with its record: task, plan, change requests, tests, decision. |
| `gitring_history` | Lists the changes of a file, a folder or all of main, the newest first. |
| `gitring_search` | Finds a text in the files of main. No clone is needed. |
| `gitring_diff` | Compares two versions: main, a commit or a work copy. |

Every answer about a work copy carries its new change requests. An answer that starts with `GITRING CHANGE REQUEST` lists what to change. `gitring_read` and `gitring_list` keep the file text clean in the first part and put the requests in a second part. An agent that waits for a merge, a person or other agents calls `gitring_wait` instead of a sleep. The call answers as soon as something new reaches the work copy, or after the time is over.

A work copy belongs to the person who sent its agent. The tools that change a work copy work for that person, an owner, or the operator key. These are write, log, ack, check, submit, update and wait. Members can read every work copy, but only that person gets its change requests. One agent cannot take the work of another.

Two modes:

- **api mode** (default): the agent reads and writes files through gitring. gitring holds the tree of the work and merges writes made from an old copy. When main moves, gitring rebases the work copy. If the two changes overlap in a file, the file goes back to the version on main. The agent makes its change again.
- **git mode**: `gitring_declare` returns a remote for the work copy and a token (6 hours). The agent clones, commits and pushes with plain git. gitring reads the latest push at `gitring_check` and `gitring_submit`; `gitring_log` with the head SHA gets a conflict check at once. gitring does not rebase the work copy. When main moves, the agent merges it into its work and fixes the conflicts itself. `gitring_update` gives the remote and the git command for that. Then gitring moves the base of the work copy to that main. If the agent does not merge main, gitring still merges text that does not overlap. It gives work with a text conflict back to the agent. The merge carries every change of the push: binary files, file modes and symlinks too.

**Claude Code hook**: change requests can also arrive in the middle of a task, after each file edit. Add this to `.claude/settings.json` in the agent's repository, and give your repository folder as `workdir` in `gitring_declare`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command",
  "command": "curl -s -X POST -H 'content-type: application/json' -H \"Authorization: Bearer $GITRING_KEY\" --data-binary @- 'https://<your-worker>/hooks/claude/<project-id>'" } ] } ] } }
```

### Three addresses

| Address | Tools |
|---|---|
| `/mcp` | The 20 gitring tools (the table above). |
| `/mcp/readonly` | Only the gitring tools that read, with the history tools. The OAuth scope `mcp:read` limits a token to these tools. |
| `/mcp/github` | A compatibility address for agents with a prompt or a habit that names the GitHub tools (see below). |

`/mcp/github` has 20 tools with the names and the argument names of the GitHub MCP server. Among them: `get_file_contents`, `search_code`, `push_files`, `create_pull_request` and `list_issues`. It is the same project, the same conflict check, the same tests and the same approvals. `repo` is a gitring project id (`get_me` lists them). A branch other than `main` is your own work copy, and no tool writes to `main`. `create_pull_request` asks for a merge, and `merge_pull_request` waits for it. `issue_write` makes a task. The GitHub server has more tools (Actions, releases, security alerts and others), and gitring has none of them. New setups use `/mcp`. A sign-in is good for one address only. The tools are in `src/worker/mcp-github.ts`.

### Claude Code plugin

The plugin is in `plugins/gitring`, and `.claude-plugin/marketplace.json` lists it. It holds the connection to `/mcp`, a skill for the work loop, and the hook above. The skill says: send a plan, apply change requests, test, ask for the merge. It asks for the address of your gitring. The hook also needs a project id and a personal API key.

```
/plugin marketplace add codewithmirza/gitring
/plugin install gitring@gitring
```

### Make gitring the default in a repository

Put the address in the files of the repository, so that a new clone connects with no setup:

- `.mcp.json` for Claude Code: `{ "mcpServers": { "gitring": { "type": "http", "url": "https://<your-worker>/mcp" } } }`. Claude Code asks for approval before it uses a server from this file.
- `.cursor/mcp.json` for Cursor and `.vscode/mcp.json` for VS Code: the forms are in the table above.
- `AGENTS.md`, which many agents read. The templates of gitring hold one. A block like this one tells an agent what to do:

```md
## Changing code in this repository
Many agents work here at the same time. Use the gitring tools when they are in your tool list.
Send a plan with `gitring_declare` before you edit, and apply every change request that comes back.
Run `gitring_check`, then call `gitring_submit`. Do not open a pull request for work that gitring merges.
```

## People

### Where you answer merge questions

An agent that you send can ask for a merge that needs your yes. You choose where you answer, in Account → "Where do you answer merge questions?":

| Choice | What happens |
|---|---|
| In the agent's chat | The agent shows you a form when its client can (MCP revision 2026-07-28 with the `elicitation` capability). Else the agent gets a link to the app. |
| In the gitring app | gitring never asks in the chat, and an answer from the chat does not count. The agent gets the link and waits with `gitring_wait`. No agent can answer for you, also one that holds your key. |
| In both (the default) | The chat when the client can show a form. The app always. |

In every choice the question also shows in the app. It shows on a card at the bottom of every page of the project, on `/approve/<work copy>?project=<project>`, and in the inbox. The person who sent the agent answers. Owners can always answer. An owner can limit the answers to owners.

### The inbox

The page `/inbox` lists what waits for you in all your projects. That is merge questions, merges that stopped, questions for a person, and tasks that wait for a person. Each item has the project, the task, why it waits, and its buttons. You answer in place. A count shows in the top bar on every page. The app is installable on a phone. With the push keys set (see Deploy), Account → Push notifications sends a notification when an item appears. The notification carries no content: the app reads the inbox when you tap it. `GET /api/me/inbox` gives the same items to the [command line](#the-command-line-for-people).

### Questions that a person decides

| Question | When | The answers |
|---|---|---|
| Which plan adapts | The conflict check is not sure which of two plans must adapt. Both agents continue until you answer. | "A continues, B adapts", "B continues, A adapts", or "No conflict: both continue". The side that adapts gets a change request with the label "a person decided". |
| What happens to work that did not merge | Work came back to its agent 3 times, or the agent did not answer in time. No agent may try again. | "Redo it on the new main" (a built-in agent does the task again) or "Pause the task". |

A new question for the same pair updates the open one. A question closes without an answer when its work copies close. Projects can send a `question` event to a webhook when a question starts and when it is answered.

### Ask the agent to change a line

Open the diff of a work copy in the Code view or on the task page. Select a line or a range and write what you want. The agent gets a change request with the lines and your words in the answer of its next call. It applies the request and confirms it like any other. Only a person in the app can send one: `POST /api/projects/:p/attempts/:id/requests` needs a browser session.

### The command line for people

`cli/gitring.mjs` is a small command line for people. It needs Node 20 or later and no other package. In a clone of this repository, run `npm link` once. Then the command `gitring` works in every folder.

| Command | What it does |
|---|---|
| `gitring login --server https://<your-worker>` | Signs you in with a code. Open the page that it shows, sign in to gitring, check the code and allow it. |
| `gitring logout`, `gitring whoami` | Ends the sign-in on this computer. Shows your name and your server. |
| `gitring projects` | Lists your projects. |
| `gitring new <name> [--template t] [--describe "…"] [--public]` | Makes a project. With `--describe`, gitring also makes the first task, and a built-in agent starts on it. |
| `gitring clone <project> [folder]` | Clones a project with git. git gets the read token in the environment. The token does not go into the folder. |
| `gitring tasks <project>` | Lists the open tasks of a project. |
| `gitring task <project> "title" "goal"` | Makes a task. Agents can take it. |
| `gitring inbox` | Lists what waits for you in all your projects. |
| `gitring yes <item>`, `gitring back <item> "note"` | Answers a merge question from the inbox. The note tells the agent what to change. |
| `gitring watch <project>` | Shows the log of a project live. |

The sign-in is the OAuth device authorization grant (RFC 8628). The command line calls `POST /oauth/device_authorization`. Then it asks `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` until you answer. The page `/device` works only after you sign in. It shows the code and the address that started the sign-in. It tells you to allow only a sign-in that you started. Your answer is bound to the browser that showed the page.

The token is for `/mcp`. It also works for the REST routes of the commands above. It does not work for other routes, for example keys, settings, members or deletion. The command line keeps it in `credentials.json` in your config folder, and only you can read the file (mode 0600). Account → Connected apps shows the command line, and Revoke ends its tokens and its live logs. Scripts set `GITRING_URL` and `GITRING_TOKEN` (a personal API key) instead of a sign-in.

Answers from the command line count as your answers only when you answer merge questions outside the gitring app. You choose this in Account → Merge questions: "In the agent's chat" or "In both". With "In the gitring app", the command line shows the link of the question in the app. An older gitring server does not have all commands. Then the command line says: "This gitring server is too old for this command."

## History

### The record of why

Each merge commit on main carries a git note. The note holds the task, the plan, the test runs, and the decision of a person. It holds each change request with its true status: applied, or closed at the merge. Commit trailers name the task and the work copy. The web app shows the record on the task and in the Code view ("Why line N?"). A merge never lands without its record. When a push of the branch fails after the note, gitring removes the note again.

### Ask the history

Agents and people ask the history through the API. No clone is needed.

| Question | MCP tool | REST |
|---|---|---|
| Why is this line here? | `gitring_why {project, path, line?, ref?}` | `GET /api/projects/:p/why` |
| What changed this file or folder? | `gitring_history {project, path?, limit?}` | `GET /api/projects/:p/history` |
| Where is this text in main? | `gitring_search {project, query, path?, limit?}` | `GET /api/projects/:p/search` |
| What differs between two versions? | `gitring_diff {project, from, to, path?}` | `GET /api/projects/:p/compare` |

The project object keeps derived data in its SQLite. That is the changes of main in order, path history, line blame, and a text index of main (FTS5). gitring computes the data of a change from the data of its parent. So the cost follows the size of the change, not the size of the repository. Small merges are computed at the merge. Big changes, moves of main without a merge, and old merges are computed at the first question. Without FTS5, search scans the text.

### Replay

`/replay?project=<id>` replays the real history of a project on the map. Tasks appear, and plans draw their course. Each conflict check shows its candidates, the range, the facts, the rule and the model that decided, and the verdict. A change request flies to its agent. Tests run, the merge queue moves one at a time, and each commit shows its record. One plain caption explains each event. Controls: play, pause, speed (1× to 120×), scrub, step. `?autoplay=1&speed=<n>&kiosk=1` hides the app chrome, to record a video. The data comes from `GET /api/projects/:p/events`, which reads the whole history of the project.

## The steward

Each project has a steward. It is a watch on the project while agents work. Every few minutes it counts facts in the records of the project: test runs, change requests and the merge queue. When it finds a real problem, it puts one plain note in the inbox. The note has one answer: "Seen". The steward looks for five problems:

- A work copy runs its tests again and again, and the same test fails each time.
- Change requests go back and forth between the same two agents.
- Many change requests name the same lines of one file.
- A test of one work copy passes and fails by turns.
- The merge queue has work, and no merge happened for a long time.

The counts decide alone. A model (GLM 5.3 Flash) only words each problem as one plain sentence. When the model fails, a fixed sentence stands. The steward is off by default. A project switch turns it on.

## Tests, approvals and redo

### Tests of the work

gitring merges work only when the tests pass. They run once on the work copy, and again on main plus the work before the merge.

| Runner | Where | Used by |
|---|---|---|
| container | A Cloudflare container per work copy (Node.js 24 on Debian). gitring copies the tree of the work into it: text and binary files, file modes and symlinks (see Limits). It runs the install command (default `npm ci` or `npm install`), then the test command (default `npm test`). Exit code 0 passes. | Projects with dependencies (the default for code that gitring imports) |
| worker | A Dynamic Worker runs `tests/*.test.js` with gitring's small test harness. No dependencies, no network. | Templates, and small JavaScript projects without dependencies |

If the worker runner finds no test, gitring does not call the work verified. A person decides. An owner can allow work with no tests in the project settings.

Owners change the runner, the commands and the time limit in Settings → Tests. Test containers have no direct Internet access. A Worker entrypoint lets requests to package registries pass and refuses all other hosts. The registries: npm, PyPI, Go proxy, Debian, crates.io, RubyGems, Maven, Gradle and JSR.

### Approvals: a person says yes

gitring can ask a person before it merges the work of an agent. The agent never answers that question. Only a person can.

An owner chooses when gitring asks, in Settings → Merging:

| Choice | gitring asks when |
|---|---|
| Only when the tests pass | No test ran, or work copies compete on one task. In all other cases gitring merges when the tests pass. |
| When a change looks risky (the default) | Also when the parameters of a function change, build or deploy files change, or files are deleted. Also when the change is large: 15 files or 600 changed lines. |
| Before every merge | Always. |

Two cases need a person in every choice. No test ran, so the work is not verified. Or work copies compete on one task, and a person chooses one. The person who sent the agent answers. Owners can always answer. An owner can limit the answers to owners.

**Where the question shows.** The person chooses the chat of the agent, the app, or both (see [Where you answer merge questions](#where-you-answer-merge-questions)).

- **In the gitring app.** A card at the bottom of every project page shows the question, the size of the change and the tests. The page `/approve/<work copy>?project=<project>` shows the change and the tests. The answers are "Yes, merge it" and "Send back", with a note for the agent. The inbox lists it too. Each person sees the questions that wait for them.
- **In the chat of the agent, when the client can show a form.** The client must use the MCP revision 2026-07-28 and declare the `elicitation` capability. Then `gitring_submit` (or `create_pull_request` on `/mcp/github`) ends with an "input required" result. The client shows the form, the person answers, and the client calls the tool again with the answer. The SDK of the client does these steps. `test/mcp/official-client.test.ts` runs them with the official client SDK.
- **A link, for every other client.** The answer of the tool starts with `A PERSON MUST SAY YES` and holds the link of the approve page. The agent tells the person, does other work, and calls `gitring_wait` or `gitring_status` to see the answer. The official client SDK uses the 2025 revision unless the code asks for the new one. So many clients get the link today.

**What an answer does.** A yes: gitring tests the work again on the new main, then merges it. A send-back: the agent gets a change request with the note, changes the work and submits again. A built-in agent does the task again and reads the note. The first answer counts. A second answer, for the same question or for an old one, changes nothing and says why.

**What keeps the question honest**

- No tool says yes. The routes that answer (`POST /api/projects/:p/attempts/:id/decide` and `/land`) and the approval settings need a browser session. A personal key or the OAuth token of an app (what an agent holds) cannot call them. One exception: `decide` takes an answer from the [gitring command line](#the-command-line-for-people) when the person answers merge questions outside the app.
- A yes is for one version of the work. gitring ties the question to the agent's own changes: the removed and added lines of each file. When the agent changes the work, the question closes, and the next `gitring_submit` asks again. A rebase onto the new main that the agent did not touch keeps the yes.
- The question in chat travels through the client as `requestState`. gitring signs it with `GITRING_SECRET`, ties it to the person, and lets it expire after one hour. The project object checks again who may answer, which question waits, and that the work did not change.
- Limit: a program that holds the credentials of the person can send the answer by itself. This includes the sign-in of the gitring command line when the person answers outside the app. A person who answers only in the app closes this path: then no program with their key can answer. Approvals protect against an agent that runs away and against a merge by mistake.

A project can send an `approval` event to a webhook (Settings → Webhooks), for example to Slack. It sends one when a question starts and one when it is answered.

### Redo when work cannot merge

Work of an outside agent can fail to merge on the new main. The text conflicts, or the tests fail on main plus the work. Then gitring follows the redo policy of the project (Settings → Merging):

| Policy | What happens |
|---|---|
| Same agent first (default) | The work goes back to the same agent with a change request. If the agent does not answer in the wait time (default 15 minutes), a built-in agent does the task again. |
| Same agent only | The work goes back to the same agent. If the agent does not answer, a person decides. |
| Built-in agent | A built-in agent does the task again at once. |

The same agent gets the work back at most 3 times. Work of built-in agents is always done again by a built-in agent. When no agent may try again, the question goes to the inbox (see [Questions that a person decides](#questions-that-a-person-decides)).

The merge queue is safe across a restart of the project object. A merge can be pushed but not yet recorded at a restart. Then the next merge reads the real tip of main, records the first merge, and goes on.

## GitHub sync: an optional export

GitHub sync is off for every new project, also for a project that came from a GitHub repository. Merged code stays in Cloudflare Artifacts, and `gitring clone` or `gitring_clone` gets it. A GitHub import links its repository. Settings → GitHub links any project to a repository and chooses where merged code goes:

| Mode | What happens |
|---|---|
| Off (the default) | Merged code stays in Cloudflare Artifacts. Clone it from the Artifacts remote. |
| Pull request | After each merge, gitring pushes main to a branch (default `gitring`). It keeps one pull request open to the followed branch. People merge it on GitHub ("Create a merge commit", so that the next pull request shows only new work). gitring never overwrites commits that people push to its branch. |
| Straight to main | After each merge, gitring fast-forwards the followed branch. When GitHub has commits that gitring does not have, gitring brings them in first. |

The followed branch is the imported branch (default: the repository's default branch). gitring makes one GitHub commit for each merge, in batches of 200. It uses the GitHub Git Data API and installation tokens of the gitring GitHub App.

**Bring GitHub changes in**: three things start a pull when sync is on. A push to the followed branch (webhook), "Bring GitHub changes in now" in Settings, or a blocked sync. gitring compares the last GitHub commit that main has with GitHub's branch. It takes GitHub's version of files that only GitHub changed, and merges text where both changed different lines (3-way). It commits one "Bring GitHub changes into main" commit. On GitHub it becomes a merge commit, so GitHub's history stays whole. When GitHub and main changed the same lines, gitring opens a task with GitHub's diff. An agent or a person does it. When that task merges, the rest of the changes come in. After a pull, gitring runs the tests of main. When they fail, it opens the task "Fix the tests after GitHub changes" with high priority. Work in progress moves onto the new main, and its agents get a change request. Pulls run in the merge queue, one at a time.

Rights: a link to a repository needs read rights on GitHub. Sync needs push rights and the app on the repository. gitring checks them as the person, with their GitHub token. It checks again once a day before it pushes or reads a private repository.

## Hooks: other apps in and out

| In | |
|---|---|
| `POST /hooks/intents` | Any app with a member's API key: `{ project, title, goal, checks?, source?, launch? }` → a new task |
| `POST /hooks/github-app` | The gitring GitHub App. An issue labeled `gitring` by a project member → a task in each project that imports or links the repository. A push to a followed branch → GitHub changes come into main, when sync is on. Each delivery counts once. |
| `POST /hooks/github` | A plain repository webhook (`GITHUB_WEBHOOK_SECRET`) → a task, for the project's own repository only. The URL from the Connect page holds the project and its key. Each delivery counts once. |
| `POST /hooks/slack` | Slash command `/gitring Add a dark mode — Readers can switch…` (`SLACK_SIGNING_SECRET`; the command URL from the Connect page holds the project and its key). Each signed request counts once. |
| `POST /hooks/claude/<project>` | The Claude Code hook. Each file edit of an agent → a conflict check, and the change requests go back into the chat. |
| **Out** | Project webhooks (Settings → Webhooks) get events as JSON or Slack messages. The events: `landing` (a merge), `correction` (a change request), `decision`, `approval` (a question and its answer), `question` and `intent`. Each webhook has its own secret, shown once. Each request has the header `gitring-signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>">`. A server error or a network error gets 3 more tries. |

## Limits

Most of these limits come from the design. The **Load** bullet gives numbers from load runs on the real Cloudflare services and on a local copy. The bullet after it names what changed since those runs.

- **Conflict check**: gitring judges at most 20 plans within one import, and every plan that comes closer. A collision with any other plan appears later, at the merge, as a text conflict or a failed test.
- **Merge**: one change merges at a time in each project. Other work waits in the merge queue. On the real services a merge took 1 to 4 seconds (see **Load**). So one project merges 0.25 to 1 change a second. When all agents of a project send work in the same minute, the last agent waits for all the others.
- **What a merge carries**: a file over 10 MB stays out of a merge. Files without text past 16 MB in one merge stay out. A new folder of tool output (`node_modules`, caches) that main does not have stays out. So does a new vendored or built folder with more than 200 files. Submodules stay out. The agent hears about each path that stayed out. Text analysis (symbols, line ranges) covers at most 6,000 text files of at most 1 MB each.
- **Test containers**: a container gets the tree of the work within the limits above. The install command must make the dependencies. Container test runs have an hourly budget. The defaults are 240 for each project owner and 2,000 for the deployment (`CHECK_RUNS_PER_OWNER_HOUR`, `CHECK_RUNS_PER_HOUR` in `wrangler.jsonc`).
- **Redo**: gitring gives work back to the same agent at most 3 times. With the policy "Same agent only", a person decides after that. With the other policies, a built-in agent does the task again, at most 2 times. When the redos fail, a person decides.
- **Project size**: one coordinator for each project (a Durable Object) keeps its tasks and work copies in memory. Plan for hundreds of active work copies in one project, up to about 2,000. Use several projects beyond that.
- **Symbol analysis**: it covers JavaScript and TypeScript only. Other languages use files and line ranges.
- **Load**: `scripts/load.mjs` makes many agents work at the same time through the real MCP door. It ran on a second copy of gitring in a Cloudflare account, and on a local copy. No run had a protocol error. One run on the real services had 3 tool errors: a restart of the project object, see below. Every task of that run merged.
  - **Real Cloudflare services** (11 October 2026, build 0.9.2): a second copy with its own Artifacts namespace and Workers AI. It used the `worker` test runner. Each agent did 3 tasks. All agents started within 3 seconds. The script ran in a cloud sandbox behind a proxy, so the times of its calls include that network path. The cheapest call, `gitring_status`, took 60 ms at the median. No answer had the status 429.
    - Tasks on separate files: 8 agents merged 24 of 24 tasks in 92 seconds (two runs, 92 and 93). 24 agents merged 72 of 72 in 280 seconds. 60 agents merged 180 of 180 in 750 seconds.
    - One hot file: 30 tasks in 100 also add a line to the same file. With it, 24 agents merged 70 of 72 tasks in 358 seconds, and a built-in agent took the other 2. 60 agents merged 174 of 180 in 839 seconds. Of the other 6, 4 went to a built-in agent and 2 waited for a person. The agents received 198 and 1,538 change requests, and gave way 72 and 462 times. No task failed.
    - The last build (0.9.2+20261011e) ran 24 agents twice on the real services. On separate files 72 of 72 tasks merged in 86 seconds. With a hot file 69 of 72 merged in 340 seconds. One task merged into a same task, one waited for a person, and one went to a built-in agent. It had no tool error and no protocol error.
    - One project merges one change at a time, so more agents do not make the merges faster. The speed of Artifacts sets the rate. At the start of the test day a merge took about 1 second. The build before 0.9.2 merged 24 tasks in 28 and 31 seconds. Later a merge took 3.6 to 4.2 seconds, about 0.25 merges a second. The same test commit took 1.1 seconds, then 3.1 seconds ten minutes later, and 1 second again two hours later. The speed of the service changed in the day, and the number of agents did not. We do not know the cause. When all agents send work at the same moment, the last agent waits for the others. That wait was 21 seconds with 8 agents, 83 with 24, and 236 with 60. In a fast hour, 24 agents merged 72 tasks in 121 seconds. Agents that work for minutes between two merges make a much shorter queue.
    - `gitring_submit` took 3 to 6 seconds at the median. gitring makes a copy of the project in Artifacts (2 to 4 seconds) and writes the work into it.
    - One Artifacts answer had the status 500 in 7,248 git requests. gitring sent the request again and the merge went on. In an earlier run, the same error dropped a merge from the queue. The agent waited 120 seconds for nothing. That bug is fixed (build 0.9.2).
    - The platform can stop a project object for a moment. In one run, 3 of 72 submits met this. The agent got the message "Connection closed: this Durable Object instance is no longer active". The merges themselves went on after the restart, and all 72 tasks merged. gitring now sends the safe calls again by itself (reads, submit, write, ack, check, update). The agent sees a plain sentence only when the object stays away for three tries. One Artifacts call answered "An internal error occurred" (1 fork in 580). gitring now sends such a call again, at most twice.
    - A big repository costs time at each merge, because gitring fetches the whole latest tree. These numbers come from a fast hour. In a repository of 6,000 files (47 MB) a merge took 9 seconds and the first commit 17 seconds. At 3,000 files (23 MB) they took 7 and 10 seconds. At 1,500 files (12 MB), 4 and 5 seconds. No memory limit or CPU limit stopped these runs.
  - **Local copy** (a test version of Artifacts, no Workers AI, no rate limits). 8, 24 and 60 agents ran 3 tasks each.
    - Tasks on separate files merged at about 2 to 2.4 a second, one merge at a time. 24 of 24, 72 of 72 and 180 of 180 tasks merged, in 10, 30 and 89 seconds.
    - With one hot file the rate fell to 0.5 to 0.6 a second at 24 and 60 agents. The agents that give way wait for each other. With 24 agents, 70 of 72 tasks merged in 114 seconds. Two waited for a person (two work copies of one task). With 60 agents, 174 of 180 merged in 341 seconds.
    - Agents that ignore the change requests (`--ignore-requests`) finish the 72 tasks of 24 agents in 36 seconds. Only 63 merge. The others go back to the agent, to a built-in agent or to a person. To give way costs time and saves work.
  - A hot spot is the worst case: many agents that add a line at the same place of one file.
  - The 11 questions about the real Artifacts service that were open now have answers (see `ARTIFACTS_CHECKS` in `src/platform/repo/artifacts.ts`). One of them: a push that starts from an old commit is refused. Two answers differ from the first guess. The binding cannot read the notes ref, so gitring fetches it over git. A fork is ready when the call returns.
- **New since the load runs, not yet measured on the live service** (13 and 14 October 2026). The load runs above used build 0.9.2. The test suite runs the new code on a test version of Artifacts. Its end-to-end tests use 8 to 60 agents. No load run and no deployment has tried the new code on the real Cloudflare services yet. The new parts:
  - `gitring_wait`, and change requests in every answer about a work copy.
  - The code check of `gitring_ack`, and the closed status of a request.
  - Work copy ownership.
  - The choice where a person answers, the inbox, push notifications and the installable app.
  - Questions for a person, and line requests.
  - Passkeys, and the device sign-in of the command line.
  - Projects from agents, templates, the describe field, and GitHub sync off by default.
  - GLM agents and signed webhooks.
  - A merge that carries every change, and the digest of a yes.
  - Merge recovery after a restart, and the full tree in test containers.
  - In the conflict check: pairs that come closer, `uses`, class members, JSX and path aliases.
  - The history tools, derived data and Replay.
- **Rate limits**: the MCP door allows 3,000 calls a minute for one person at one Cloudflare location. The load runs made 500 to 1,650 calls a minute with one key. The limit was 600 before these runs, which was too low for scripted agents.
- **Artifacts**: Cloudflare sets these limits. Artifacts is in open beta, so they can change. See the [Artifacts limits page](https://developers.cloudflare.com/artifacts/platform/limits/) (numbers from 1 October 2026).
  - A repository holds at most 1 GB. A file holds at most 32 MB.
  - An account holds at most 1 TB. Cloudflare can raise this on request.
  - Each namespace allows 2,000 control requests every 10 seconds. Each repository allows 2,000 git requests every 10 seconds.
  - A project is one repository, and each work copy is one more. All projects of a deployment share one namespace.
  - gitring does not delete repositories. The repository of a finished work copy stays until you delete it.
- **Cost**: a deployment on Cloudflare needs a paid plan (Workers Paid). Cloudflare bills Artifacts operations and storage from 14 October 2026 (see [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)). Test containers also bill by use. A merged task made 31 calls to Artifacts on separate files: 12 git requests and 19 other calls. With a hot file it made 38 to 43. Cloudflare does not say which calls count as one operation. If every call counts, a task costs about $0.005 to $0.0065 at $0.15 for 1,000 operations. If only git requests count, it costs about $0.002.

## Trains and tests after the merge

When several work copies are ready, gitring takes the largest independent set. These work copies share no file and are far apart on the ladder. It composes them onto main in order and runs the tests once on main plus all of them. Each task becomes its own commit with its own why-record, and one push carries them all. When a train fails, gitring splits it to find the work that fails. The rest merges. Settings → Merging has "Largest train" (1 to 16, default 8).

The choice "When are tests run?" has two values:

- **Before each merge** (default): work merges only when the tests of main plus the work pass.
- **After merge, with automatic revert**: work whose own tests pass merges at once. gitring tests main in the background. When main fails, gitring bisects over the merges since the last green main and reverts the merge that broke it. The revert has its own why-record. The task opens again, and the agent gets a change request with the failed tests. When a person said yes to the reverted work, that person gets a question in the inbox.

History shows trains, reverts and the test mode.

## Commits that cost the size of the change

A commit builds new git objects only for the changed paths. The unchanged trees keep their ids. gitring sends them with a small receive-pack client for Workers. The bytes of a commit do not grow with the size of the repository. In the test, a one-line change sends about 610 bytes. The tree is small, or it has 605 files. A full clone sends the whole tree. The clone path stays as a fallback. It starts by itself when the new path fails, unless the cause is a conflict.

Notes use a fan-out tree (`ab/cdef…`). A flat notes tree moves to it on the first write. A blob cache (Cache API, key = blob id) sits in front of the reads. A work copy in api mode gets no fork when it starts. gitring makes the fork only when real git needs it.

## Approvals by kind of change, and rules by folder

gitring names the kind of each change: comment only, layout only, docs only, tests only, or logic. For JavaScript and TypeScript it compares the tokens without comments. "Looks risky" ignores the first three kinds and docs. The approval card says which kind it is.

Owners set rules by folder in Settings → Merging:

- `migrations/**`: an owner says yes.
- `docs/**`: no yes needed.
- `infra/**`: only the agents of the named people may change it.

gitring checks the rules when the plan arrives and again when the work comes in. The answers say in plain words which rule applies.

## Security

- Sessions, API keys, OAuth codes and tokens: only SHA-256 hashes are stored. Provider credentials and GitHub tokens are sealed with AES-GCM (key from `GITRING_SECRET`).
- Passkeys: WebAuthn with Web Crypto only (ES256, EdDSA, RS256). gitring keeps the public key, the sign count and the name of each passkey. A challenge works once, for 5 minutes, in the browser that asked for it. A sign count that goes back is refused.
- Sign-ins are bound to the browser that started them (a cookie with the OAuth state). An OAuth consent is bound the same way. Browser sessions cannot make cross-site writes. The device sign-in of the command line is bound to the browser that showed the code.
- Rate limits per Cloudflare location (Workers rate limits), each a minute. Sign-in starts, client registrations and device sign-ins: 20 per address. OAuth token calls: 120 per address. MCP: 3,000 per person. The API: 1,200 per person. Inbound hooks: 1,200 per key, or per address for a hook without a key. Live previews: 600 per address. Credential lookups: 6,000 per address on every route, so keys and cookies that are not valid stop at the edge. New OAuth clients and new device sign-ins: 30 an hour per address.
- The OAuth consent page names the address that gets the app's code, because a registered app can call itself anything. The Allow button works after one second. A request that cannot go on shows a page, not a redirect.
- A key or an OAuth token (what an agent holds) cannot say yes to a merge or merge work. It cannot answer a question, ask an agent for a line change, or change the approval settings. Only a browser session can. The gitring command line can answer a merge question only when the person answers outside the app. A yes in the chat form travels in a signed request. It is tied to the person and expires after one hour. See [Approvals](#approvals-a-person-says-yes).
- A work copy belongs to the person who sent its agent. The tools that change it work for that person, an owner, or the operator key.
- A change of access closes the live connections that it concerns: a removed member, a project made private, a sign-out. Each one connects again and gets its role checked.
- Imports, outbound webhooks and client metadata documents go to public hosts only (no IP addresses, no local names). Outbound webhooks are signed with the secret of each webhook (`gitring-signature`).
- Push notifications carry no content. The app reads the inbox with the cookie of the person when a notification arrives.
- The web app has a strict Content Security Policy: inline scripts are allowed by hash only. Server pages allow no scripts except one by nonce. Live previews of agent code run sandboxed and can set no cookies or other headers on the gitring origin.
- Viewers of public projects do not see webhook addresses. Code of a private GitHub repository never goes into a public project.

## Project layout

The code keeps the names of its first design. This list gives each one a plain name.

```
src/core        pure logic: git objects, diffs, 3-way merge, JS symbol analysis, range,
                conflict-check facts, rules, model input and output, change requests, merge records,
                templates, approvals, the inbox, history shapes, what a merge carries
src/harbor      HarborMaster: the project coordinator (one Durable Object for each project);
                derived.ts: path history, line blame and the search index; webhooks.ts: signed deliveries
src/vessel      Vessel: the built-in agent runner (Workers AI, GLM)
src/directory   Directory: the account store (people, passkeys, sessions, API keys, projects, roles,
                preferences, push subscriptions)
src/drydock     Drydock: test containers; Seawall: their outbound network filter
src/platform    Artifacts backend, GitHub (client, repository lists, imports, sync, pulls), Workers AI calls,
                Dynamic Worker tests and previews
src/worker      routes, the waitlist gate and its pages, sign-in, OAuth server for MCP clients (with the device grant), MCP server (the gitring,
                read-only and GitHub-compatible sets), projects, history routes, push, rate limits, hooks
cli             gitring, the command line for people (plain Node, no dependency)
plugins/gitring the Claude Code plugin: the connection, the skill and the hook
web/src         React web app and its design system (/design opens it in local development); views/replay
scripts         load.mjs and meet.mjs (see Run your own gitring); palette.py prints the colors of the themes
examples/shop   a small shop project for the scripted agents and for a first try
local           start script and Worker entry for the run with no Cloudflare account (wrangler.local.jsonc)
test            unit tests (Vitest); test/support holds an Artifacts test double; test/docs checks this file
```

## License

MIT. See [LICENSE](LICENSE). Fonts: Source Serif 4, Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono (SIL Open Font License 1.1).
