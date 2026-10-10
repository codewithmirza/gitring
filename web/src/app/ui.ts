/** UI-only state shared across views: global dialogs and drawers. */
import { useSyncExternalStore } from "react";
import { atLeast } from "../../../src/core/accounts";
import { toast } from "../design/components";
import { store } from "../state/store";

export interface UiState {
  newIntent: boolean;
  signIn: boolean;
  shortcuts: boolean;
  file: { path: string; ref: string } | null;
  diff: { attemptId: string; title: string } | null;
}

let state: UiState = { newIntent: false, signIn: false, shortcuts: false, file: null, diff: null };
const listeners = new Set<() => void>();

export function setUi(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
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

/** Open the new-task dialog. A visitor gets the sign-in dialog; a viewer gets a note. */
export function openNewIntent() {
  const s = store.get();
  if (atLeast(s.access, "member")) {
    setUi({ newIntent: true });
    return;
  }
  if (!s.me?.user) {
    setUi({ signIn: true });
    return;
  }
  toast({ tone: "info", title: "You can view this project", text: "Members open tasks. Ask an owner for the member role, or make your own project." });
}
export const openSignIn = () => setUi({ signIn: true });
export const openShortcuts = () => setUi({ shortcuts: true });
export const openFile = (path: string, ref = "main") => setUi({ file: { path, ref } });
export const openDiff = (attemptId: string, title: string) => setUi({ diff: { attemptId, title } });
