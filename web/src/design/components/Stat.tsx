import type { ReactNode } from "react";

interface StatProps {
  value: ReactNode;
  label: ReactNode;
  unit?: string;
  variant?: "default" | "hero" | "inline";
  good?: boolean;
  /** Where the number comes from (hover shows it). Make every number checkable. */
  source?: string;
}

/** Stat: number (mono) + label. Used in a row with hairline dividers, not as cards. */
export function Stat({ value, label, unit, variant = "default", good, source }: StatProps) {
  return (
    <div
      className={["b-stat", variant !== "default" && `b-stat--${variant}`, good && "b-stat--good"].filter(Boolean).join(" ")}
      title={source}
    >
      <span className="b-stat__value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      <span className="b-stat__label">{label}</span>
    </div>
  );
}

export function StatRow({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="b-stats" role="group" aria-label={label}>
      {children}
    </div>
  );
}
