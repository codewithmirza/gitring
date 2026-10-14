# src/directory/oauth-store

The OAuth 2.1 server for MCP clients and the gitring command line. `OAuthStore` is a chain of classes. Each layer adds one area and builds on the layer before it. `src/directory/oauth.ts` is the front door: it adds the token endpoint, revocation and grants, and it re-exports every public name.

| File | What it is for |
|---|---|
| `constants.ts` | Lifetimes, caps, scopes and the SQL tables. |
| `types.ts` | Clients, pending requests, pending device sign-ins, rows and answers. |
| `rules.ts` | Pure rules: scopes, redirect URIs, MCP resources, the audience of a token, small helpers. |
| `base.ts` | The base layer: SQL handle, clock, table upgrades, removal of old rows. |
| `clients.ts` | Client registration and client ID metadata documents. |
| `authorize.ts` | The authorization request, the grant and the single-use code. |
| `issue.ts` | Client authentication and the making of access and refresh tokens. |
| `devices.ts` | The device authorization grant (RFC 8628). |

Only SHA-256 hashes of codes and tokens are stored.
