import type { ReactNode } from "react";
import { HULL_PATHS } from "../design/icons";

/** Map legend: every symbol with one STE line. Shared by the overview and the design page. */
export function ChartLegend({ wide = false }: { wide?: boolean }) {
  const row = (art: ReactNode, text: string, key: string) => (
    <li key={key} className="c-legend__row">
      <svg width="40" height="18" viewBox="0 0 40 18" aria-hidden="true" className="c-legend__art">
        {art}
      </svg>
      <span>{text}</span>
    </li>
  );
  return (
    <ul className={["c-legend", wide && "c-legend--wide"].filter(Boolean).join(" ")} aria-label="Legend">
      {row(
        <g style={{ ["--vc" as string]: "var(--v0)" }}>
          <path className="c-vessel__hull" d={HULL_PATHS.arrow} transform="translate(4 1) rotate(90 8 8)" />
          <line className="c-vessel__heading" x1="21" y1="9" x2="34" y2="9" />
        </g>,
        "An agent and its direction",
        "vessel",
      )}
      {row(<path className="c-course-pending" d="M2 9 H38" style={{ ["--vc" as string]: "var(--v0)" }} />, "Plan sent: the conflict check runs", "course-pending")}
      {row(
        <g style={{ ["--vc" as string]: "var(--v0)" }}>
          <path className="c-course" d="M2 9 H34" />
          <circle className="c-waypoint" cx="35" cy="9" r="3" />
        </g>,
        "Plan without conflict: the files that come next",
        "course",
      )}
      {row(<path className="c-wake" d="M2 9 H38" style={{ ["--vc" as string]: "var(--v0)" }} />, "Files touched", "wake")}
      {row(
        <g className="c-range c-range--caution">
          <line x1="2" y1="9" x2="38" y2="9" />
        </g>,
        "Two agents work close: distance 2 or less",
        "range",
      )}
      {row(
        <g className="c-range c-range--correction">
          <line x1="2" y1="9" x2="38" y2="9" />
        </g>,
        "Close work after a change request",
        "range-c",
      )}
      {row(
        <g className="c-range c-range--danger">
          <line x1="2" y1="9" x2="38" y2="9" />
        </g>,
        "Distance 0 and no change request: risk of a conflict",
        "range-d",
      )}
      {row(
        <g className="c-buoy" transform="translate(20 9)">
          <path className="c-buoy__mark" d="M0 -6 L6 0 L0 6 L-6 0 Z" />
        </g>,
        "Change-request marker: a change request in this file",
        "buoy",
      )}
      {row(
        <g>
          <rect className="c-island" x="4" y="3" width="32" height="12" rx="2" />
          <rect className="c-contour" x="1" y="0.5" width="38" height="17" rx="5" />
        </g>,
        "Work area: agents work in this file",
        "contour",
      )}
      <li className="c-legend__scale voice-agent">
        Distance: 0 same lines · 1 shared function · 2 same file · 3 one import · 4 two imports · 5 no relation
      </li>
    </ul>
  );
}
