# src/harbor/support: shared helpers of the project coordinator

Pure functions, constants and types that the layers in `../master/` share. None of these files reads or writes the database of a project.

- `access.ts`: the hook key, the git pull command, and the state filter for viewers.
- `brief-rank.ts`: ranks the files of main for the brief that an agent gets.
- `constants.ts`: the fixed numbers, limits and plain texts, with the reason for each.
- `container-run.ts`: turns the result of a test container, or an empty test budget, into a check run.
- `digest.ts`: the approval hash and the format of older hashes.
- `helpers.ts`: small helpers for names, paths, pairs, empty values and one-line error texts.
- `seed.ts`: turns the files of an uploaded folder into commit changes.
- `settings-rules.ts`: cleans the settings that a person sends.
- `types.ts`: the types of the project coordinator, and the error class that ends a train.
- `words.ts`: plain words for people and agents (feed, tool results, wait events, Slack).
