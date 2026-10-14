# Help with gitring

Thank you for your help. gitring is MIT-licensed (see [LICENSE](LICENSE)). By a pull request you agree that your change has the same license.

## Set up

You need Node.js 22 or later, npm, and `git`. You need no Cloudflare account.

```bash
npm ci
npm run typecheck
npm test
npm run dev:local
```

`npm run dev:local` runs the whole product on your computer. See "Try it in 5 minutes" in the [README](README.md). To deploy to your own Cloudflare account, see [docs/SELF-HOST.md](docs/SELF-HOST.md).

## Before you open a pull request

1. Run `npm run typecheck` and `npm test`. Both must pass.
2. Add a test for each change in behavior. Tests are in `test/`.
3. Keep the style of the repository. The README, the docs and the messages of gitring use plain words (ASD-STE100). A sentence has at most 20 words. It has no "-ing" verb forms. `npm test` checks the README and the docs for this.
4. Do not add a secret, a token or an account id. Use `.dev.vars.example` to name a new variable, with a one-line note.
5. Keep each commit to one change. Write a plain subject line that says what the change does.

## Where things are

The README section "Project layout" names each folder. The page [docs/FAQ-JUDGES.md](docs/FAQ-JUDGES.md) maps the main ideas to files.

## Report a problem

Open an issue with the steps to repeat it, what you expected, and what happened. For a security problem, do not open an issue. Read [SECURITY.md](SECURITY.md).
