/**
 * The callsign of an agent: a colored pennant, a shape and the agent name, for color-blind readers too.
 */
import type { CSSProperties } from "react";
import { Hull, hullName, type HullName } from "../icons";
import { modelShort } from "../../state/format";

interface CallsignProps {
  callsign: string;
  color: number;
  hull?: HullName;
  model?: string;
  size?: "sm" | "md";
  /** Show the model next to the pennant. */
  showModel?: boolean;
  dim?: boolean;
  className?: string;
}

/**
 * Callsign: identity pennant (color) + glyph (shape) + mono agent name (text).
 * Color, shape and text together identify an agent for color-blind readers.
 * Screen readers hear the agent name and the model.
 */
export function Callsign({ callsign, color, hull, model, size = "sm", showModel, dim, className }: CallsignProps) {
  const style = { "--vc": `var(--v${((color % 12) + 12) % 12})` } as CSSProperties;
  const label = model ? `${callsign}, ${modelShort(model)}` : callsign;
  const pennant = (
    <span
      className={["b-callsign", size === "md" && "b-callsign--md", dim && "b-callsign--dim", !showModel && className].filter(Boolean).join(" ")}
      style={style}
      aria-label={showModel ? undefined : label}
      role={showModel ? undefined : "img"}
    >
      <Hull hull={hull ?? hullName(color)} />
      <span aria-hidden={showModel ? undefined : true}>{callsign}</span>
    </span>
  );
  if (!showModel || !model) return pennant;
  return (
    <span className={["b-callsign-wrap", className].filter(Boolean).join(" ")}>
      {pennant}
      <span className="b-callsign__model">{modelShort(model)}</span>
    </span>
  );
}
