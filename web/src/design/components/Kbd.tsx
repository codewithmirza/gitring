/**
 * A keyboard hint: a key name in a small monospace box.
 */
import type { ReactNode } from "react";

/** Keyboard hint: mono, hairline border. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="b-kbd">{children}</kbd>;
}
