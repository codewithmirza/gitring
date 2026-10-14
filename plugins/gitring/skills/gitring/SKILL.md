---
name: gitring
description: Work through gitring when many agents or people change one repository at the same time. Use it when the gitring tools are in your tool list, or when the user names gitring. Send a plan first. Apply each change request. Run the tests. Then ask for a merge. gitring is where the work merges.
---

# Work through gitring

gitring lets many agents change one repository at the same time.
It checks your plan against the 20 nearest active plans.
It sends change requests, not rejections.
It runs the tests and merges the work.

## When to use gitring

Use gitring when the user names gitring or a gitring project.
Use it when the gitring tools are in your tool list and the task changes a repository.
Use it when other agents or people change the same repository now.

Do not open a pull request for work that gitring merges.
When the user asks for a pull request, or no gitring project exists, use the normal way of the repository.
GitHub is an optional place that a project can import from or send merges to. gitring does it for you.

## Start and look

- **New project.** Call `gitring_templates` to see the starter templates. Call `gitring_create_project` to make a project from a template, empty, from files, or from a git URL. It can open the first task.
- **Get the files.** Call `gitring_clone` for a git clone command. You do not need a clone to read: use `gitring_read`, `gitring_search` and `gitring_diff`.
- **Ask why.** Call `gitring_why` for the reason a line is there. Call `gitring_history` for the changes of a file.

## The loop

1. **Find the task.** Call `gitring_intents` without a project to list your projects. Call it with a project id to list the open tasks. Ask the user which project to use when it is not clear.
2. **Send a plan before you write code.** Call `gitring_declare`. Give a real plan: the steps, the files, the functions (`path#name`) and one sentence of approach. Pick a task with `intentId`, or send a new one with `newIntent`. Set `agent.client` to `claude-code`.
3. **Choose how to work.** On a computer, use `mode: "git"`. The answer holds a remote and a token. Clone the remote, then commit and push with plain git. Without a computer, use the default mode `api`. Then use `gitring_read`, `gitring_list` and `gitring_write`.
4. **Give `workdir`.** Set it to the absolute path of the folder where you work. The plugin hook then sends change requests after each file edit.
5. **Work.** Report progress with `gitring_log`. In git mode, give `headSha` after a push. See the work near yours with `gitring_traffic`.
6. **Apply every change request.** An answer that starts with `GITRING CHANGE REQUEST` lists what to change. Every answer about your work copy can hold one. The answers of `gitring_read` and `gitring_list` put it after the file, in a second part. Apply each item in your next edits. Then call `gitring_ack` with the change request id and one line about what you changed. gitring checks your code. Code that still edits the lines of the request, or calls an old form of a function, keeps it open. Then change the code and call `gitring_ack` again. Do not stop your work.
7. **Test.** Call `gitring_check`. Fix each failure. Call it again until the tests pass.
8. **Ask for the merge.** Call `gitring_submit` with a short summary. gitring tests again. Then it merges the work, or a person must say yes first.
9. **When a person must say yes.** An answer that starts with `A PERSON MUST SAY YES` means the work waits. The answer holds the link where the person answers. Tell the user that the work waits, and give the link. Do not change the work copy: a change cancels the question. Call `gitring_wait` to wait for the answer, or do other work and call `gitring_status` later. When the person sent the work back, the answer holds a change request. Apply it, then call `gitring_submit` again.
10. **When main moved.** A change request can say that main moved. Call `gitring_update`. In api mode, read the named files again. In git mode, run the git commands in the answer. Then test and submit again.
11. **When you wait.** When you wait for a merge, a person, or other agents, call `gitring_wait` instead of a sleep. It answers as soon as news arrives. News is a change request, a move of main, the answer of a person, or a new status. Else it answers after 25 seconds (50 at most).

## Rules

- Send the plan first. A late plan gives late change requests.
- Never push to the main branch yourself. gitring merges.
- Never ignore a change request. Apply it, then confirm it.
- Never sleep to wait. Call `gitring_wait`.
- When the conflict check says "a person decides", tell the user and wait.
- Never say yes to your own work. gitring has no tool for it, and a person must answer.
- Reuse your `agentId` in later calls of `gitring_declare`.
- A person can use the `gitring` command line (`gitring watch`) and the inbox of the app.
- Keep the token of your work copy secret. Do not write it into a file.

## If a tool fails

- The error says the project is unknown: ask the user for the project id.
- The error says you need the member role: ask an owner of the project to add you.
- The error says that the work copy belongs to another person: use your own work copy. Send a plan with `gitring_declare`.
- The error says that gitring restarted the project: follow the words of the error. For some calls, look with `gitring_status` or `gitring_intents` before you send the call again.
- The gitring tools are not in your tool list: tell the user to connect gitring. In Claude Code, the command is `/mcp`.
