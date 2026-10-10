import type { Range } from "../../../../src/core/types";
import { distanceLabel, RANGE_TEXT } from "../../state/format";
import { rangeTone } from "../../state/selectors";
import { Icon } from "../icons";

interface RangeIndicatorProps {
  range: Range;
  closing?: boolean;
  corrected?: boolean;
  /** Show "moving closer" as text (the arrow is always there when the work moves closer). */
  showText?: boolean;
  to?: string;
}

/**
 * RangeIndicator: the distance between two pieces of work ("same file") + ring icon + an arrow
 * when they move closer. Distance 0–1 danger, 2–3 caution, 4–5 neutral; magenta after a change request.
 */
export function RangeIndicator({ range, closing, corrected, showText = true, to }: RangeIndicatorProps) {
  const tone = corrected ? "correction" : range <= 1 ? "danger" : range <= 3 ? "caution" : "neutral";
  const label = `${distanceLabel(range)}${closing ? ", moving closer" : ""}${corrected ? ", change request sent" : ""}${to ? `, to ${to}` : ""}`;
  return (
    <span className={`b-range b-range--${tone}`} role="img" aria-label={label} title={label}>
      <Icon name={corrected ? "buoy" : "range"} />
      <span aria-hidden="true">{RANGE_TEXT[range]}</span>
      {closing && <Icon name="closing" />}
      {closing && showText && (
        <span className="b-range__closing" aria-hidden="true">
          moving closer
        </span>
      )}
    </span>
  );
}

export { rangeTone };
