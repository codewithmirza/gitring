# state

What the web app knows and how it asks the Worker: the store, the requests and the derived views.

- `store.ts`: the project store, one reducer over the live events from the WebSocket.
- `api.ts`: the project client (front door of `api/`).
- `api/`: the types, the client, the live socket and the boot (see its README).
- `selectors.ts`: derived views of the project state (front door of `selectors/`).
- `selectors/`: one file for each derived view (see its README).
- `http.ts`: one place for fetch, errors, shared requests, caches and aborts.
- `format.ts`: formatting helpers and the plain words for statuses.
- `account.ts`: who is signed in, the projects they see, keys, members and project settings.
- `connections.ts`: the GitHub connection and the apps allowed through OAuth.
- `github.ts`: the person's GitHub repositories, guesses for a new project, and the GitHub sync.
- `projects.ts`: create or clone a project from any source.
- `approvals.ts`: which merges wait for the person who looks, and the words for them.
- `inbox.ts`: the inbox of the signed-in person across projects.
- `passkey.ts`: sign in and manage passkeys with WebAuthn.
- `signin.ts`: the addresses that start a sign-in, and the order of the choices.
- `waitlist.ts`: keep, change and take back the choice of a pack.
