/**
 * UI-only state that views share.
 * Nothing here goes to the server.
 * It holds the sign-in panel, the task composer and its "Sending…" rows, the command palette and the shortcut list.
 */
import { useSyncExternalStore } from "react";
import { atLeast } from "../../../src/core/accounts";
import { toast } from "../design/components";
import { store } from "../state/store";
import { codeHref, navigate } from "./router";

/** The text of a task that the person writes (kept in this browser per project). */
export interface TaskDraft {
  title: string;
  goal: string;
  checkPath: string;
  checkCode: string;
  priority: "normal" | "high";
  fanout: number | null;
  models: string[] | null;
}

/** A task that the person sent and that the project state does not show yet. */
export interface PendingTask {
  key: string;
  title: string;
  state: "sending" | "error";
  error?: string;
  /** Set when the server answered: the row goes away when the state has this task. */
  intentId?: string;
  /** The text of a failed send, to edit and send again. */
  draft?: TaskDraft;
  at: number;
}

/** What to do after the person comes back from the sign-in page. */
export type AfterSignIn = { kind: "newTask" } | { kind: "newProject" } | { kind: "go"; to: string };

export interface UiState {
  /** The sign-in panel. Old callers set { signIn: true }; the panel then grows from the focused button. */
  signIn: boolean;
  signInAnchor: HTMLElement | null;
  signInReason: string | null;
  signInError: string | null;
  signInThen: AfterSignIn | null;
  /** The inline task composer is open. composerFocus changes when something asks it to take focus. */
  composer: boolean;
  composerFocus: number;
  pending: PendingTask[];
  shortcuts: boolean;
  shortcutsAnchor: HTMLElement | null;
  palette: boolean;
  /** Text the palette starts with (">" lists the commands). */
  paletteQuery: string;
  /** Counts the requests to open the decisions list from outside the top bar (the "+N more" chip). */
  decisionsRequest: number;
  /** The decisions list is open. The tray of chips waits: the list shows the same questions. */
  decisionsOpen: boolean;
}

let state: UiState = {
  signIn: false,
  signInAnchor: null,
  signInReason: null,
  signInError: null,
  signInThen: null,
  composer: false,
  composerFocus: 0,
  pending: [],
  shortcuts: false,
  shortcutsAnchor: null,
  palette: false,
  paletteQuery: "",
  decisionsRequest: 0,
  decisionsOpen: false,
};
const listeners = new Set<() => void>();

/** The element that has focus now, if it can anchor a panel (a button or a link, not the page). */
function focusedControl(): HTMLElement | null {
  const el = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  if (!el || el === document.body || !el.isConnected) return null;
  return el.matches("button, a[href], [role='button'], [role='menuitem']") ? el : null;
}

export function setUi(patch: Partial<UiState>) {
  // { signIn: true } from older code: grow the panel from the button that has focus.
  if (patch.signIn && !state.signIn && !("signInAnchor" in patch)) patch = { ...patch, signInAnchor: focusedControl() };
  if (patch.signIn === false) patch = { signInAnchor: null, signInReason: null, signInError: null, signInThen: null, ...patch };
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getUi(): UiState {
  return state;
}

export function useUi(): UiState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

/* ───────────── sign-in ───────────── */

/**
 * Open the sign-in panel. It grows from `anchor`, else from the focused button, else from "Sign in" in the
 * top bar. `then` runs after the person comes back signed in (for example: open the task composer).
 */
export function openSignIn(opts: { anchor?: HTMLElement | null; reason?: string; error?: string; then?: AfterSignIn } | unknown = {}) {
  const o = (opts && typeof opts === "object" && !("nativeEvent" in opts) ? opts : {}) as { anchor?: HTMLElement | null; reason?: string; error?: string; then?: AfterSignIn };
  setUi({
    signIn: true,
    signInAnchor: o.anchor ?? focusedControl(),
    signInReason: o.reason ?? null,
    signInError: o.error ?? null,
    signInThen: o.then ?? null,
  });
}

const AFTER_KEY = "gitring.afterSignIn";

/** Keep the next step through the sign-in redirect (this tab only). */
export function rememberAfterSignIn(then: AfterSignIn | null) {
  try {
    if (then) sessionStorage.setItem(AFTER_KEY, JSON.stringify({ then, at: Date.now() }));
    else sessionStorage.removeItem(AFTER_KEY);
  } catch {
    /* storage off: the person starts the action again */
  }
}

/** The step that waits for the sign-in (at most 15 minutes old). Reading it clears it. */
export function takeAfterSignIn(): AfterSignIn | null {
  try {
    const raw = sessionStorage.getItem(AFTER_KEY);
    sessionStorage.removeItem(AFTER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { then: AfterSignIn; at: number };
    return Date.now() - v.at < 15 * 60_000 ? v.then : null;
  } catch {
    return null;
  }
}

/* ───────────── task composer ───────────── */

function composerVisible(): boolean {
  return [...document.querySelectorAll<HTMLElement>("[data-composer]")].some((el) => el.getClientRects().length > 0);
}

/** Open the task composer and give it focus. A visitor gets the sign-in panel; a viewer gets a note. */
export function openNewIntent(_from?: unknown) {
  const s = store.get();
  if (!s.me?.user) {
    openSignIn({ reason: "Sign in to write tasks for your agents.", then: { kind: "newTask" } });
    return;
  }
  if (s.state && !atLeast(s.access, "member")) {
    toast({ tone: "info", title: "You can view this project", text: "Members write tasks. Ask an owner for the member role, or make your own project." });
    return;
  }
  // The composer sits on the tasks rail. When this page does not show it, the tasks page opens with it.
  const here = composerVisible();
  setUi({ composer: true, composerFocus: state.composerFocus + 1 });
  if (!here) navigate("/tasks");
}

export function closeComposer() {
  setUi({ composer: false });
}

export function addPending(p: PendingTask) {
  setUi({ pending: [...state.pending.filter((x) => x.key !== p.key), p] });
}

export function updatePending(key: string, patch: Partial<PendingTask>) {
  setUi({ pending: state.pending.map((p) => (p.key === key ? { ...p, ...patch } : p)) });
}

export function dropPending(key: string) {
  setUi({ pending: state.pending.filter((p) => p.key !== key) });
}

// A "Sending…" row goes away as soon as the live state has its task (or after 20 s as a fallback).
store.subscribe(() => {
  if (!state.pending.length) return;
  const intents = store.get().state?.intents;
  const now = Date.now();
  const keep = state.pending.filter((p) => !(p.intentId && (intents?.some((i) => i.id === p.intentId) || now - p.at > 20_000)));
  if (keep.length !== state.pending.length) setUi({ pending: keep });
});

/* ───────────── palette, shortcuts ───────────── */

export function openPalette(query = "") {
  setUi({ palette: true, paletteQuery: typeof query === "string" ? query : "" });
}

export function closePalette() {
  setUi({ palette: false });
}

/** Open the decisions list in the top bar (it listens for this request). */
export function openDecisions() {
  setUi({ decisionsRequest: state.decisionsRequest + 1 });
}

export function openShortcuts(anchor?: HTMLElement | null | unknown) {
  setUi({ shortcuts: true, shortcutsAnchor: anchor instanceof HTMLElement ? anchor : focusedControl() });
}

/* ───────────── code ───────────── */

/** Open a file in the code view (main by default, or a work copy id, or a commit). */
export function openFile(path: string, ref = "main") {
  navigate(codeHref(ref, path));
}

/** Open the diff of a work copy against its base in the code view. */
export function openDiff(attemptId: string, _title?: string) {
  navigate(codeHref(attemptId, undefined, { diff: true }));
}
