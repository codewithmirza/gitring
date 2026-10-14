# Run gitring in your own Cloudflare account

This page shows how to deploy gitring to your own Cloudflare account. You use your own tokens and your own sign-in apps. The repository has no value of the account of its authors.

To try gitring first with no Cloudflare account, see "Try it in 5 minutes" in the [README](../README.md).

## What you need

| Need | Why |
|---|---|
| A Cloudflare account on the **Workers Paid** plan | Artifacts, Durable Objects with SQLite, Dynamic Workers and Containers all need it. |
| Node.js 22 or later, npm 10 or later, and `git` | The build and the scripts. |
| Access to **Artifacts** | It stores the git repositories of all projects. Artifacts is in open beta. |
| Access to **Workers AI** | It runs the conflict-check model and the built-in agents. |
| **Dynamic Workers** (Worker Loader) | It runs the tests of the `worker` runner and the live previews. It is in open beta for paid Workers accounts. |
| **Containers** | One container for each work copy runs the tests of the `container` runner. You do not build an image. |

You do not need Docker. The Cloudflare image of the containers is ready made (see `wrangler.jsonc`).

If one service is not on your account, the deploy tells you in an error. Ask Cloudflare for access, or read the page of that service in the Cloudflare documentation.

## Cost warnings

- A deployment bills your account. Workers Paid has a monthly base price. Artifacts operations and storage, Workers AI, Dynamic Workers and Containers bill by use.
- A load run (`npm run load`) costs real money. It asks for `--yes` before it starts.
- A built-in agent calls Workers AI many times. Two limits stop a run: `AI_AGENTS_PER_HOUR` and `AI_AGENTS_PER_USER_HOUR` in `wrangler.jsonc`. Lower them if you want a smaller bill.
- Test containers have an hourly budget too: `CHECK_RUNS_PER_HOUR` and `CHECK_RUNS_PER_OWNER_HOUR`.
- Set a spend alert in the Cloudflare dashboard before you let agents loose on it.
- The README has a section "Limits" with the cost of one merged task.

## Step by step

### 1. Get the code and install

```bash
git clone https://github.com/codewithmirza/gitring.git
cd gitring
npm ci
```

`npm ci` installs the exact versions of `package-lock.json`. It was tested with Node.js 22 and npm 10. If npm complains about its version, run `npx npm@11 ci`.

### 2. Sign in to Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

`whoami` must show your account. If you have more than one account, set `CLOUDFLARE_ACCOUNT_ID` first. Put it in your shell, not in a file of the repository.

- macOS or Linux: `export CLOUDFLARE_ACCOUNT_ID=<your account id>`
- Windows PowerShell: `$env:CLOUDFLARE_ACCOUNT_ID = "<your account id>"`

For a computer with no browser (CI), make an API token with Workers edit rights. Put it in `CLOUDFLARE_API_TOKEN`.

### 3. Pick your names (optional)

`wrangler.jsonc` has no value of the account of the authors. These names are only names. They are free in your account:

| Value | Where | Default |
|---|---|---|
| The Worker name | `name` | `gitring`. Your address is `https://gitring.<your-subdomain>.workers.dev`. |
| The Artifacts namespace | `artifacts[0].namespace` and `vars.ARTIFACTS_NAMESPACE` | `gitring`. Change both to the same new name. |
| The rate-limit ids | `ratelimits[].namespace_id` | `4101` to `4107`. They are only ids in your account. |

Check the Artifacts namespaces of your account:

```bash
npx wrangler artifacts namespaces list
```

Suppose the namespace `gitring` is not in the list, and a project fails with a namespace error. Then make the namespace in the Cloudflare dashboard (Artifacts) with the same name. Deploy again.

### 4. Deploy

```bash
npm run deploy
```

This builds the app (`vite build`) and runs `wrangler deploy`. Wrangler prints the address of your Worker. Write it down. The first deploy also makes the Durable Object classes and the container class.

### 5. Make the secrets

`npm run setup` writes `.dev.vars` with new random values. Give it the owners of your gitring. An owner is `google:<your email>`, `github:<your login>` or `user:<id>`:

```bash
npm run setup -- --owner google:you@example.com
npx wrangler secret bulk .dev.vars
```

The file `.dev.vars` is in `.gitignore`. Do not commit it, and do not paste its values in an issue.

If you prefer, set each secret by hand. Each command asks for the value:

```bash
npx wrangler secret put GITRING_SECRET
npx wrangler secret put GITRING_SETUP_TOKEN
npx wrangler secret put GITRING_OWNERS
npx wrangler secret put GITRING_KEY
```

Every secret and every variable has a one-line note in `.dev.vars.example`.

### 6. Check that it runs

```bash
curl https://<your-worker>/api/health
```

The answer must start with `{"ok":true`. It also shows whether Workers AI is bound (`"ai":true`) and which sign-in methods are on.

Then run the smoke test. It makes a project from a template. It runs two scripted agents with a conflict and lands both changes. It prints PASS or FAIL:

```bash
node scripts/smoke.mjs https://<your-worker> <your GITRING_KEY>
```

The key is the `GITRING_KEY` line of `.dev.vars`. The script never prints it. A good run ends with `RESULT: PASS`. The script archives its test project at the end.

The smoke test needs no Workers AI. Without it, fixed rules make the conflict check. To see the model work, open the app, make a project, and start a built-in agent.

### 7. Open the setup page

Open `https://<your-worker>/setup?token=<GITRING_SETUP_TOKEN>`. The token is in `.dev.vars`. Passkeys work at once, with no setup: open the app and choose to create an account with a passkey.

The setup page adds the optional sign-in methods in the next two sections.

## Optional: sign in with Google

1. Open the [Google Cloud console](https://console.cloud.google.com/apis/credentials) and make a project, or choose one.
2. Set up the OAuth consent screen. For a trial, the type "External" in test mode is enough. Add your own Google account as a test user.
3. Make an OAuth client ID of the type **Web application**.
4. Add this **Authorized redirect URI**. Use your own address, with no slash at the end: `https://<your-worker>/auth/google/callback`
5. Copy the client ID and the client secret.
6. In `/setup`, paste both values in the Google part and save. gitring seals the secret with `GITRING_SECRET`.

For a local run with `npm run dev`, add the redirect URI of that address too (`http://localhost:<port>/auth/google/callback`). The `/setup` page shows the exact URI.

## Optional: sign in with GitHub, and the GitHub App

You do not make a GitHub OAuth app by hand. In `/setup`, one click makes a **GitHub App** for your Worker. GitHub shows the app before it creates it.

The app gives sign-in, repository lists and imports, issue and push webhooks, and GitHub sync. These URLs are set for you:

| Setting | Value |
|---|---|
| Callback URL (sign-in) | `https://<your-worker>/auth/github/callback` |
| Setup redirect | `https://<your-worker>/setup/github/callback` |

GitHub sync is off for every new project. gitring sends no code to GitHub until an owner turns it on.

For a plain repository webhook with no app, set `GITHUB_WEBHOOK_SECRET`. The Connect page of a project shows the URL.

## Optional: Slack, push notifications, contact address

| Secret | What it does |
|---|---|
| `SLACK_SIGNING_SECRET` | Turns on the Slack slash command. The Connect page shows its URL. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push for the inbox. Make the keys with `npx web-push generate-vapid-keys`. |
| `GITRING_CONTACT` | The contact address on the privacy and terms pages. |

## Workers AI, Containers and the loader

- **Workers AI**: the binding `AI` is in `wrangler.jsonc`. The default models are in `AGENT_MODELS`. Change the list if your account does not have a model.
- **Dynamic Worker Loader**: the binding `LOADER` (`worker_loaders`). It runs the `worker` test runner and previews. It needs the Workers Paid plan.
- **Containers**: the class `Drydock` starts one container for each work copy. It runs the `container` test runner. Test containers have no direct Internet access. Set the runner in Settings → Tests of a project.
- **Artifacts**: the binding `ARTIFACTS` points to your namespace. `remote: true` makes `npm run dev` use the real service of your account.

## Deploy with Workers Builds instead

Push the repository to your own Git host. In the Cloudflare dashboard, make a Workers Build for it: production branch `main`, build command `npm run build`, deploy command `npx wrangler deploy`. Set the secrets in the dashboard (Settings → Variables and Secrets).

## Test your changes

```bash
npm run typecheck
npm test
```

These two commands need no Cloudflare account. `npm run load` and `npm run bench` are in the README. For a load run, make a second copy with its own Worker name and namespace. Then your live deployment stays safe. The README section "Run your own gitring" says how.

## Problems

| Sign | Cause and fix |
|---|---|
| `npm ci` fails on the npm version | Run `npx npm@11 ci`. |
| The deploy says that a binding is not available | Your account lacks that service or the Paid plan. See "What you need". |
| `/api/health` says `"ai":false` | The `AI` binding is not there. Do not delete it from `wrangler.jsonc`. |
| `/setup` says that the token is wrong | Use the exact `GITRING_SETUP_TOKEN` value. Set it again with `wrangler secret put`. |
| A passkey does not register | Use the real address of your Worker, with `https`. On your own computer, use `localhost`, not `127.0.0.1`. |
| The smoke test says `401` or `403` | The token is not the `GITRING_KEY` secret. Send the key, not the setup token. |
| Google says `redirect_uri_mismatch` | The redirect URI differs from the one of the page. Copy it again, with no slash at the end. |

## Remove it

```bash
npx wrangler delete
```

This deletes the Worker. Delete the Artifacts repositories and the namespace in the dashboard if you do not need them.
