# src/worker/github-tools

The tools of the GitHub-compatible endpoint (`/mcp/github`). An agent or a plugin that works with the GitHub MCP server can use gitring when its owner changes one URL. The tools keep the names and the argument names of the GitHub tools. `src/worker/mcp-github.ts` joins the four tool files in this order: read, write, pulls, issues.

| File | What it is for |
|---|---|
| `answers.ts` | Argument schemas, answer helpers, paging and small formatters that every tool file uses. |
| `branches.ts` | A branch name is a work copy of the caller. Open a project, find the branches of the caller, write to a branch. |
| `pulls.ts` | Which work copies count as pull requests, their numbers and the state that each one shows. |
| `tools-read.ts` | `get_me`, `search_repositories`, `get_file_contents`, `get_repository_tree`, `list_branches`, `list_commits`, `get_commit`, `search_code`. |
| `tools-write.ts` | `create_branch`, `push_files`, `create_or_update_file`, `delete_file`. |
| `tools-pulls.ts` | `create_pull_request`, `pull_request_read`, `list_pull_requests`, `merge_pull_request`, `update_pull_request_branch`. |
| `tools-issues.ts` | `list_issues`, `issue_read`, `issue_write`. |

## How a GitHub idea maps onto gitring

| GitHub | gitring |
|---|---|
| `repo` | The gitring project id. `owner` is accepted and ignored. |
| `main` | `main`. |
| Any other branch name | A work copy of the caller. The first write to a new name declares it. The name is in the plan text of the work copy: `GitHub branch "name"`. |
| `push_files`, `create_or_update_file`, `delete_file` | The write of `gitring_write`. The conflict check runs, and a change request comes back in the answer. Nothing writes to main. |
| `create_pull_request` | The submit of `gitring_submit`: the tests run first, then the merge queue. When a person must say yes, gitring asks that person (in the chat when the client can show a question). The answer says "waits for a person". |
| `merge_pull_request` | Reports the state of the merge and waits a short time. It never merges by itself and never skips the tests. gitring merges when the tests pass and the person said yes. |
| `update_pull_request_branch` | The update of `gitring_update`. |
| Issues | gitring tasks. |

A pull request number is the place of the work copy in the age order of all branch work copies of the project. A branch belongs to the caller who made it. Only that person (or an owner) can change its work copy, and only that person gets its change requests. The read tools bring them too, after the text of a file or above the GitHub-shaped JSON.
