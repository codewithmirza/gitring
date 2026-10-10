/** Key names for hints: ⌘ on Apple devices, Ctrl elsewhere. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";
export const PALETTE_KEY = isMac ? "⌘K" : "Ctrl K";

/** True when the key event comes from a field where letters are text, not shortcuts. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return Boolean(t?.closest?.("input, textarea, select, [contenteditable='true'], [role='combobox']"));
}
