# scripts: tools that you run by hand

These scripts help you run, check and load your own gitring. None of them is part of the product. The scripts that talk to a gitring (`smoke`, `meet`, `load`) read its address from `GITRING_URL` and a key from `GITRING_KEY`. No script prints the key.

## The files

- `setup.mjs`: makes `.dev.vars` with new random secrets for your own gitring. Run: `npm run setup -- --owner google:you@example.com` (add `--force` to replace an old file). Next steps: `docs/SELF-HOST.md`.
- `smoke.mjs`: a smoke test for a deployed gitring or the run on your computer. Two scripted agents change one function, and both merge. It prints PASS or FAIL for each check. Run: `npm run smoke` (or `node scripts/smoke.mjs <url> <token>`).
- `meet.mjs`: three scripted agents meet on one small shop project, and the script prints each real answer. With `--approval`, a third agent needs a person to say yes. Run: `npm run meet -- [--approval] [--wait SECONDS] [--keep]`.
- `meet-steps.mjs`: the three steps of the story that `meet.mjs` tells.
- `meet-tools.mjs`: what the steps use: API calls, the MCP agents that talk, and the waits for the state of the project.
- `meet-files.mjs`: the text of the files that the scripted agents write (the starting files are in `examples/shop/`).
- `load.mjs`: a load test for a deployed gitring. Many agents work at the same time through the real MCP endpoint. It costs money, so it needs `--yes`. Run: `npm run load -- --project <id> --agents 20 --tasks 3 --yes`.
- `load-agent.mjs`: one scripted agent of the load test: its own connection, and a few tasks one after the other.
- `load-lib.mjs`: the pure parts of the load test (options, the cost warning, seeded scheduling, percentiles, the report). The other scripts use `endpointOf` and `lastJson` from here.
- `load.d.mts`, `load-lib.d.mts`, `meet.d.mts`: the types of the files above, for the tests in `test/load/`.
- `palette.py`: prints the colors of the day, dusk and night themes as hex values, with their contrast ratios. Run: `python scripts/palette.py`.
- `shots.mjs`: screenshots of every screen for the design review (added by the design agent).

## Safe use

- `smoke.mjs` and `meet.mjs` make one private project and archive it at the end. `meet.mjs --keep` keeps it, so that you can look at it in the browser.
- `load.mjs` never makes a project. It makes new tasks and files in the project that you name. Use a project that you can throw away.
- `GITRING_URL` must start with `https://`. For a gitring on your own computer, `http://localhost` works too. The key goes over `http` only to `localhost`.
- The agents are scripted. None of these scripts tests a real model.

The tests of these scripts are in `test/load/` (`load-lib.test.ts`, `load-run.test.ts`, `meet-run.test.ts`). They run the scripts against the real Worker routes in one process.
