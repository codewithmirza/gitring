/**
 * A link in the code view that changes the view without a page load on a plain click.
 * It is a real <a href>: a new tab and Copy link work. It keeps the query of the address (?project=) and supports #L line anchors.
 */
import type { ComponentPropsWithRef, MouseEvent } from "react";
import { codeUrl, goCode, type CodeLocation } from "./links";

interface Props extends Omit<ComponentPropsWithRef<"a">, "href"> {
  to: Partial<CodeLocation> & { ref: string };
  replace?: boolean;
}

export function CodeLink({ to, replace, onClick, ...rest }: Props) {
  return (
    <a
      {...rest}
      href={codeUrl(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goCode(to, { replace });
      }}
    />
  );
}
