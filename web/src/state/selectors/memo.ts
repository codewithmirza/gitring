/**
 * Two helpers that save work in a selector: a memo on argument identity and a cached id map.
 * Every other file in this folder uses them. Never read the store here: these functions take plain values.
 */
export function memo<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let lastArgs: A | null = null;
  let last: R;
  return (...args: A) => {
    if (lastArgs && lastArgs.length === args.length && args.every((a, i) => Object.is(a, lastArgs![i]))) return last;
    lastArgs = args;
    last = fn(...args);
    return last;
  };
}

const idCache = new WeakMap<object, Map<string, unknown>>();
export function byId<T extends { id: string }>(arr: T[]): Map<string, T> {
  let m = idCache.get(arr) as Map<string, T> | undefined;
  if (!m) {
    m = new Map(arr.map((x) => [x.id, x]));
    idCache.set(arr, m);
  }
  return m;
}
