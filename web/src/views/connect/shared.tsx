/**
 * Small parts of the connect page: a narrow-screen hook, a remembered choice, a section, inline code and a copy field.
 */
import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "../../design/components";

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

/* ───────────── page parts ───────────── */

export function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside: ReactNode }) {
  return (
    <section className="cx" aria-labelledby={id}>
      <div className="cx__text">
        <h2 className="page__h2" id={id}>
          {title}
        </h2>
        {aside}
      </div>
      <div className="cx__code">{children}</div>
    </section>
  );
}

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

/** One line to copy: a read-only field (focus selects it) and a button. The main URL has the primary button; others are quieter. */
export function CopyField({ value, label, button = "Copy URL", variant = "primary" }: { value: string; label: string; button?: string; variant?: ButtonVariant }) {
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
      <label className="vh" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="cx-url__input voice-agent" readOnly value={value} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
      <Button variant={variant} icon={copied === "ok" ? "check" : "copy"} onClick={() => void copy()}>
        {copied === "ok" ? "Copied" : button}
      </Button>
      <span className="vh" aria-live="polite">
        {copied === "ok" ? "Copied." : copied === "fail" ? "The browser did not copy. Select the text and copy it." : ""}
      </span>
    </div>
  );
}
