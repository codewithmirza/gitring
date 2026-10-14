# local: gitring on your own computer

`npm run dev:local` builds the web app and runs gitring on your computer. You need no Cloudflare account. Each start deletes the data of the earlier run.

- `start.mjs`: the command that starts it. It builds the test version of Artifacts (real git, in `tmp/local`) and starts it. Then it starts `wrangler dev` with `wrangler.local.jsonc` and new random keys. It prints the key for this run.
- `worker.ts`: the entry of the local Worker. The Worker is the real one. Only the Artifacts binding of the project coordinator is new: it sends each call to the test version of Artifacts.

To try the run, use `npm run smoke` or `npm run meet` with `GITRING_URL=http://localhost:8787` and the key that `start.mjs` prints (see `scripts/README.md`).
