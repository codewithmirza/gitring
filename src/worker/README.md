# src/worker

The Worker is the front door of gitring. It answers every request: the MCP servers for agents, the REST API, live sockets, previews, hooks, sign-in pages, and the web app. Every project has an owner and members (the Directory). Public projects can be watched by anyone. Acting on a project needs the member role. Settings and reset need the owner role.

## The route map

| Path | Answered by |
|---|---|
| `/mcp`, `/mcp/github`, `/mcp/readonly` | The MCP servers (`mcp-entry.ts`, then `mcp.ts` or `mcp-github.ts`). OAuth token or personal API key. |
| `/api/*` | REST for the web app and other apps (`routes/`). Session cookie or API key. |
| `/ws/:p` | The WebSocket of a project (`routes/live.ts`). |
| `/preview/:p/:ref/*` | The live preview of main or a work copy (`routes/live.ts`). |
| `/hooks/*` | Inbound hooks: a key, GitHub, Slack, Claude Code (`routes/hooks.ts`). |
| `/auth/*`, `/setup` | Sign-in with a passkey, GitHub or Google, and the owner's setup page (`auth.ts`). |
| `/oauth/*`, `/device` | The OAuth server for MCP clients and the command line (`oauth.ts`, `device.ts`). |
| Everything else | The web app (static assets). |

## The files

| File | What it is for |
|---|---|
| `index.ts` | The entry point that wrangler loads. It re-exports the Durable Object classes and has the fetch handler. |
| `app.ts` | Builds the Hono app and mounts the routes. The order of the lines is the order of the routes. |
| `request-guard.ts` | The first middleware: limits, who is calling, safe default headers. |
| `http.ts` | Helpers of the route files: the error class, the project id check, the role check. |
| `routes/` | The REST routes, one file for each area. Start with `routes/README.md`. |
| `github-tools/` | The tools of the GitHub-compatible MCP endpoint. Start with `github-tools/README.md`. |
| `env.ts` | The bindings, variables and secrets that the Worker gets. |
| `auth.ts` | The front door of sign-in: re-exports who-is-calling and the page helpers, mounts the auth routes. |
| `principal.ts` | Finds who is calling: session, API key, OAuth token or operator key. |
| `auth-kit.ts` | The cookies of gitring and the origin of a request. |
| `pages.ts` | Server pages: the page shell with its policy, and the GitHub App setup pages. |
| `sign-in-page.ts` | The sign-in buttons of a server page, with the passkey script. |
| `sign-in-routes.ts` | Sign-in with GitHub or Google, sign-out and `/api/me`. |
| `passkey-routes.ts` | Passkeys: make an account, add, sign in, rename, remove. |
| `setup-routes.ts` | The owner's setup page, and the privacy and terms pages. |
| `legal.ts` | The text of the privacy policy and the terms. |
| `oauth.ts` | The OAuth routes for MCP clients. |
| `device.ts` | The device grant routes for the command line. |
| `cli.ts` | Which REST routes the command-line token may call, and when its answers count. |
| `github.ts` | The routes that list GitHub repositories and guess a new project. |
| `waitlist.ts` | The waitlist routes and the owner page. |
| `gate.ts` | The waitlist gate: who reaches which paths. |
| `csrf.ts` | The cross-site check for browser sessions. |
| `limits.ts` | Rate limits for each kind of request. |
| `roles.ts` | The role of a person on a project, cached for a short time. |
| `projects.ts` | How a project is made. Shared by REST and MCP. |
| `push.ts` | Web Push: an empty message that tells the app to open the inbox. |
| `history-routes.ts` | The REST routes for history questions (why, history, search, compare). |
| `mcp-entry.ts` | Answers every `/mcp` request: limits, challenge, scope check, then the MCP server. |
| `mcp.ts` | The gitring tool set for agents. |
| `mcp-kit.ts` | How an MCP tool is defined, registered and checked. |
| `mcp-approval.ts` | A yes or no question to a person, asked from inside the agent chat. |
| `mcp-projects.ts` | The MCP tools to create a project, list templates and clone. |
| `mcp-history.ts` | The MCP tools for history questions. |
| `mcp-github.ts` | The GitHub-compatible tool set. It joins the files of `github-tools/`. |
