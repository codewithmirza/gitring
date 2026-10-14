/**
 * The colored dot of an agent: its color number picks one of the 12 agent colors.
 */
import type { CSSProperties } from "react";

const vc = (color: number) => ({ "--vc": `var(--v${((color % 12) + 12) % 12})` }) as CSSProperties;

export function Dot({ color, ring }: { color: number; ring?: boolean }) {
  return <span className={ring ? "cv-dot cv-dot--ring" : "cv-dot"} style={vc(color)} aria-hidden="true" />;
}
