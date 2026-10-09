// A very small test API. Bearing runs every tests/*.test.js file in an isolate.
const tests = [];
let currentFile = "";

export function __setFile(path) {
  currentFile = path;
}

export function test(name, fn) {
  tests.push({ file: currentFile, name, fn });
}

export function expect(actual) {
  const check = (ok, msg) => {
    if (!ok) throw new Error(msg);
  };
  const api = (negate) => ({
    toBe: (v) => check(Object.is(actual, v) !== negate, `expected ${String(actual)} ${negate ? "not " : ""}to be ${String(v)}`),
    toEqual: (v) => check((JSON.stringify(actual) === JSON.stringify(v)) !== negate, "values are not equal"),
    toContain: (v) => check(actual.includes(v) !== negate, `expected value ${negate ? "not " : ""}to contain ${String(v)}`),
    toMatch: (re) => check(re.test(actual) !== negate, `expected value ${negate ? "not " : ""}to match ${re}`),
    toBeTruthy: () => check(Boolean(actual) !== negate, "expected a truthy value"),
    toBeFalsy: () => check(!actual !== negate, "expected a falsy value"),
  });
  return { ...api(false), not: api(true) };
}

export async function __run() {
  const results = [];
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn();
      results.push({ file: t.file, name: t.name, ok: true, ms: Date.now() - start });
    } catch (err) {
      results.push({ file: t.file, name: t.name, ok: false, error: String(err.message || err), ms: Date.now() - start });
    }
  }
  return results;
}
