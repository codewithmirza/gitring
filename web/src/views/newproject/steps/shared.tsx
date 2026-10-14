/**
 * The parts every step shares: the props, the step head, a guess row, the problem box, the submit button.
 * Used by the step files in this folder. Never import it from outside this folder.
 */
import { useEffect, useRef, type ReactNode } from "react";
import type { Visibility } from "../../../../../src/core/accounts";
import type { GithubSyncMode } from "../../../../../src/core/types";
import { TEMPLATES } from "../../../../../src/core/templates";
import { Button, Segmented } from "../../../design/components";
import { Icon } from "../../../design/icons";
import { openSignIn } from "../../../app/ui";
import { RequestError, OFFLINE_TEXT } from "../../../state/github";
import type { FormValues, SourceStep } from "../draft";

export interface StepProps {
  form: Partial<FormValues>;
  setForm: (patch: Partial<FormValues>) => void;
  onBack: () => void;
  onStep: (step: SourceStep) => void;
  /** Where a sign-in sends the person back. */
  returnTo: string;
}

const VIS_HELP: Record<Visibility, string> = {
  private: "Only you and the people you add can see it.",
  public: "Anyone with the link can view it. Only members can change it.",
};

export const SYNC_TEXT: Record<GithubSyncMode, string> = {
  off: "Merged code stays in gitring. You can turn GitHub sync on later in Settings → GitHub.",
  "pull-request": "gitring keeps one pull request open on GitHub. You merge it there.",
  main: "gitring pushes each merge straight to the main branch on GitHub.",
};

export function toError(e: unknown): RequestError {
  return e instanceof RequestError ? e : new RequestError(0, (e as Error)?.message || OFFLINE_TEXT);
}

/* ───────────── shared parts ───────────── */

export function StepHead({ title, onBack, children }: { title: ReactNode; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="np-step__head">
      <button type="button" className="np-back" onClick={onBack}>
        <Icon name="arrow-left" size={14} />
        All sources
      </button>
      <h3 className="np-step__title">{title}</h3>
      {children}
    </div>
  );
}

export function Row({ id, label, hint, tag, children }: { id: string; label: string; hint?: ReactNode; tag?: string; children: ReactNode }) {
  return (
    <div className="np-row">
      <label className="np-row__label" htmlFor={id}>
        {label}
        {tag && <span className="np-tag np-tag--guess">{tag}</span>}
      </label>
      <div className="np-row__value">
        {children}
        {hint && (
          <span className="np-row__hint" id={`${id}-hint`}>
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}

/** A quiet text field: it reads as a value, and it is a normal input for keys, focus and screen readers. */
export function Quiet({ id, value, onChange, placeholder, mono, hint, invalid, inputRef, ...rest }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  hint?: boolean;
  invalid?: boolean;
  /** The first field of a step: it takes the focus (also when the panel opens at this step). */
  inputRef?: (el: HTMLInputElement | null) => void;
  maxLength?: number;
  inputMode?: "url" | "text";
}) {
  return (
    <input
      {...rest}
      ref={inputRef}
      data-autofocus={inputRef ? "select" : undefined}
      id={id}
      className={["np-in", mono && "voice-agent"].filter(Boolean).join(" ")}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      aria-describedby={hint ? `${id}-hint` : undefined}
      aria-invalid={invalid || undefined}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
    />
  );
}

export function VisibilityRow({ value, onChange, hint }: { value: Visibility; onChange: (v: Visibility) => void; hint?: string }) {
  return (
    <div className="np-row">
      <span className="np-row__label">Who can see it</span>
      <div className="np-row__value">
        <Segmented<Visibility>
          label="Who can see it"
          value={value}
          onChange={onChange}
          options={[
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
        />
        <span className="np-row__hint">{hint ? `${VIS_HELP[value]} ${hint}` : VIS_HELP[value]}</span>
      </div>
    </div>
  );
}

export function Problem({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="np-error" role="alert">
      <Icon name="cross" size={12} />
      <div className="np-error__body">
        <p>{children}</p>
        {actions && <div className="np-error__acts">{actions}</div>}
      </div>
    </div>
  );
}

export function Submit({ busy, label, disabled, why }: { busy: boolean; label: string; disabled?: boolean; why?: string }) {
  return (
    <div className="np-actions">
      <Button type="submit" variant="primary" icon="plus" busy={busy} disabled={disabled} title={disabled ? why : undefined} aria-keyshortcuts="Enter">
        {label}
      </Button>
      <span className="np-actions__key" aria-hidden="true">
        <kbd className="b-kbd">Enter</kbd>
      </span>
      {disabled && why && <span className="np-actions__why">{why}</span>}
    </div>
  );
}

/**
 * Focus the first field when a step opens (or when `when` turns true), with its text selected, so typing
 * replaces the guess and Enter accepts it.
 */
export function useFirstField(when = true) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !when) return;
    el.focus({ preventScroll: true });
    el.select();
  }, [when]);
  return (el: HTMLInputElement | null) => {
    ref.current = el;
  };
}

/** Errors of a creation, with the next step for each. */
export function createProblem(e: RequestError, returnTo: string, onStep: (s: SourceStep) => void): { text: string; actions?: ReactNode } {
  const install = typeof e.data.installUrl === "string" ? e.data.installUrl : null;
  if (e.status === 401) {
    // The gitring sign-in ended (not the GitHub connection): any sign-in choice works, and the link of
    // the step brings the person back to it.
    return {
      text: "Your sign-in ended. Sign in again. gitring keeps your choices.",
      actions: (
        <Button size="sm" onClick={(ev) => openSignIn({ anchor: ev.currentTarget, reason: "Sign in again to make the project.", then: { kind: "go", to: returnTo } })}>
          Sign in again
        </Button>
      ),
    };
  }
  return {
    text: `The project was not created. ${e.message}`,
    actions: install ? (
      <a className="b-btn b-btn--secondary b-btn--sm" href={install} target="_blank" rel="noopener noreferrer">
        Install the GitHub App <Icon name="external" size={12} />
      </a>
    ) : e.status === 404 || /larger than|too large|20 MB/i.test(e.message) ? (
      <Button size="sm" onClick={() => onStep({ kind: "push" })}>
        Push with git instead
      </Button>
    ) : undefined,
  };
}

/* ───────────── a description: template, first task, agents ───────────── */

export const TEMPLATE_OPTIONS = TEMPLATES.map((t) => ({ value: t.id, label: t.title }));
