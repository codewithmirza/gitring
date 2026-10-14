# src/directory

The Directory is one Durable Object for the whole deployment. It knows people, sign-ins, projects, roles and the sealed settings of the sign-in providers. The HarborMaster of each project holds the project state. The Directory only knows that the project exists.

| File | What it is for |
|---|---|
| `directory.ts` | The front door. `Directory` is the last class of the chain in `layers/`. It re-exports the public types. |
| `layers/` | The chain of classes that make the Directory. Start with `layers/README.md`. |
| `schema.ts` | The SQL tables of the Directory. |
| `constants.ts` | Lifetimes, limits for each person and GitHub headers. |
| `types.ts` | Answers that other files import, database rows and one-time states. |
| `helpers.ts` | Small pure functions: name clean-up, URL checks, the shape of a GitHub token. |
| `crypto.ts` | Web Crypto helpers: random tokens, hashes, sealed values and the GitHub App token. |
| `oauth.ts` | The OAuth server for MCP clients. The front door of `oauth-store/`. |
| `oauth-store/` | The layers of the OAuth server. Start with `oauth-store/README.md`. |
| `device.ts` | The device grant for the command line: the code alphabet and the limits. |
| `passkeys.ts` | The WebAuthn checks: make a passkey and check a sign-in. No storage. |
