/**
 * The project store: one reducer over the GitringEvent stream from the live WebSocket.
 *
 * Components read slices with useStore(selector). Updates share structure: the reducer keeps the
 * references of slices and items that did not change, and a new snapshot (after a reconnect) reuses
 * every item that is equal to the one the store has. So a component re-renders only when its slice
 * changes, and an event that changes nothing does not wake the subscribers at all.
 */
import { useRef, useSyncExternalStore } from "react";
import type { GitringEvent, ProjectState, RadarPair } from "../../../src/core/types";
import type { MeInfo, ProjectInfo, Role } from "../../../src/core/accounts";

export type DataMode = "boot" | "live";
export type ConnState = "connecting" | "open" | "reconnecting" | "offline";

export interface Ripple {
  id: number;
  files: string[];
  at: number;
}

export interface Pulse {
  id: number;
  a: string;
  b: string;
  at: number;
}

export interface StoreState {
  mode: DataMode;
  conn: ConnState;
  projectId: string;
  state: ProjectState | null;
  /** STE error text for the connection banner. */
  error: string | null;
  /** Merge ripples (changed files flash once). */
  ripples: Ripple[];
  /** Pulses (a ring pulses once when two pieces of work start to move closer). */
  pulses: Pulse[];
  events: number;
  lastEventAt: number;
  /** Who is signed in, and which sign-in providers exist (null until /api/me answers). */
  me: MeInfo | null;
  /** Projects the caller can see. */
  projects: ProjectInfo[];
  /** True after the first answers for the person and the project list (or their failure). */
  accountReady: boolean;
  /** The caller's role on the open project (null: unknown or no access). */
  access: Role | null;
}

const LOG_CAP = 500;
const CHECK_CAP = 400;
const NO_RIPPLES: Ripple[] = [];
const NO_PULSES: Pulse[] = [];

let seq = 1;
let snap: StoreState = {
  mode: "boot",
  conn: "connecting",
  projectId: "",
  state: null,
  error: null,
  ripples: NO_RIPPLES,
  pulses: NO_PULSES,
  events: 0,
  lastEventAt: 0,
  me: null,
  projects: [],
  accountReady: false,
  access: null,
};

const listeners = new Set<() => void>();
let notifyQueued = false;

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    listeners.forEach((l) => l());
  });
}

function set(patch: Partial<StoreState>) {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof StoreState)[]) {
    if (!Object.is(snap[k], patch[k])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  snap = { ...snap, ...patch };
  notify();
}

/* ───────────── structural sharing ───────────── */

/** Deep equality for JSON data: plain objects, arrays, strings, numbers, booleans and null. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, k) || !sameJson(ra[k], rb[k])) return false;
  }
  return true;
}

/** `next`, with the items of `prev` that are equal (by key and content); `prev` itself when nothing changed. */
export function shareList<T>(prev: T[], next: T[], key: (x: T) => string): T[] {
  if (prev === next) return prev;
  const old = new Map<string, T>();
  for (const x of prev) old.set(key(x), x);
  let changed = prev.length !== next.length;
  const out = next.map((x, i) => {
    const o = old.get(key(x));
    if (o !== undefined && sameJson(o, x)) {
      if (prev[i] !== o) changed = true;
      return o;
    }
    changed = true;
    return x;
  });
  return changed ? out : prev;
}

const byIdKey = (x: { id: string }) => x.id;
const pairKey = (p: { a: string; b: string }) => (p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`);

/**
 * A new snapshot of the same project, with the old references for everything that did not change.
 * When nothing changed, the old state object comes back (no subscriber wakes up).
 */
export function reconcile(prev: ProjectState, next: ProjectState): ProjectState {
  if (prev === next) return prev;
  if (prev.project.id !== next.project.id) return next;
  const shared: ProjectState = {
    ...next,
    project: sameJson(prev.project, next.project) ? prev.project : next.project,
    intents: shareList(prev.intents, next.intents, byIdKey),
    attempts: shareList(prev.attempts, next.attempts, byIdKey),
    agents: shareList(prev.agents, next.agents, byIdKey),
    corrections: shareList(prev.corrections, next.corrections, byIdKey),
    checks: shareList(prev.checks, next.checks, byIdKey),
    landings: shareList(prev.landings, next.landings, byIdKey),
    decisions: shareList(prev.decisions, next.decisions, byIdKey),
    ...(next.questions ? { questions: shareList(prev.questions ?? [], next.questions, byIdKey) } : {}),
    logs: shareList(prev.logs, next.logs, byIdKey),
    radar: shareList(prev.radar, next.radar, pairKey),
    files: shareList(prev.files, next.files, (f) => f.path),
    imports: shareList(prev.imports, next.imports, (e) => `${e[0]}\u0000${e[1]}`),
    stats: sameJson(prev.stats, next.stats) ? prev.stats : next.stats,
  };
  const keys = Object.keys(shared) as (keyof ProjectState)[];
  if (keys.length === Object.keys(prev).length && keys.every((k) => Object.is(shared[k], prev[k]) || (!(k in SLICES) && sameJson(shared[k], prev[k])))) return prev;
  return shared;
}

/** The slices that reconcile() shares by reference (other keys, such as `access`, compare by value). */
const SLICES: Record<string, true> = {
  project: true,
  intents: true,
  attempts: true,
  agents: true,
  corrections: true,
  checks: true,
  landings: true,
  decisions: true,
  questions: true,
  logs: true,
  radar: true,
  files: true,
  imports: true,
  stats: true,
};

/* ───────────── reducer ───────────── */

/** Insert or replace by id. An item equal to the stored one leaves the array unchanged. */
function upsert<T extends { id: string }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i === -1) return [...arr, item];
  if (sameJson(arr[i], item)) return arr;
  const next = arr.slice();
  next[i] = item;
  return next;
}

function capTail<T>(arr: T[], cap: number): T[] {
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}

/** Pure reducer: GitringEvent → ProjectState. Unchanged slices keep their references; a no-op returns `st`. */
export function reduce(st: ProjectState, ev: GitringEvent): ProjectState {
  switch (ev.type) {
    case "snapshot":
      return reconcile(st, ev.state);
    case "intent": {
      const intents = upsert(st.intents, ev.intent);
      return intents === st.intents ? st : { ...st, intents };
    }
    case "attempt": {
      const attempts = upsert(st.attempts, ev.attempt);
      return attempts === st.attempts ? st : { ...st, attempts };
    }
    case "agent": {
      const agents = upsert(st.agents, ev.agent);
      return agents === st.agents ? st : { ...st, agents };
    }
    case "correction": {
      const corrections = upsert(st.corrections, ev.correction);
      return corrections === st.corrections ? st : { ...st, corrections };
    }
    case "check": {
      const checks = upsert(st.checks, ev.check);
      return checks === st.checks ? st : { ...st, checks: capTail(checks, CHECK_CAP) };
    }
    case "landing": {
      const landings = upsert(st.landings, ev.landing);
      return landings === st.landings ? st : { ...st, landings };
    }
    case "decision": {
      const decisions = upsert(st.decisions, ev.decision);
      return decisions === st.decisions ? st : { ...st, decisions };
    }
    case "question": {
      const questions = upsert(st.questions ?? [], ev.question);
      return questions === st.questions ? st : { ...st, questions };
    }
    case "log": {
      if (st.logs.length && st.logs[st.logs.length - 1].id === ev.log.id) return st;
      return { ...st, logs: capTail([...st.logs, ev.log], LOG_CAP) };
    }
    case "radar": {
      // Merge by pair; the selectors drop pairs whose work is no longer active.
      const map = new Map<string, RadarPair>(st.radar.map((p) => [pairKey(p), p]));
      let changed = false;
      for (const p of ev.pairs) {
        const k = pairKey(p);
        const old = map.get(k);
        if (old && sameJson(old, p)) continue;
        map.set(k, p);
        changed = true;
      }
      return changed ? { ...st, radar: [...map.values()] } : st;
    }
    case "main": {
      if (st.project.mainSha === ev.sha && st.project.mainTree === ev.tree) return st;
      return {
        ...st,
        project: { ...st.project, mainSha: ev.sha, mainTree: ev.tree },
        files: shareList(st.files, ev.files, (f) => f.path),
        imports: shareList(st.imports, ev.imports, (e) => `${e[0]}\u0000${e[1]}`),
      };
    }
    case "stats":
      return sameJson(st.stats, ev.stats) ? st : { ...st, stats: ev.stats };
    case "github":
      return sameJson(st.project.github, ev.github) ? st : { ...st, project: { ...st.project, github: ev.github } };
    default:
      return st;
  }
}

export const store = {
  get(): StoreState {
    return snap;
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  dispatch(ev: GitringEvent) {
    const now = Date.now();
    if (ev.type === "snapshot") {
      const prev = snap.state;
      const next = prev ? reconcile(prev, ev.state) : ev.state;
      if (next === prev) return; // a resync that brings nothing new
      set({ state: next, events: snap.events + 1, lastEventAt: now, ripples: NO_RIPPLES, pulses: NO_PULSES });
      return;
    }
    const st = snap.state;
    if (!st) return; // deltas before the first snapshot are dropped; the snapshot carries them.
    const next = reduce(st, ev);
    if (next === st) return; // nothing changed: no re-render
    const patch: Partial<StoreState> = { state: next, events: snap.events + 1, lastEventAt: now };

    if (ev.type === "landing") {
      const attempt = next.attempts.find((a) => a.id === ev.landing.attemptId);
      const files = attempt ? Object.keys(attempt.footprint.files) : [];
      const fallback = attempt ? attempt.course.files : [];
      patch.ripples = [
        ...snap.ripples.filter((r) => now - r.at < 2000),
        { id: seq++, files: files.length ? files : fallback, at: now },
      ];
    }
    if (ev.type === "radar") {
      const prev = new Map(st.radar.map((p) => [pairKey(p), p]));
      const fresh = ev.pairs.filter((p) => p.closing && !prev.get(pairKey(p))?.closing);
      if (fresh.length) {
        patch.pulses = [
          ...snap.pulses.filter((p) => now - p.at < 2000),
          ...fresh.map((p) => ({ id: seq++, a: p.a, b: p.b, at: now })),
        ];
      }
    }
    set(patch);
  },
  setMode(mode: DataMode) {
    set({ mode });
  },
  setConn(conn: ConnState, error: string | null = null) {
    set({ conn, error });
  },
  setProject(projectId: string) {
    set({ projectId });
  },
  setMe(me: MeInfo) {
    set({ me: snap.me && sameJson(snap.me, me) ? snap.me : me });
  },
  setProjects(projects: ProjectInfo[]) {
    set({ projects: shareList(snap.projects, projects, (p) => p.id) });
  },
  setAccountReady() {
    set({ accountReady: true });
  },
  setAccess(access: Role | null) {
    set({ access });
  },
};

/**
 * Read a slice of the store. The selector result is cached per store snapshot;
 * pass an equality function for derived values that are rebuilt on each call.
 */
export function useStore<T>(selector: (s: StoreState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ snap: StoreState; sel: (s: StoreState) => T; value: T } | null>(null);
  const get = () => {
    const s = store.get();
    const c = cache.current;
    if (c && c.snap === s && c.sel === selector) return c.value;
    const v = selector(s);
    if (c && isEqual(c.value, v)) {
      c.snap = s;
      c.sel = selector;
      return c.value;
    }
    cache.current = { snap: s, sel: selector, value: v };
    return v;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    return true;
  }
  return false;
}

/** The project state (null until the first snapshot). */
export function useProject(): ProjectState | null {
  return useStore((s) => s.state);
}
