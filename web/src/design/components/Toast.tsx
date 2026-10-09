import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { IconButton } from "./Button";

export type ToastTone = "info" | "clear" | "correction" | "danger";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  text?: ReactNode;
  action?: { label: string; onClick: () => void };
}

let items: ToastItem[] = [];
let seq = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(t: Omit<ToastItem, "id">) {
  items = [...items.slice(-3), { ...t, id: seq++ }];
  emit();
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

const ICON: Record<ToastTone, IconName> = { info: "info", clear: "check", correction: "buoy", danger: "cross" };

function ToastView({ t }: { t: ToastItem }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => dismiss(t.id), 6000);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => {
    start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={`b-toast b-toast--${t.tone}`} onMouseEnter={stop} onMouseLeave={start} onFocus={stop} onBlur={start}>
      <span className="b-toast__icon">
        <Icon name={ICON[t.tone]} />
      </span>
      <div className="b-toast__body">
        <div className="b-toast__title">{t.title}</div>
        {t.text && <div className="b-toast__text">{t.text}</div>}
        {t.action && (
          <button
            type="button"
            className="b-corr__toggle"
            onClick={() => {
              t.action!.onClick();
              dismiss(t.id);
            }}
          >
            {t.action.label}
          </button>
        )}
      </div>
      <IconButton icon="close" label="Dismiss" size="sm" tooltip={false} onClick={() => dismiss(t.id)} />
    </div>
  );
}

/** Toasts: bottom-right; auto-dismiss in 6 s, pause on hover, Escape dismisses the newest. */
export function ToastHost() {
  const list = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
    () => items,
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && items.length && !document.querySelector("dialog[open]")) {
        dismiss(items[items.length - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="b-toasts" role="status" aria-live="polite" aria-relevant="additions">
      {list.map((t) => (
        <ToastView key={t.id} t={t} />
      ))}
    </div>
  );
}
