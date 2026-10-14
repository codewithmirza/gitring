/**
 * A panel with a header row (title, count, action) and a hairline under it, and the small section label.
 */
import type { ReactNode } from "react";

interface PanelProps {
  title: ReactNode;
  count?: number | string;
  action?: ReactNode;
  children: ReactNode;
  variant?: "rail" | "inset";
  className?: string;
  /** id of the heading, for aria-labelledby. */
  headingId?: string;
  as?: "section" | "aside" | "div";
  label?: string;
}

/** Panel: header row (title + count + action) with a hairline under it. */
export function Panel({ title, count, action, children, variant = "rail", className, headingId, as = "section", label }: PanelProps) {
  const Tag = as;
  return (
    <Tag
      className={["b-panel", variant === "inset" && "b-panel--inset", className].filter(Boolean).join(" ")}
      aria-labelledby={label ? undefined : headingId}
      aria-label={label}
    >
      <div className="b-panel__head">
        <h2 className="b-panel__title" id={headingId}>
          {title}
        </h2>
        {count !== undefined && <span className="b-panel__count">{count}</span>}
        {action && <div className="b-panel__action">{action}</div>}
      </div>
      <div className="b-panel__body">{children}</div>
    </Tag>
  );
}

export function SectionLabel({ children, count, id }: { children: ReactNode; count?: number | string; id?: string }) {
  return (
    <h3 className="b-section-label" id={id}>
      {children}
      {count !== undefined && <span className="b-panel__count">{count}</span>}
    </h3>
  );
}
