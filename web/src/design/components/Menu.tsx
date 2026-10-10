import { createContext, useContext, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { Popover, type PopoverCloseReason } from "./Popover";
import type { Align } from "./placement";

const MenuCtx = createContext<{ close: () => void } | null>(null);

interface MenuProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: (reason: PopoverCloseReason | "select") => void;
  /** Accessible name of the menu. */
  label: string;
  id?: string;
  align?: Align;
  width?: number;
  className?: string;
  children: ReactNode;
}

const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/**
 * Menu button pattern (WAI-ARIA APG): the first item gets focus; arrow keys, Home and End move;
 * a letter jumps to the next item that starts with it; Enter or Space selects; Escape closes and
 * focus goes back to the trigger; Tab closes.
 */
export function Menu({ anchor, open, onClose, label, id, align = "end", width, className, children }: MenuProps) {
  const typed = useRef({ text: "", at: 0 });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEM)].filter((el) => el.getAttribute("aria-disabled") !== "true");
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return go(i + 1);
      case "ArrowUp":
        return go(i < 0 ? items.length - 1 : i - 1);
      case "Home":
        return go(0);
      case "End":
        return go(items.length - 1);
      case "Tab":
        onClose("tab");
        return;
      case " ":
        if (document.activeElement instanceof HTMLElement && document.activeElement.matches(ITEM)) {
          e.preventDefault();
          document.activeElement.click();
        }
        return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const q = typed.current.text;
      const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
      const hit = order.find((el) => (el.textContent ?? "").trim().toLowerCase().startsWith(q));
      if (hit) {
        e.preventDefault();
        hit.focus();
      }
    }
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} role="none" align={align} width={width} className={className}>
      <MenuCtx.Provider value={{ close: () => onClose("select") }}>
        <div role="menu" id={id} aria-label={label} className="b-menu" onKeyDown={onKey}>
          {children}
        </div>
      </MenuCtx.Provider>
    </Popover>
  );
}

interface MenuItemProps {
  icon?: IconName;
  /** Visual before the text when an icon does not fit (an avatar, a brand mark). */
  lead?: ReactNode;
  children: ReactNode;
  /** A second line in small type. */
  hint?: ReactNode;
  /** Keyboard shortcut shown at the right, for example "g a". */
  shortcut?: string;
  onSelect?: (e: MouseEvent<HTMLElement>) => void;
  /** A link item: the browser follows it (a full page load) unless onSelect prevents it. */
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  tone?: "danger";
  /** Keep the menu open after the item runs. */
  keepOpen?: boolean;
}

export function MenuItem({ icon, lead, children, hint, shortcut, onSelect, href, checked, disabled, tone, keepOpen }: MenuItemProps) {
  const ctx = useContext(MenuCtx);
  const cls = ["b-menu__item", tone === "danger" && "is-danger", checked && "is-checked"].filter(Boolean).join(" ");
  const body = (
    <>
      {lead ?? (icon ? <Icon name={icon} /> : <span className="b-menu__noicon" aria-hidden="true" />)}
      <span className="b-menu__text">
        <span className="b-menu__label">{children}</span>
        {hint && <span className="b-menu__hint">{hint}</span>}
      </span>
      {checked && <Icon name="check" className="b-menu__check" />}
      {shortcut && (
        <span className="b-menu__keys" aria-hidden="true">
          {shortcut.split(" ").map((k) => (
            <kbd key={k} className="b-kbd">
              {k}
            </kbd>
          ))}
        </span>
      )}
    </>
  );
  const role = checked === undefined ? "menuitem" : "menuitemradio";
  const run = (e: MouseEvent<HTMLElement>) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    onSelect?.(e);
    if (!keepOpen) ctx?.close();
  };
  if (href) {
    return (
      <a role={role} href={href} tabIndex={-1} className={cls} aria-checked={checked} aria-disabled={disabled || undefined} aria-keyshortcuts={shortcut} onClick={run}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" role={role} tabIndex={-1} className={cls} aria-checked={checked} aria-disabled={disabled || undefined} aria-keyshortcuts={shortcut} onClick={run}>
      {body}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="b-menu__sep" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="b-menu__label-row" role="presentation">
      {children}
    </div>
  );
}
