/** UI-only state shared across views: global dialogs and drawers. */
import { useSyncExternalStore } from "react";

export interface UiState {
  newIntent: boolean;
  shortcuts: boolean;
  file: { path: string; ref: string } | null;
  diff: { attemptId: string; title: string } | null;
}

let state: UiState = { newIntent: false, shortcuts: false, file: null, diff: null };
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

export const openNewIntent = () => setUi({ newIntent: true });
export const openShortcuts = () => setUi({ shortcuts: true });
export const openFile = (path: string, ref = "main") => setUi({ file: { path, ref } });
export const openDiff = (attemptId: string, title: string) => setUi({ diff: { attemptId, title } });
