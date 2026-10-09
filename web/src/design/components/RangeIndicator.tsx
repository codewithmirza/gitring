import type { Range } from "../../../../src/core/types";
import { RANGE_TEXT } from "../../state/format";
import { rangeTone } from "../../state/selectors";
import { Icon } from "../icons";

interface RangeIndicatorProps {
  range: Range;
  closing?: boolean;
  corrected?: boolean;
  /** Show "closing" as text (the arrow is always there when closing). */
  showText?: boolean;
  to?: string;
}

/**
 * RangeIndicator: "R2" + ring icon + closing arrow. R0–R1 danger, R2–R3 caution,
 * R4–R5 neutral; magenta when a correction covers the pair.
 */
export function RangeIndicator({ range, closing, corrected, showText = true, to }: RangeIndicatorProps) {
  const tone = corrected ? "correction" : range <= 1 ? "danger" : range <= 3 ? "caution" : "neutral";
  const label = `Range R${range}, ${RANGE_TEXT[range]}${closing ? ", closing" : ""}${corrected ? ", corrected" : ""}${to ? `, to ${to}` : ""}`;
  return (
    <span className={`b-range b-range--${tone}`} role="img" aria-label={label} title={label}>
      <Icon name={corrected ? "buoy" : "range"} />
      <span aria-hidden="true">R{range}</span>
      {closing && <Icon name="closing" />}
      {closing && showText && (
        <span className="b-range__closing" aria-hidden="true">
          closing
        </span>
      )}
    </span>
  );
}

export { rangeTone };
