# cli: the command line `gitring`

`gitring` is the command line for people who work with agents on gitring. It needs Node 20 or later and no other package. `package.json` points the `gitring` command at `cli/gitring.mjs` (`bin`). Run `npm link` once in this repository to use it in every folder.

## The commands

| Command | What it does | Where it lives |
|---|---|---|
| `gitring login [--server URL] [--open]` | Sign in. You type a code in your browser (OAuth device grant, RFC 8628). | `commands/login.mjs`, `lib/device-grant.mjs` |
| `gitring logout` | Sign out on this computer, and end the sign-in on the server. | `commands/login.mjs` |
| `gitring whoami` | Show your name and your server. | `commands/whoami.mjs` |
| `gitring projects` | List your projects. | `commands/projects.mjs` |
| `gitring new <name> [--template NAME] [--describe TEXT] [--public]` | Make a project. With `--describe`, gitring also makes the first task and starts an agent. | `commands/new.mjs` |
| `gitring clone <project> [folder]` | Clone a project with git. The read token does not stay in the folder. | `commands/clone.mjs` |
| `gitring tasks <project>` | List the open tasks of a project. | `commands/tasks.mjs` |
| `gitring task <project> "title" "goal"` | Make a task. Agents can take it. | `commands/tasks.mjs` |
| `gitring inbox` | List the items that wait for you in all your projects. | `commands/inbox.mjs` |
| `gitring yes <item> ["note"]` | Say yes to a merge question from your inbox. | `commands/answer.mjs` |
| `gitring back <item> "note"` | Send the work back to the agent. The note tells the agent what to change. | `commands/answer.mjs` |
| `gitring watch <project>` | Show the log of a project live (WebSocket). Press Ctrl+C to stop. | `commands/watch.mjs`, `lib/websocket.mjs` |

Options for every command: `--server URL`, `--json`, `-h` / `--help`, `--version`. The help text is in `lib/usage.mjs`. The rules for the arguments of each command are in `lib/args.mjs`.

## How a command runs

1. `gitring.mjs` calls `main(argv, io)`. `lib/context.mjs` builds `ctx`: the environment, `fetch`, the output, the clock, child processes and the WebSocket. Tests give their own `io` and so replace every part.
2. `lib/args.mjs` reads the command line. A wrong command line ends with exit code 2 and a plain message.
3. `commands/index.mjs` points the command word to its function. The function gets `ctx` and its arguments, and answers the exit code.
4. A command that needs a sign-in asks `lib/session.mjs` for the server and the credential. `lib/rest.mjs` makes REST calls. `lib/mcp.mjs` calls MCP tools (JSON-RPC over HTTP, the stateless 2026-07-28 form).
5. A route that the server does not have gives "This gitring server is too old for this command."

Exit codes: 0 done, 1 the command did not finish, 2 the command line is wrong.

## Sign-in and storage

The sign-in gives an OAuth token for the MCP endpoint of the server. The token works for the REST routes of these commands too (`src/worker/cli.ts`). It is stored in the config folder of the person (`credentials.json`, mode 0600) and never printed. Scripts can set `GITRING_URL` and `GITRING_TOKEN` (a personal API key) and need no sign-in. `lib/credentials.mjs` reads and writes the file. `lib/config.mjs` finds the folder on each system.

An answer from the command line counts as the answer of the person only when the person allows answers outside the gitring app (Account, "Where do you answer merge questions?").

## The files

- `gitring.mjs`: the front door. It re-exports every public name (tests and `gitring.d.mts` use them), runs `main`, and starts it when the file is the program.
- `gitring.d.mts`: the types of the front door.
- `commands/`: one file for each command or small family. See `commands/README.md`.
- `lib/`: the parts that commands share. See `lib/README.md`.

The tests are in `test/cli/` (`cli.test.ts` against a fake server, `login.test.ts` against a whole gitring in one process, `answer.test.ts` for `yes` and `back`).
