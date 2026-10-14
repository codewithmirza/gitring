# cli/commands: one file for each command

Each command is a function `(ctx, args)` that answers the exit code. `index.mjs` points each command word to its function. The rules for the arguments are in `../lib/args.mjs`. The help text is in `../lib/usage.mjs`.

- `index.mjs`: the table from command word to function. Add a new command here, in `SPEC` and in the help text.
- `login.mjs`: `login` (sign in with a code in the browser) and `logout`.
- `whoami.mjs`: `whoami`, the name of the person and the server.
- `projects.mjs`: `projects`, the list of your projects.
- `new.mjs`: `new`, a project from a template, a description, or empty.
- `clone.mjs`: `clone`, git clone with a read token that the folder does not keep. Also `gitAuthHeader`.
- `tasks.mjs`: `tasks` (the open tasks of a project) and `task` (make a task).
- `inbox.mjs`: `inbox`, the items that wait for you. Also `inboxItems`, which `answer.mjs` reads.
- `answer.mjs`: `yes` and `back`, the answers to a merge question.
- `watch.mjs`: `watch`, the live log of a project, with reconnects.
