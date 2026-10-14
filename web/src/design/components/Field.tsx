/**
 * The form controls: Field (label, help text, error), Input, Textarea, Select and Checkbox.
 */
import { cloneElement, isValidElement, useId, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react";
import { Icon } from "../icons";

interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  children: ReactElement;
  className?: string;
}

/** Label above, help below, error in --danger with an icon. */
export function Field({ label, help, error, optional, children, className }: FieldProps) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        "aria-describedby": [helpId, errId].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : undefined,
      })
    : children;
  return (
    <div className={["b-field", className].filter(Boolean).join(" ")}>
      <label className="b-field__label" htmlFor={id}>
        {label}
        {optional && <span className="b-field__opt"> (optional)</span>}
      </label>
      {child}
      {help && (
        <div className="b-field__help" id={helpId}>
          {help}
        </div>
      )}
      {error && (
        <div className="b-field__error" id={errId} role="alert">
          <Icon name="cross" size={12} />
          {error}
        </div>
      )}
    </div>
  );
}

export function Input({ className, state, ...rest }: ComponentPropsWithRef<"input"> & { state?: "hover" | "focus" }) {
  return <input {...rest} className={["b-input", state && `is-${state}`, className].filter(Boolean).join(" ")} />;
}

export function Textarea({ className, voice, ...rest }: ComponentPropsWithRef<"textarea"> & { voice?: "human" | "agent" }) {
  return <textarea {...rest} className={["b-textarea", voice && `voice-${voice}`, className].filter(Boolean).join(" ")} />;
}

export function Select({ className, ...rest }: ComponentPropsWithRef<"select">) {
  return <select {...rest} className={["b-select", className].filter(Boolean).join(" ")} />;
}

export function Checkbox({ label, ...rest }: Omit<ComponentPropsWithRef<"input">, "type"> & { label: ReactNode }) {
  return (
    <label className="b-check">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}
