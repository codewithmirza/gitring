# src/directory/layers

The `Directory` Durable Object is a chain of classes. Each layer adds one area and builds on the layer before it. `src/directory/directory.ts` is the last link: `class Directory extends DirectoryPasskeyAccounts {}`. Read the files in this order. A layer calls only the layers above it in this list.

| File | Class | What it adds |
|---|---|---|
| `store.ts` | `DirectoryStore` | The SQL handle, the OAuth store, sealed config values and one-time states. The base of every other layer. |
| `meters.ts` | `DirectoryMeters` | Counters of use for each project and month, and the one-hour budgets of built-in agents and test runs. |
| `people.ts` | `DirectoryPeople` | Owners of the deployment, the profile of a person, the waitlist gate and the allow list. |
| `credentials.ts` | `DirectoryCredentials` | Browser sessions, personal API keys and the OAuth calls of MCP clients. |
| `projects.ts` | `DirectoryProjects` | The project registry, roles and members. |
| `prefs-push.ts` | `DirectoryPrefsPush` | Preferences of a person and push notifications for the inbox. |
| `github-app.ts` | `DirectoryGithubApp` | The GitHub App (made from a manifest) and the Google client. |
| `github-tokens.ts` | `DirectoryGithubTokens` | The GitHub user token of a person: store, refresh, revoke. |
| `github-repos.ts` | `DirectoryGithubRepos` | Repository access: app tokens, what a person may do on GitHub, and the webhook delivery log. |
| `sign-in.ts` | `DirectorySignIn` | Sign-in with GitHub or Google. |
| `passkey-accounts.ts` | `DirectoryPasskeyAccounts` | Accounts with passkeys: make, add, sign in, rename, remove. |

A method that another layer calls is `protected`. A method that only its own layer calls is `private`. The Worker calls the public methods through Durable Object RPC.
