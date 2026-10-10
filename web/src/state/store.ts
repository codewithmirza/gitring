/**
 * The project store: one reducer over the GitringEvent stream from the live WebSocket.
 *
 * Components read slices with useStore(selector). The reducer keeps references of
 * unchanged slices, so a component re-renders only when its slice changes.
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

let seq = 1;
let snap: StoreState = {
  mode: "boot",
  conn: "connecting",
  projectId: "",
  state: null,
  error: null,
  ripples: [],
  pulses: [],
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
  snap = { ...snap, ...patch };
  notify();
}

function upsert<T extends { id: string }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i === -1) return [...arr, item];
  const next = arr.slice();
  next[i] = item;
  return next;
}

function capTail<T>(arr: T[], cap: number): T[] {
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}

const pairKey = (p: { a: string; b: string }) => (p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`);

/** Pure reducer: GitringEvent → ProjectState. Unchanged slices keep their references. */
export function reduce(st: ProjectState, ev: GitringEvent): ProjectState {
  switch (ev.type) {
    case "snapshot":
      return ev.state;
    case "intent":
      return { ...st, intents: upsert(st.intents, ev.intent) };
    case "attempt":
      return { ...st, attempts: upsert(st.attempts, ev.attempt) };
    case "agent":
      return { ...st, agents: upsert(st.agents, ev.agent) };
    case "correction":
      return { ...st, corrections: upsert(st.corrections, ev.correction) };
    case "check":
      return { ...st, checks: capTail(upsert(st.checks, ev.check), CHECK_CAP) };
    case "landing":
      return { ...st, landings: upsert(st.landings, ev.landing) };
    case "decision":
      return { ...st, decisions: upsert(st.decisions, ev.decision) };
    case "log": {
      if (st.logs.length && st.logs[st.logs.length - 1].id === ev.log.id) return st;
      return { ...st, logs: capTail([...st.logs, ev.log], LOG_CAP) };
    }
    case "radar": {
      // Merge by pair; the selectors drop pairs whose work is no longer active.
      const map = new Map<string, RadarPair>(st.radar.map((p) => [pairKey(p), p]));
      for (const p of ev.pairs) map.set(pairKey(p), p);
      return { ...st, radar: [...map.values()] };
    }
    case "main":
      return {
        ...st,
        project: { ...st.project, mainSha: ev.sha, mainTree: ev.tree },
        files: ev.files,
        imports: ev.imports,
      };
    case "stats":
      return { ...st, stats: ev.stats };
    case "github":
      return { ...st, project: { ...st.project, github: ev.github } };
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
      set({ state: ev.state, events: snap.events + 1, lastEventAt: now, ripples: [], pulses: [] });
      return;
    }
    const st = snap.state;
    if (!st) return; // deltas before the first snapshot are dropped; the snapshot carries them.
    const next = reduce(st, ev);
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
    set({ me });
  },
  setProjects(projects: ProjectInfo[]) {
    set({ projects });
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
