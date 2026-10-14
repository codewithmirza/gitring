# How the design agent reviews a screen

A review has two parts: what the agent **sees** (real screenshots of the running app) and what it **checks** against `docs/design/INTENT.md`. A review never works from the code alone, because "the code is right" is not "the screen is good".

## Get the real screens

Run `node scripts/shots.mjs`. It starts a local gitring, signs in with a test passkey, makes a project with real activity, and saves one PNG for each screen, theme and width in `tmp/shots/` (the folder is not in git). Read the PNGs with an image viewer. Then run the same script after each change and compare.

## The checks

For each screen, in this order. Give each a score of 0 (broken), 1 (weak), 2 (good).

| # | Check | What to look at |
|---|---|---|
| 1 | One purpose | A stranger can say what the screen is for in 5 seconds. One title, one main action. |
| 2 | Hierarchy | The eye lands on the main thing first. At most four type sizes. Quiet things look quiet. |
| 3 | Real material | A real diff, test result, preview or number, with its source. No filler, no fake data. |
| 4 | States | Empty, loading, error, very long names, 200 rows, a slow network. Each state has a design and one action. |
| 5 | Phone | 320 px and 390 px wide. Touch targets, no sideways scroll, the main action in reach of the thumb. |
| 6 | Keyboard and screen reader | Tab order, visible focus, labels, live regions for changes that arrive by themselves. |
| 7 | Themes | Day, Dusk, Night. Contrast, borders and shadows that survive in each. |
| 8 | Motion | Moves only to show what changed. Nothing loops. Reduced motion is calm. |
| 9 | Words | STE. Plain names. The same word for the same thing in button, toast and history. No code name shown to a person. |
| 10 | Point of view | Not a zombie UI (see the list in INTENT.md). A clear choice that only gitring would make. |
| 11 | Raise the ceiling | Does the screen use one of gitring's own ideas (map, replay, why on a line, the answer where the person is)? |

## The report

Save a review as `docs/design/reviews/YYYY-MM-DD-<topic>.md` with these parts:

1. **Verdict** in two sentences: what is strong, what is the biggest problem.
2. **Score table**: one row for each screen, one column for each check.
3. **Findings**, most severe first. Each has: the screen and state, a severity, what is wrong in one sentence, why a person cares, the fix in one sentence, and the file to change.
   - **S1 blocks**: a person cannot finish the job, or the screen lies, or it breaks on a phone.
   - **S2 hurts**: slow, confusing, or inaccessible, but the job can be done.
   - **S3 polish**: a rough edge that a careful person sees.
4. **Opportunities**: up to three places where a gitring idea can replace a generic pattern.
5. **Not changed**: what looks good, so nobody breaks it.

## Edit after the build

The agent does not stop at the report. The loop is:

1. Review and write the report.
2. Fix the S1 and S2 findings, one small change at a time. Use design tokens and components that exist. Add a component only when two screens need it.
3. Run `node scripts/shots.mjs` again and look at the new PNGs. A fix that is not seen is not done.
4. Run `npm run typecheck` and the web tests. Fix what the change broke.
5. Write what changed at the end of the report ("After"), with the before and after PNG names.

Do not change behavior, API fields or stored data to fix a look. If a finding needs a behavior change, write it as a task for a person.
