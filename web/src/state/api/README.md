# state/api

The project client. Import from `../api` (the front door), not from this folder.

- `types.ts`: the inputs, the results and the `HarborClient` interface.
- `harbor-client.ts`: `LiveHarbor`, one method for each request to the Worker, with caches.
- `fetch-state.ts`: loads the state of one project and checks the reply.
- `live-socket.ts`: the WebSocket of one project, with reconnect, ping and pause.
- `boot.ts`: boots the person, the project list and the project state; holds the one live client.
