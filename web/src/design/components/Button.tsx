/**
 * Buttons: Button (variants, sizes, icons, a busy state) and IconButton (a square button with a label and a tooltip).
 */
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: IconName;
  iconRight?: IconName;
  /** Shows a hairline progress rule; the button ignores clicks. */
  busy?: boolean;
  block?: boolean;
  /** Static state for the style guide. */
  state?: "hover" | "focus" | "active";
  children?: ReactNode;
}

/**
 * Button: verb + noun labels ("Land attempt"). Disabled buttons stay focusable
 * (aria-disabled) so keyboard users can find them and read the reason nearby.
 */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  busy,
  block,
  state,
  disabled,
  className,
  onClick,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const off = Boolean(disabled || busy);
  const cls = [
    "b-btn",
    `b-btn--${variant}`,
    size === "sm" && "b-btn--sm",
    block && "b-btn--block",
    state && `is-${state}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={cls}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (off) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {icon && <Icon name={icon} />}
      {children}
      {iconRight && <Icon name={iconRight} />}
      {busy && <span className="b-btn__busy" aria-hidden="true" />}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "icon" | "iconRight" | "children"> {
  icon: IconName;
  /** Accessible name; also the tooltip text. */
  label: string;
  /** Keyboard hint shown in the tooltip. */
  shortcut?: string;
  tooltip?: boolean;
}

export function IconButton({ icon, label, shortcut, variant = "ghost", tooltip = true, className, ...rest }: IconButtonProps) {
  const btn = (
    <Button {...rest} variant={variant} className={["b-iconbtn", className].filter(Boolean).join(" ")} aria-label={label}>
      <Icon name={icon} />
    </Button>
  );
  if (!tooltip) return btn;
  return (
    <Tooltip
      label={
        shortcut ? (
          <>
            {label} <kbd className="b-kbd">{shortcut}</kbd>
          </>
        ) : (
          label
        )
      }
    >
      {btn}
    </Tooltip>
  );
}
