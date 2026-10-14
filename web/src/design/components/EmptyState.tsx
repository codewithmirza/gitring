/**
 * An empty state: a small chart-frame drawing, one plain sentence and one action.
 */
import type { ReactNode } from "react";

/** A small chart-frame drawing: double rule, a compass tick and a dashed course. */
export function ChartFrameArt({ size = 96 }: { size?: number }) {
  return (
    <svg className="b-empty__art" width={size} height={(size * 2) / 3} viewBox="0 0 96 64" aria-hidden="true">
      <rect x="1.5" y="1.5" width="93" height="61" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="5.5" y="5.5" width="85" height="53" fill="none" stroke="currentColor" strokeWidth="1" />
      {[18, 32, 46, 60, 74].map((x, i) => (
        <rect key={x} x={x} y="1.5" width="14" height="4" fill={i % 2 ? "none" : "currentColor"} opacity=".7" />
      ))}
      <path d="M16 46 C30 40, 38 28, 52 30 S72 22, 80 16" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" />
      <path d="M80 16 l-6 1 3 4z" fill="currentColor" />
      <circle cx="16" cy="46" r="2" fill="none" stroke="currentColor" />
    </svg>
  );
}

/** EmptyState: a small chart-frame drawing + one STE sentence + one action. */
export function EmptyState({ text, action, art = true }: { text: ReactNode; action?: ReactNode; art?: boolean }) {
  return (
    <div className="b-empty">
      {art && <ChartFrameArt />}
      <p className="b-empty__text">{text}</p>
      {action}
    </div>
  );
}
