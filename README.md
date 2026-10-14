# gitring

gitring lets many coding agents change one repository at the same time.

Each agent sends its plan (steps, files, functions) before it writes code. gitring compares the plan with the 20 nearest other plans. It also compares the plan with changes that merged into main after the work copy began. If two agents will collide, gitring sends a change request to one of them. It does not reject the agent, and the agent continues. A collision with any other plan appears later, at the merge, as a text conflict or a failed test.

gitring merges work into main only when the tests pass. A person can say yes first: gitring asks in the chat of the agent or in the gitring app, and no agent can answer for the person (see [Approvals](#approvals-a-person-says-yes)). When main moves, api mode and git mode differ (see [Connect agents](#connect-agents)). In api mode, gitring moves the work copy onto the new main. In git mode, the agent runs `git pull` and fixes conflicts itself. Agents fix merge conflicts. When agents cannot agree, a person chooses. For example, a person picks one of several results.

gitring runs on Cloudflare Workers, Durable Objects, Artifacts, Workers AI, Dynamic Workers and Containers. Agents connect through MCP or plain git.

## How it works

```
1. A person writes a task (web page, API, GitHub issue).
2. An agent sends its plan ............................... gitring_declare
3. Conflict check: gitring measures the distance to each other active plan and judges the 20 nearest
      0 same lines · 1 shared function · 2 same file · 3 one import · 4 two imports · 5 no relation
   ├── distance 4 or 5 ... clear, no AI call (a plan that comes closer is judged)
   ├── distance 3 ........ fixed rules decide, no AI call (see the note below the list)
   └── distance 0 to 2 ... a small Workers AI model decides; an unclear answer goes to a larger model;
                           if the AI fails, fixed rules decide
   Result: clear, or a change request to ONE agent. The other agent continues.
4. The agent works. Each write, report or push runs step 3 again.
5. The agent runs the tests (gitring_check) and asks for a merge (gitring_submit).
   When the project asks, or the work looks risky, a person says yes first (see Approvals). The work waits. The agent does not stop.
6. Merge, one at a time in each project:
   fast-forward → 3-way merge → tests on main + work → commit to main with a git note (the record of why)
   If the text conflicts or the combined tests fail, the work goes back to its agent (redo policy).
7. gitring tells the agents near the changed files that main moved.
```

The note on distance 3: gitring skips the model call only when the model cannot change the answer. A pair at distance 3 or more cannot reach a change request under the default thresholds. So the fixed rules decide when every compared plan is at distance 3 or more, no plan comes closer, no changed function is used by another plan, and the task texts share few words. In every other case the model is called.

| Term | Meaning |
|---|---|
| task | A change that a person wants: a goal, and test files if you add them. |
| plan | The steps, files and functions that an agent will change, and its approach. |
| work copy | A git copy (fork) of main for one agent on one task. |
| conflict check | gitring compares one plan with the 20 nearest other plans. It also compares the plan with changes that merged into main after the work copy began. |
| change request | A message from gitring to one agent: change your plan or your code. Never a rejection. |
| rebase | Work in progress gets the new main after a merge. In api mode, gitring does this (3-way, per file). In git mode, the agent does it with `git pull`. |
| approval | A merge that waits for a person. The person says yes (gitring merges) or sends the work back (the agent changes it). |
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
npm test               # unit tests and end-to-end tests with 8 to 60 agents (Vitest)
npm run typecheck
npm run bench          # the coordination logic on many simulated plans: no network, no Artifacts, no AI
npm run load -- --help # a load test for a deployed gitring: it costs money, so it asks for --yes
npm run meet -- --help # three scripted agents meet on a small project: you read the real answers
```

The end-to-end tests run the real coordinator on a test version of Artifacts, so they do not prove how the real service behaves. `npm run load` does that on a deployed copy.

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

Then connect an agent. For Claude Code, run this command with the key from above:

```bash
claude mcp add --transport http gitring http://localhost:8787/mcp --header "Authorization: Bearer <key>"
```

[Connect agents](#connect-agents) shows other clients. Give the agent the project id from the answer to the `curl` command.

To read what the coordination says before you connect a real agent, run three scripted agents. They meet on a small shop project (the files of `examples/shop`), and the script prints each real answer of the MCP tools:

```bash
GITRING_URL=http://localhost:8787 GITRING_KEY=<key> npm run meet -- --approval --wait 0
```

To measure the real Cloudflare services without a risk for your live deployment, run a second copy. Copy `wrangler.jsonc` to `wrangler.loadtest.jsonc`. In the copy, change `name`, the `artifacts` namespace and `ARTIFACTS_NAMESPACE` (a new name makes a new namespace), and the `namespace_id` of each rate limit (all Workers of an account share these ids). Delete the `containers` entry. Deploy with `wrangler deploy --config wrangler.loadtest.jsonc`, and set the secrets `GITRING_SECRET` and `GITRING_KEY` with `wrangler secret put <name> --config wrangler.loadtest.jsonc`. Make a project with the settings `{"checks":{"runner":"worker"}}` (this runner has no test container and no hourly budget), put the files of `examples/shop` in it, and run `npm run load` against it with `GITRING_KEY` as the key. When you finish, delete the Worker (`wrangler delete --config wrangler.loadtest.jsonc`) and the repositories of the namespace (the Cloudflare API lists them 50 at a time: `GET /accounts/<id>/artifacts/namespaces/<name>/repos`, then `cursor`).

Agent A and Agent B change the same function. Agent B gets a change request and applies it. Both changes merge. Agent C changes the parameters of two functions, and a person must say yes. The script makes one private project and archives it at the end (`--keep` keeps it). The agents are scripts: the run shows the answers of gitring, not the behavior of a model. It also works on a deployed gitring, with a personal API key (Account → API keys).

To try real agents on a deployed gitring, make a project from the folder `examples/shop` (New project → Upload a folder), choose the gitring test runner in Settings → Tests, and give two agents a task that changes `formatPrice`.

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
- Roles per project: **owner** (settings, members), **member** (tasks, agents, merges), **viewer** (watch). Anyone can watch a public project; only members act on it. A work copy belongs to the person who sent its agent. Only that person or an owner can change it, and only that person's agent gets its change requests.
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

## Approvals: a person says yes

gitring can ask a person before it merges the work of an agent. The agent never answers that question. Only a person can.

An owner chooses when gitring asks, in Settings → Merging:

| Choice | gitring asks when |
|---|---|
| Only when the tests pass | No test ran, or work copies compete on one task. In all other cases gitring merges when the tests pass. |
| When a change looks risky (the default) | Also when the parameters of a function change, build or deploy files change, files are deleted, or the change is large (15 files or 600 changed lines). |
| Before every merge | Always. |

Two cases need a person in every choice: no test ran (the work is not verified), and work copies that compete on one task (a person chooses one). The person who sent the agent answers. Owners can always answer. An owner can limit the answers to owners.

**Where the question shows**

- **In the gitring app, always.** A card at the bottom of every page of the project shows the question with the size of the change and the tests. The page `/approve/<work copy>?project=<project>` shows the change, the tests, and the answers "Yes, merge it" and "Send back" (with a note for the agent). Each person sees the questions that wait for them.
- **In the chat of the agent, when the client can show a form.** The client must use the MCP revision 2026-07-28 and declare the `elicitation` capability. Then `gitring_submit` (or `create_pull_request` on `/mcp/github`) ends with an "input required" result. The client shows the form, the person answers, and the client calls the tool again with the answer. The SDK of the client does these steps. `test/mcp/official-client.test.ts` runs them with the official client SDK.
- **A link, for every other client.** The answer of the tool starts with `A PERSON MUST SAY YES` and holds the link of the approve page. The agent tells the person, does other work, and calls `gitring_status` (or `pull_request_read`) to see the answer. The official client SDK uses the 2025 revision unless the code asks for the new one, so many clients get the link today.

**What an answer does.** A yes: gitring tests the work again on the new main, then merges it. A send-back: the agent gets a change request with the note, changes the work and submits again. A built-in agent does the task again and reads the note. The first answer counts. A second answer, for the same question or for an old one, changes nothing and says why.

**What keeps the question honest**

- No tool says yes. The routes that answer (`POST /api/projects/:p/attempts/:id/decide` and `/land`) and the approval settings need a browser session. A personal key or an OAuth token (what an agent holds) cannot call them.
- A yes is for one version of the work. gitring ties the question to the content of the changed files. When the agent changes the work, the question closes, and the next `gitring_submit` asks again.
- The question in chat travels through the client as `requestState`. gitring signs it with `GITRING_SECRET`, ties it to the person, and lets it expire after one hour. The project object checks again who may answer, which question waits, and that the work did not change.
- Limit: a program that holds the credentials of the person can send the answer by itself. Approvals protect against an agent that runs away and against a merge by mistake. They do not protect against a program that holds a person's key.

A project can send an `approval` event to a webhook (Settings → Webhooks) when a question starts and when it is answered, for example to Slack.

## Limits

Most of these limits come from the design. The **Load** bullet gives numbers from load runs on the real Cloudflare services and on a local copy.

- **Conflict check**: gitring judges the 20 nearest plans. A collision with any other plan appears later, at the merge, as a text conflict or a failed test.
- **Merge**: one change merges at a time in each project. Other work waits in the merge queue. On the real services a merge took 1 to 4 seconds (see **Load**), so one project merges 0.25 to 1 change a second. When all agents of a project send work in the same minute, the last agent waits for all the others.
- **Test containers**: a container gets text files only. It gets at most 6,000 files, and each file has at most 1 MB. It gets no folder of dependencies or build output, such as `node_modules`, `vendor`, `dist`, `build`, `out` or `target`. It gets no binary file. The install command must make the dependencies. A test that needs such a file or folder does not work in the container. Container test runs have an hourly budget. The defaults are 240 for each project owner and 2,000 for the deployment (`CHECK_RUNS_PER_OWNER_HOUR`, `CHECK_RUNS_PER_HOUR` in `wrangler.jsonc`).
- **Redo**: gitring gives work back to the same agent at most 3 times. With the policy "Same agent only", a person decides after that. With the other policies, a built-in agent does the task again, at most 2 times. When the redos fail, a person decides.
- **Project size**: one coordinator for each project (a Durable Object) keeps the tasks and work copies of the project in memory. Plan for hundreds of active work copies in one project, up to about 2,000. Use several projects beyond that.
- **Symbol analysis**: it covers JavaScript and TypeScript only. Other languages use files and line ranges.
- **Load**: `scripts/load.mjs` makes many agents work at the same time through the real MCP door. It ran on a second copy of gitring in a Cloudflare account, and on a local copy. No run had a protocol error. One run on the real services had 3 tool errors (a restart of the project object, described below), and every task of that run merged.
  - **Real Cloudflare services** (11 October 2026, build 0.9.2): a copy with its own Artifacts namespace and Workers AI, and the `worker` test runner. Each agent did 3 tasks. All agents started within 3 seconds. The script ran in a cloud sandbox behind a proxy, so the times of its calls include that network path (the cheapest call, `gitring_status`, took 60 ms at the median). No answer had the status 429.
    - Tasks on separate files: 8 agents merged 24 of 24 tasks in 92 seconds (two runs, 92 and 93). 24 agents merged 72 of 72 in 280 seconds. 60 agents merged 180 of 180 in 750 seconds.
    - With one hot file (30 tasks in 100 also add a line to the same file): 24 agents merged 70 of 72 tasks in 358 seconds, and a built-in agent took the other 2. 60 agents merged 174 of 180 in 839 seconds. Of the other 6, 4 were with a built-in agent and 2 waited for a person. The agents received 198 and 1,538 change requests, and gave way 72 and 462 times. No task failed.
    - The last build (0.9.2+20261011e) ran 24 agents twice on the real services: on separate files 72 of 72 tasks merged in 86 seconds, and with a hot file 69 of 72 merged in 340 seconds (one task merged into a same task, one waited for a person, one was with a built-in agent). It had no tool error and no protocol error.
    - One project merges one change at a time, so more agents do not make the merges faster. The speed of Artifacts sets the rate. At the start of the test day a merge took about 1 second (24 tasks in 28 and 31 seconds, with the build before 0.9.2). Later it took 3.6 to 4.2 seconds, about 0.25 merges a second. The same test commit took 1.1 seconds, then 3.1 seconds ten minutes later, and 1 second again two hours later. The speed of the service changed during the day, and the number of agents did not. We do not know the cause. When all agents send work at the same moment, the last agent waits for the others: 21 seconds with 8 agents, 83 with 24, and 236 with 60 (in a fast hour, 24 agents merged 72 tasks in 121 seconds). Agents that work for minutes between two merges make a much shorter queue.
    - `gitring_submit` takes 3 to 6 seconds at the median: gitring makes a copy of the project in Artifacts (2 to 4 seconds) and writes the work into it.
    - One Artifacts answer had the status 500 in 7,248 git requests. gitring sent the request again and the merge went on. In an earlier run, the same error dropped a merge from the queue and the agent waited 120 seconds for nothing. That bug is fixed (build 0.9.2).
    - The platform can stop a project object for a moment. In one run, 3 of 72 submits met this, and the agent got the message "Connection closed: this Durable Object instance is no longer active". The merges themselves went on after the restart, and all 72 tasks merged. gitring now sends the safe calls again by itself (reads, submit, write, ack, check, update), and the agent sees a plain sentence only when the object stays away for three tries. One Artifacts call answered "An internal error occurred" (1 fork in 580). gitring now sends such a call again, at most twice.
    - A big repository costs time at each merge, because gitring fetches the whole latest tree. These numbers come from a fast hour. In a repository of 6,000 files (47 MB) a merge took 9 seconds and the first commit 17 seconds; at 3,000 files (23 MB) 7 and 10 seconds; at 1,500 files (12 MB) 4 and 5 seconds. No memory limit or CPU limit stopped these runs.
  - **Local copy** (a test version of Artifacts, no Workers AI, no rate limits): 8, 24 and 60 agents with 3 tasks each.
    - Tasks on separate files merged at about 2 to 2.4 a second, one merge at a time: 24 of 24, 72 of 72 and 180 of 180 tasks merged, in 10, 30 and 89 seconds.
    - With one hot file the rate fell to 0.5 to 0.6 a second at 24 and 60 agents. The agents that give way wait for each other. With 24 agents, 70 of 72 tasks merged in 114 seconds, and 2 waited for a person (two work copies of one task). With 60 agents, 174 of 180 merged in 341 seconds.
    - Agents that ignore the change requests (`--ignore-requests`) finish the 72 tasks of 24 agents in 36 seconds, but only 63 merge. The others go back to the agent, to a built-in agent or to a person. Giving way costs time and saves work.
  - A hot spot is the worst case: many agents that add a line at the same place of one file.
  - The 11 questions about the real Artifacts service that were open now have answers (see `ARTIFACTS_CHECKS` in `src/platform/repo/artifacts.ts`). One of them: a push that starts from an old commit is refused. Two answers differ from the first guess: the binding cannot read the notes ref (gitring fetches it over git), and a fork is ready when the call returns.
- **Rate limits**: the MCP door allows 3,000 calls a minute for one person at one Cloudflare location. The load runs made 500 to 1,650 calls a minute with one key. The limit was 600 before these runs, which was too low for scripted agents.
- **Artifacts**: Cloudflare sets these limits. Artifacts is in open beta, so they can change. See the [Artifacts limits page](https://developers.cloudflare.com/artifacts/platform/limits/) (numbers from 1 October 2026).
  - A repository holds at most 1 GB. A file holds at most 32 MB.
  - An account holds at most 1 TB. Cloudflare can raise this on request.
  - Each namespace allows 2,000 control requests every 10 seconds. Each repository allows 2,000 git requests every 10 seconds.
  - A project is one repository, and each work copy is one more. All projects of a deployment share one namespace.
  - gitring does not delete repositories. The repository of a finished work copy stays until you delete it.
- **Cost**: a deployment on Cloudflare needs a paid plan (Workers Paid). Cloudflare bills Artifacts operations and storage from 14 October 2026 (see [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)). Test containers also bill by use. A merged task made 31 calls to Artifacts on separate files (12 git requests and 19 other calls), and 38 to 43 with a hot file. Cloudflare does not say which calls count as one operation. If every call counts, a task costs about $0.005 to $0.0065 at $0.15 for 1,000 operations. If only git requests count, it costs about $0.002.

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

OAuth 2.1 details: protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` (and one for each endpoint below), server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`, dynamic client registration (RFC 7591) and client ID metadata documents, authorization code with PKCE (S256 only), tokens bound to the endpoint that the client names in the `resource` parameter (RFC 8707), revocation (RFC 7009). A token for `<origin>/mcp` does not work at `<origin>/mcp/github`, and the other way round. A client that sends no `resource` gets a token for `/mcp` only. Access tokens last one hour. Refresh tokens last 30 days and rotate at each use: each sign-in of an app is one token family, and a refresh token that comes back after its rotation ends that family. Only hashes of codes and tokens are stored. Account → Connected apps shows each app with its last use; Revoke ends its tokens.

Scripts and hooks send a personal API key instead (Account → API keys): `Authorization: Bearer gk_…`.

```bash
claude mcp add --transport http gitring https://<your-worker>/mcp --header "Authorization: Bearer $GITRING_KEY"   # Claude Code with a key
```

### Three endpoints

| Endpoint | Tools |
|---|---|
| `/mcp` | The 12 gitring tools (the table below). |
| `/mcp/github` | 20 tools with the names and the argument names of the GitHub MCP server: `get_file_contents`, `search_code`, `push_files`, `create_pull_request`, `list_issues` and others. `repo` is a gitring project id (`get_me` lists them). A branch other than `main` is your own work copy, and no tool writes to `main`. `create_pull_request` asks for a merge: gitring runs the tests first. `merge_pull_request` waits and reports: gitring merges when the tests pass and, when the project asks, after a person says yes. |
| `/mcp/readonly` | Only the gitring tools that read. The OAuth scope `mcp:read` limits a token to these tools. |

To use gitring in place of the GitHub MCP server, remove the GitHub server and add `/mcp/github` under the same name:

```bash
claude mcp remove github
claude mcp add --transport http --scope user github https://<your-worker>/mcp/github
```

**Why a second address?** `/mcp/github` is not a second system. It is the same project, the same plan check, the same tests and the same approvals, with the tool names that agents already know. Many agents have a habit or a prompt that says "use the GitHub tools". With this address, a team changes one URL, and the agents keep their habit while gitring does the merging. New setups use `/mcp`. A sign-in is good for one address only, so an agent signs in again after the change.

Prompts and skills that name GitHub tools keep working for the code-change loop: read, search, branch, push, pull request and task. The GitHub server has more tools (Actions, code scanning, releases and others), and gitring has none of them. `issue_write` makes a task. A person changes or closes a task in gitring. The tools of `/mcp/github` are in `src/worker/mcp-github.ts`.

| Tool | What it does |
|---|---|
| `gitring_intents` | Lists your projects, or the open tasks of one project. |
| `gitring_declare` | Starts work on a task: send the plan, get a work copy and the first conflict check. |
| `gitring_traffic` | Shows the other active work near your plan. |
| `gitring_read`, `gitring_list` | Read files of your work copy (api mode). New change requests come after the file, in a second part. |
| `gitring_write` | Writes whole files into your work copy (api mode). Runs a conflict check. |
| `gitring_log` | Reports progress. In git mode, reports a push at once. Runs a conflict check. |
| `gitring_ack` | Confirms that you applied a change request. gitring checks the code. Code that still edits the lines of the request, or calls an old form of a function, keeps it open. |
| `gitring_check` | Runs the tests of your work copy. In git mode, gitring tests your latest push. |
| `gitring_submit` | Asks for a merge. gitring tests again. Then it merges, or a person says yes first when the project asks (see Approvals). |
| `gitring_status` | Shows where a work copy is: with a person, sent back, in the merge queue or merged. It changes nothing. |
| `gitring_update` | Brings the new main into your work copy. In git mode: a read-only remote and token for main. |
| `gitring_wait` | Waits for news about your work copy. News is a change request, a move of main, the answer of a person, or a new status. It answers when the news arrives, or after 25 seconds (50 at most). Use it instead of a sleep. |

Two modes:

- **api mode** (default): the agent reads and writes files through gitring. gitring holds the working tree and merges writes made from an old copy. When main moves, gitring rebases the work copy. If the two changes overlap in a file, the file goes back to the version on main. The agent makes its change again.
- **git mode**: `gitring_declare` returns a remote for the work copy and a token (6 hours). The agent clones, commits and pushes with plain git. gitring reads the latest push at `gitring_check` and `gitring_submit`; `gitring_log` with the head SHA gets a conflict check at once. gitring does not rebase the work copy. When main moves, the agent merges it into its work (`gitring_update`, then `git pull`) and fixes the conflicts itself. Then gitring moves the base of the work copy to that main. If the agent does not merge main, gitring still merges text that does not overlap. It gives work with a text conflict back to the agent.

**Claude Code hook**: change requests can also arrive in the middle of a task, after each file edit. Add this to `.claude/settings.json` in the agent's repository, and give your repository folder as `workdir` in `gitring_declare`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command",
  "command": "curl -s -X POST -H 'content-type: application/json' -H \"Authorization: Bearer $GITRING_KEY\" --data-binary @- 'https://<your-worker>/hooks/claude/<project-id>'" } ] } ] } }
```

### Claude Code plugin

The plugin is in `plugins/gitring`, and `.claude-plugin/marketplace.json` lists it. It holds the connection to `/mcp`, a skill for the work loop (send a plan, apply change requests, test, ask for the merge) and the hook above. It asks for the address of your gitring, and for a project id and a personal API key for the hook.

```
/plugin marketplace add codewithmirza/gitring
/plugin install gitring@gitring
```

### Make gitring the default in a repository

Put the address in the files of the repository, so that a new clone connects with no setup:

- `.mcp.json` for Claude Code: `{ "mcpServers": { "gitring": { "type": "http", "url": "https://<your-worker>/mcp" } } }`. Claude Code asks for approval before it uses a server from this file.
- `.cursor/mcp.json` for Cursor and `.vscode/mcp.json` for VS Code: the forms are in the table above.
- `AGENTS.md`, which many agents read. A block like this one tells an agent what to do:

```md
## Changing code in this repository
Many agents work here at the same time. Use the gitring tools when they are in your tool list.
Send a plan with `gitring_declare` before you edit, and apply every change request that comes back.
Run `gitring_check`, then call `gitring_submit`. Do not open a pull request for work that gitring merges.
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
| **Out** | Project webhooks (Settings → Webhooks) get `landing` (a merge), `correction` (a change request), `decision`, `approval` (a question for a person, and its answer) and `intent` events as JSON or Slack messages. Each webhook has its own secret, and each request has the header `gitring-signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>">`. A server error or a network error gets 3 more tries. |

## Security

- Sessions, API keys, OAuth codes and tokens: only SHA-256 hashes are stored. Provider credentials and GitHub tokens are sealed with AES-GCM (key from `GITRING_SECRET`).
- Sign-ins are bound to the browser that started them (a cookie with the OAuth state); an OAuth consent is bound the same way. Browser sessions cannot make cross-site writes.
- Rate limits per Cloudflare location (Workers Rate Limiting): sign-in starts and client registration 20 a minute per address, OAuth token calls 120, MCP 3000 a minute per person, the API 1200, inbound hooks 1200 a minute per key (per address for a hook without a key), live previews 600 a minute per address, and 6000 credential lookups a minute per address on every route (keys and cookies that are not valid stop at the edge). New OAuth clients: 30 an hour per address.
- The OAuth consent page names the address that gets the app's code (a registered app can call itself anything); the Allow button works after one second. A request that cannot go on shows a page, not a redirect.
- A key or an OAuth token (what an agent holds) cannot call the routes that say yes to a merge, merge work, or change the approval settings. Only a browser session can. A yes in the chat form travels in a signed request that is tied to the person and expires after one hour. See [Approvals](#approvals-a-person-says-yes).
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
