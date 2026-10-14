/**
 * A segmented control: a radio group where the arrow keys move and select.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: IconName;
  /** Accessible name when the label is visually hidden. */
  ariaLabel?: string;
  title?: string;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
  /** Hide text labels (icons only); the ariaLabel or label still names each option. */
  iconOnly?: boolean;
  /** Read only: shows the value, ignores clicks and keys. */
  disabled?: boolean;
  className?: string;
}

/** Segmented control: role="radiogroup"; arrow keys move and select. */
export function Segmented<T extends string>({ options, value, onChange, label, size = "sm", iconOnly, disabled, className }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (e: KeyboardEvent, i: number) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next = i;
    if (e.key in keys) next = (i + keys[e.key] + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    if (disabled) return;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={["b-seg", size === "md" && "b-seg--md", disabled && "b-seg--disabled", className].filter(Boolean).join(" ")}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-disabled={disabled || undefined}
          aria-label={iconOnly ? o.ariaLabel ?? (typeof o.label === "string" ? o.label : undefined) : o.ariaLabel}
          title={o.title}
          tabIndex={i === idx ? 0 : -1}
          className="b-seg__opt"
          onClick={() => !disabled && onChange(o.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {o.icon && <Icon name={o.icon} />}
          {!iconOnly && o.label}
        </button>
      ))}
    </div>
  );
}
