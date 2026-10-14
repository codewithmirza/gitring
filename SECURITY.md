# Security

## Report a problem

You found a security problem in gitring? Do not open a public issue. Use the private report form of the repository (Security → Report a vulnerability). If it is off, write to the address on the privacy page of a gitring deployment. Or write to the owner of the repository.

Send the steps to repeat the problem. Send the version too (`/api/health` shows the build). Say what an attacker can do with it. We reply within 7 days. We fix confirmed problems as fast as we can. We tell you when the fix is out.

## What we protect

The README section "Security" lists the design. It has tokens bound to an address, sealed credentials, signed webhooks, a strict content policy, and rate limits.

## Your own deployment

- Keep `.dev.vars` and your secrets out of git. The `.gitignore` of the repository lists them.
- If a secret leaks, replace it. Run `npx wrangler secret put <NAME>` with a new value.
- Change `GITRING_SECRET` only when you must. gitring seals the sign-in credentials with it. After a change, you set up the sign-in apps again.
- Give the `GITRING_KEY` secret only to scripts that you trust. It acts as an owner on every project.
- Use a personal API key (Account → API keys) for each script. Revoke the keys that you do not use.
- Make the GitHub and Google sign-in apps in your own account. Do not share them with other deployments.
