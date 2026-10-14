/**
 * Small parts of the connect page: a narrow-screen hook, a remembered choice, a folded way, inline code and a copy field.
 * A link to a folded way must call `jumpTo`: it opens the way before it scrolls.
 */
import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "../../design/components";
import { Icon } from "../../design/icons";

export function useNarrow(q = "(max-width: 760px)") {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

/** A choice that this browser remembers (the agent client, the key tab). */
export function useRemembered<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      return s && allowed.includes(s) ? s : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (n: T) => {
    setV(n);
    try {
      localStorage.setItem(key, n);
    } catch {
      /* storage off: the choice holds for this visit */
    }
  };
  return [v, set];
}

/* ───────────── folded ways ───────────── */

/** Open the folded ways around an element, scroll to it and put the focus on it. */
export function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  for (let way = el.closest("details"); way; way = way.parentElement?.closest("details") ?? null) way.open = true;
  el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/**
 * One way to connect, closed at first: a title, one plain line about it, and the content.
 * With `aside` the content has two columns: the words at the left and the code at the right.
 */
export function Way({ id, title, note, aside, children }: { id: string; title: string; note: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <details className="cx-way" id={id}>
      <summary className="cx-way__sum">
        <Icon name="chevron-right" size={14} className="cx-way__chevron" />
        <span className="cx-way__title">{title}</span>
        <span className="cx-way__note">{note}</span>
      </summary>
      {aside ? (
        <div className="cx-way__body cx-way__body--cols">
          <div className="cx__text">{aside}</div>
          <div className="cx__code">{children}</div>
        </div>
      ) : (
        <div className="cx-way__body cx__code">{children}</div>
      )}
    </details>
  );
}

/* ───────────── text and copy ───────────── */

/** A text with `code` words: each word between backticks shows as inline code. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 ? (
          <span key={i} className="code-inline">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

interface CopyFieldProps {
  value: string;
  label: string;
  button?: string;
  variant?: ButtonVariant;
  /** Show the value as a shell command that wraps (one `$` before each line). The copy has no `$`. */
  command?: boolean;
}

/**
 * One line to copy, with a button. A URL shows in a read-only field (focus selects it). A command shows
 * wrapped, so that a phone never needs a sideways scroll. The main copy has the primary button; others are quieter.
 */
export function CopyField({ value, label, button = "Copy URL", variant = "primary", command = false }: CopyFieldProps) {
  const id = useId();
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied("idle"), 1800);
  };
  return (
    <div className="cx-url">
      {command ? (
        <pre className="cx-url__input cx-url__cmd voice-agent" tabIndex={0} aria-label={label}>
          {value.split("\n").map((line, i) => (
            <code key={i}>
              <span className="tok-p">$ </span>
              {line}
              {"\n"}
            </code>
          ))}
        </pre>
      ) : (
        <>
          <label className="vh" htmlFor={id}>
            {label}
          </label>
          <input id={id} className="cx-url__input voice-agent" readOnly value={value} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
        </>
      )}
      <Button variant={variant} icon={copied === "ok" ? "check" : "copy"} onClick={() => void copy()}>
        {copied === "ok" ? "Copied" : button}
      </Button>
      <span className="vh" aria-live="polite">
        {copied === "ok" ? "Copied." : copied === "fail" ? "The browser did not copy. Select the text and copy it." : ""}
      </span>
    </div>
  );
}
