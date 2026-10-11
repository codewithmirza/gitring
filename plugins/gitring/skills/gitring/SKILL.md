---
name: gitring
description: Work through gitring when many agents or people change one repository at the same time. Use it when the gitring tools are in your tool list, or when the user names gitring. Send a plan first. Apply each change request. Run the tests. Then ask for a merge. Use gitring instead of a GitHub pull request for work in a gitring project.
---

# Work through gitring

gitring lets many agents change one repository at the same time.
It checks your plan against all active work.
It sends change requests, not rejections.
It runs the tests and merges the work.

## When to use gitring

Use gitring when the user names gitring or a gitring project.
Use it when the gitring tools are in your tool list and the task changes a repository.
Use it when other agents or people change the same repository now.

Use a GitHub pull request when no gitring project exists for the repository.
Use one when the user asks for a pull request.
Do not open a pull request for work that gitring merges.
When the project sends merges to GitHub, gitring does it for you.

## The loop

1. **Find the task.** Call `gitring_intents` without a project to list your projects. Call it with a project id to list the open tasks. Ask the user which project to use when it is not clear.
2. **Send a plan before you write code.** Call `gitring_declare`. Give a real plan: the steps, the files, the functions (`path#name`) and one sentence of approach. Pick a task with `intentId`, or send a new one with `newIntent`. Set `agent.client` to `claude-code`.
3. **Choose how to work.** On a computer, use `mode: "git"`. The answer holds a remote and a token. Clone the remote, then commit and push with plain git. Without a computer, use the default mode `api`. Then use `gitring_read`, `gitring_list` and `gitring_write`.
4. **Give `workdir`.** Set it to the absolute path of the folder where you work. The plugin hook then sends change requests after each file edit.
5. **Work.** Report progress with `gitring_log`. In git mode, give `headSha` after a push. See the work near yours with `gitring_traffic`.
6. **Apply every change request.** An answer that starts with `GITRING CHANGE REQUEST` lists what to change. Apply each item in your next edits. Then call `gitring_ack` with the change request id and one line about what you changed. Do not stop your work.
7. **Test.** Call `gitring_check`. Fix each failure. Call it again until the tests pass.
8. **Ask for the merge.** Call `gitring_submit` with a short summary. gitring tests again and merges the work.
9. **When main moved.** A change request can say that main moved. Call `gitring_update`. In api mode, read the named files again. In git mode, run the git commands in the answer. Then test and submit again.

## Rules

- Send the plan first. A late plan gives late change requests.
- Never push to the main branch yourself. gitring merges.
- Never ignore a change request. Apply it, then confirm it.
- When the conflict check says "a person decides", tell the user and wait.
- Reuse your `agentId` in later calls of `gitring_declare`.
- Keep the token of your work copy secret. Do not write it into a file.

## If a tool fails

- The error says the project is unknown: ask the user for the project id.
- The error says you need the member role: ask an owner of the project to add you.
- The gitring tools are not in your tool list: tell the user to connect gitring. In Claude Code, the command is `/mcp`.
