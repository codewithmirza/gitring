/**
 * Tabs with a tab list (the arrow keys move and select) and the panel of each tab.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  count?: number | string;
}

interface TabsProps<T extends string> {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Prefix for tab/panel ids: tab = `${idPrefix}-tab-${id}`, panel = `${idPrefix}-panel-${id}`. */
  idPrefix: string;
  className?: string;
}

/** Tabs: role="tablist", arrow keys move and select (automatic activation). */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let n = i;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={["b-tabs", className].filter(Boolean).join(" ")}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          id={`${idPrefix}-tab-${t.id}`}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          className="b-tab"
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.count !== undefined && <span className="b-tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idPrefix, id, active, children, className }: { idPrefix: string; id: string; active: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      hidden={!active}
      className={className}
      tabIndex={-1}
    >
      {active && children}
    </div>
  );
}
