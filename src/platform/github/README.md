# src/platform/github

GitHub as an optional source and an optional copy. gitring never needs GitHub to work. These files talk to the GitHub REST API only.

| File | What it is for |
|---|---|
| `api.ts` | A small GitHub REST client: tokens, pagination and conditional requests. |
| `repos.ts` | The repositories that a person can import, and the test-command guess for one of them. |
| `tarball.ts` | Reads one commit of a GitHub repository as files, to import a private repository. |
| `sync.ts` | Sends main to GitHub with the Git Data API: commits, or a pull request. |
| `upstream.ts` | Brings GitHub changes into main, file by file. |
