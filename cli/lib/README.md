# cli/lib: the parts that the commands share

None of these files knows a command by name. They read the command line, find the server, make calls and format text. All of them reach the outside world through `ctx` (see `context.mjs`).

- `constants.mjs`: the version, the OAuth client id, the protocol names and the file name of the stored sign-ins.
- `usage.mjs`: the help text that `gitring --help` prints.
- `errors.mjs`: `CliError`, the error with a plain message and an exit code.
- `args.mjs`: reads the command line; the rules of each command (`SPEC`).
- `config.mjs`: the address of the server (`serverOrigin`) and the config folder on each system.
- `credentials.mjs`: reads and writes `credentials.json`; remembers and forgets one sign-in.
- `http.mjs`: one HTTP call in a plain shape; form posts; the words of an error answer.
- `session.mjs`: who calls (a key or a sign-in) and the access token, renewed when it ends soon.
- `rest.mjs`: REST calls with the credential, and the reading of their answers.
- `mcp.mjs`: one MCP tool call (JSON-RPC over HTTP) and the reading of its answer.
- `format.mjs`: ages, tables, clock times, task words, plain text and JSON output.
- `device-grant.mjs`: the OAuth device grant: ask for a code, show it, wait for the person.
- `websocket.mjs`: a WebSocket client (RFC 6455) with plain Node.
- `system.mjs`: the browser of the system and child processes such as git.
- `context.mjs`: builds `ctx`, the outside world of a command; tests replace its parts.
