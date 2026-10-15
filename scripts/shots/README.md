# scripts/shots

The parts of `node scripts/shots.mjs`, the tool that gives the design agent eyes. The tool shoots every screen of gitring in every theme and size, with real agents at work in the project. Read `docs/design/README.md` to see how a person or an agent uses the result.

| File | What it is for |
|---|---|
| `args.mjs` | Reads the flags (`--only`, `--themes`, `--sizes`, `--out`, `--full`, `--no-start`, `--waitlist`) and the environment. |
| `server.mjs` | Builds the app when it is old, starts the local gitring on free ports (with the waitlist gate on for `--waitlist`), finds its address and key, and stops it. |
| `browser.mjs` | Starts a real Chromium (the same way as the video recorder) and gives a page a virtual passkey. |
| `account.mjs` | Signs up a test person with the passkey, and sets the theme before a page loads. |
| `seed.mjs` | Makes a project with real activity: the story of `scripts/meet.mjs`, a question for the person, and three more agents at work. |
| `screens.mjs` | The list of screens: the route of each, and the clicks that bring it into the state that a person sees. |
| `capture.mjs` | Opens one screen, waits for its content, moves the pointer away, checks the theme and the sign-in, and saves the pictures. |
| `inspect.mjs` | Measures a page: contrast, small targets, sideways scroll, type sizes, code names, long sentences, focus rings. |

## What a run writes

- `tmp/shots/<screen>-<theme>-<size>.png`: one picture for each screen, theme (`day`, `dusk`, `night`) and size (`desktop` 1440x900, `phone` 390x844). With `--full`, a tall `-full.png` too.
- `tmp/shots/index.json`: one record for each shot: screen, path, route, theme, size, `ok` or the `error`, and a short summary of the checks.
- `tmp/shots/details/<name>.json`: the full measurements of one shot.

The folder `tmp/` is not in git. The key of the run is never written to a file and never printed.

## Rules for this folder

- A screen step acts like a person: it clicks, types and presses keys. It does not call the API. Only `seed.mjs` calls the API, and it does so as a person or as an agent would.
- A screen that fails to render is a record with an error. It never stops the run.
- Add a screen in `screens.mjs`. Give it a phase: `out` (signed out), `empty` (a new person with no project), `project` (with the seed) or `story` (signed out, with the waitlist gate on and motion allowed: the scroll story of the landing page).
- The screens of the landing story (`landing-story-000` to `landing-story-100`) need the gate of the waitlist, so the tool shoots them only with `--waitlist`, and with that flag it shoots nothing else. Each screen scrolls the box of the page (`.wl`) to a share of the story and waits until the engine has caught up.
