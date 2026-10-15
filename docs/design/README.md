# The design agent of gitring

The design agent is the editor of every screen. Many agents build gitring fast. Someone must keep one point of view, and must look at the real screens, not only at the code. This agent does that.

It lives in `.claude/agents/gitring-design.md`. It reads the files of this folder. It has eyes: `node scripts/shots.mjs` gives it a picture of every screen.

## Start in one minute

Ask Claude Code in this repository. Name the agent:

- `Use the gitring-design agent to review the Tasks screen.`
- `Use the gitring-design agent to review the whole app on a phone.`
- `Use the gitring-design agent to fix the S1 and S2 findings of the latest review.`
- `Use the gitring-design agent to write the empty state of History in plain words.`

The agent runs the shots, looks at the pictures, scores the screens, and writes the review. A review changes no code. A fix is a second, separate request.

## The commands

```bash
node scripts/shots.mjs                                  # every screen, 3 themes, 2 sizes (about 25 minutes)
node scripts/shots.mjs --only tasks,approve             # two screens (about 2 minutes: the start and the seed take most of it)
node scripts/shots.mjs --themes night --sizes phone     # one theme, one size
node scripts/shots.mjs --full                           # also a tall picture of each whole page
node scripts/shots.mjs --help                           # all flags
```

The tool builds the app when it is old. It starts gitring on free ports, signs up a test person with a virtual passkey, and makes a project with real agents at work. Then it saves the pictures. It stops everything that it started. It never prints or saves the key of the run.

To shoot an app that runs already: `GITRING_URL=http://localhost:8787 GITRING_KEY=<key> node scripts/shots.mjs --no-start`. Use `localhost`, not `127.0.0.1`: passkeys need a host name.

The tool needs Node 22, the dependencies of the repository (`npm ci`), `git`, and a Chromium. It finds the Chromium of Playwright, or the newest one in the Playwright folder, or Chrome. It does not need a Cloudflare account.

## What the tool writes

| Path | What it holds |
|---|---|
| `tmp/shots/<screen>-<theme>-<size>.png` | One picture. Themes: `day`, `dusk`, `night`. Sizes: `desktop` (1440x900), `phone` (390x844). |
| `tmp/shots/index.json` | One record for each picture: screen, path, route, theme, size, `ok` or `error`, and a summary of the checks. |
| `tmp/shots/details/<name>.json` | The measurements of one picture: text with low contrast, small touch targets, sideways scroll, type sizes, code names, long sentences, all-caps text, focus rings. |

`tmp/` is not in git. The measurements are facts to point at. They do not replace looking: a number says where to look, and the picture says what is wrong.

## The loop

1. **Shoot.** Run the tool. Open the pictures of the screen.
2. **Score.** Give each screen 0, 1 or 2 on the 11 checks of `CRITIQUE.md`.
3. **Write.** Save the review in `reviews/YYYY-MM-DD-<topic>.md`. Every finding has a screen, a state, a severity, a fix and a file.
4. **Fix.** A person or the agent fixes the S1 and S2 findings, one small change at a time. A change uses design tokens and components that exist.
5. **Shoot again.** A fix that nobody has seen is not done. Compare the old and the new picture.
6. **Check.** `npm run typecheck` and `npx vitest run test/web` must pass.
7. **Close.** Write an "After" part at the end of the review, with the picture names before and after.

## Where things are

| File | What it is for |
|---|---|
| `INTENT.md` | What we make, for whom, the point of view, and what we refuse to look like. Read it first. |
| `CRITIQUE.md` | The 11 checks, the severities and the report format. |
| `SCREENS.md` | Every screen: its route, its one purpose, its one action, what a person must see first, its states. |
| `reviews/` | The reviews, one file for each pass. |
| `landing-story.md` | The plan of the scroll story on the landing page for signed-out visitors: chapters, copy, geometry, files, risks. |
| `../../scripts/shots/README.md` | How the tool works, and how to add a screen to it. |
| `../../.claude/agents/gitring-design.md` | The agent. |

## Where the idea comes from

Mirza asked for this agent after the talk "How to scale intent, quality, and artistry with AI" by Katie Dill of Stripe. The ideas that we use are these. Scale craft by writing design intent into the workflow of the AI. Do not mistake "done" for "good". Keep a clear point of view, so that the product does not become generic "zombie UI". Edit after the build. Use AI to invent new interfaces, not only to make the old ones faster. The transcript of the talk was not available to us. We took the ideas from its public summaries and from its description, so the words of this folder are ours, not the words of the speaker.
