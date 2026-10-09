# Rules for agents

Many agents change this repo at the same time. Bearing coordinates them. Obey these rules.

## Work with Bearing

1. Declare your course first with `bearing_declare`. Name the plan, the files and the symbols that you will change.
2. Write code only after you declare your course.
3. Log after each meaningful step with `bearing_log`. Write one short sentence: what you did, and why.
4. Read each correction that you receive. Apply it, then continue your work.
5. Tell Bearing that you applied the correction. Use `bearing_ack`.
6. A correction does not stop your work. It changes your course.
7. Look at the traffic with `bearing_traffic` before you change a file that other agents change.
8. Run `bearing_check` before `bearing_submit`. If a check fails, fix the cause. Then run `bearing_check` again.
9. Submit with `bearing_submit` and a summary of one sentence.

## Change the code

- Do not edit the tests of other intents. Edit only the test files of your intent.
- Do not edit `harness/test.js`.
- Keep functions small. One function does one task.
- Keep the signature of an exported function, unless your intent changes it. If you change a signature, put the symbol in your course.
- Use relative links and form actions, for example `href="api/products"` and `action="./"`. Previews run under a path prefix.
- Do not add dependencies or a build step. Use plain ES modules.
- Do not use the network. Checks and previews run with no network access.
- Put CSS into the const of the page region that you change: `TOKENS`, `BASE`, `HEADER`, `SHELF`, `BOOK` or `FOOTER`.
- Escape text from readers and from data with `escapeHtml` before you put it into HTML.

## Test your work

- Run all tests with `node tests/run.mjs`. Run one file with `node tests/run.mjs tests/app.test.js`.
- Bearing writes the test files of your intent into your workspace. Make them pass.
- Write tests with the API in `harness/test.js`: `test`, `expect`, `toBe`, `toEqual`, `toContain`, `toMatch`, `toBeTruthy`, `toBeFalsy`, `toThrow` and `.not`.
- Keep `tests/app.test.js` green. All intents share it.
