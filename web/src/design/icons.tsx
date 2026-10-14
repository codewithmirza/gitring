/**
 * The gitring icons and the hull shapes of agents, drawn for gitring.
 * They use a 16px grid, a 1.5px stroke, square caps and currentColor. There is no icon library.
 */
import type { CSSProperties, ReactNode } from "react";

const P = (d: string) => <path d={d} />;

export const ICONS = {
  /* ── domain ── */
  compass: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 3.75 9.6 8 8 12.25 6.4 8Z" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M8 3.75 6.4 8h3.2Z" fill="currentColor" stroke="none" />
    </>
  ),
  buoy: P("M8 1.75 14.25 8 8 14.25 1.75 8Z"),
  range: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <circle cx="8" cy="8" r="3" strokeDasharray="1.5 1.6" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  anchor: (
    <>
      <circle cx="8" cy="3.25" r="1.5" />
      <path d="M8 4.75V14.25M5.25 6.75h5.5" />
      <path d="M2.5 9.75c.5 2.6 2.8 4.5 5.5 4.5s5-1.9 5.5-4.5" />
      <path d="M2.5 9.75 4 10.6M13.5 9.75 12 10.6" />
    </>
  ),
  logbook: (
    <>
      <path d="M3.25 2.25h8.5a1 1 0 0 1 1 1v11.5h-8.5a1 1 0 0 1-1-1Z" />
      <path d="M5.75 2.25v12.5M8.25 5.5h2.5M8.25 8h2.5" />
    </>
  ),
  check: P("M3 8.5 6.25 11.75 13 5"),
  cross: P("M4.25 4.25 11.75 11.75M11.75 4.25 4.25 11.75"),
  fork: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="11.5" cy="3.5" r="1.5" />
      <circle cx="8" cy="12.5" r="1.5" />
      <path d="M4.5 5v.75c0 1.8 1.2 2.75 3.5 2.75s3.5-.95 3.5-2.75V5M8 8.5V11" />
    </>
  ),
  plug: (
    <>
      <path d="M5.75 1.75v3M10.25 1.75v3" />
      <path d="M3.75 4.75h8.5V7a4.25 4.25 0 0 1-8.5 0Z" />
      <path d="M8 11.25v3" />
    </>
  ),
  waves: (
    <>
      <path d="M1.5 5.5c1.1-1 2.2-1 3.25 0s2.15 1 3.25 0 2.15-1 3.25 0 2.15 1 3.25 0" />
      <path d="M1.5 10.5c1.1-1 2.2-1 3.25 0s2.15 1 3.25 0 2.15-1 3.25 0 2.15 1 3.25 0" />
    </>
  ),
  lighthouse: (
    <>
      <path d="M6.25 6.25h3.5l1 8h-5.5Z" />
      <path d="M6.75 6.25v-2h2.5v2M8 1.5v.75" />
      <path d="M1.75 3.25l2.75 1.5M14.25 3.25l-2.75 1.5" />
      <path d="M3.5 14.25h9" />
    </>
  ),

  /* ── landing methods ── */
  fastforward: (
    <>
      <path d="M2.25 4 7 8l-4.75 4Z" />
      <path d="M8.5 4 13.25 8 8.5 12Z" />
    </>
  ),
  merge: (
    <>
      <circle cx="4.5" cy="3.25" r="1.5" />
      <circle cx="4.5" cy="12.75" r="1.5" />
      <circle cx="11.5" cy="9.5" r="1.5" />
      <path d="M4.5 4.75v6.5M4.5 5.5c0 2.5 2 4 5.5 4" />
    </>
  ),
  rederive: (
    <>
      <path d="M12.75 6.25A5 5 0 1 0 13 9" />
      <path d="M13.25 2.5v3.75H9.5" />
      <circle cx="8" cy="8.25" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),

  /* ── interface ── */
  plus: P("M8 2.75v10.5M2.75 8h10.5"),
  minus: P("M2.75 8h10.5"),
  close: P("M3.5 3.5l9 9M12.5 3.5l-9 9"),
  "chevron-right": P("M6 3.5 10.5 8 6 12.5"),
  "chevron-left": P("M10 3.5 5.5 8 10 12.5"),
  "chevron-down": P("M3.5 6 8 10.5 12.5 6"),
  "chevron-up": P("M3.5 10 8 5.5 12.5 10"),
  "arrow-right": P("M2.5 8h10.5M9.25 4.25 13 8l-3.75 3.75"),
  "arrow-left": P("M13.5 8H3M6.75 4.25 3 8l3.75 3.75"),
  closing: P("M4 4l7.5 7.5M11.75 6.25v5.5h-5.5"),
  opening: P("M4 12l7.5-7.5M6.25 4.25h5.5v5.5"),
  copy: (
    <>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" />
      <path d="M10.75 2.25h-8.5v8.5" />
    </>
  ),
  external: P("M9 2.25h4.75V7M13.75 2.25 7.5 8.5M11.75 9.75v4h-9.5v-9.5h4"),
  reload: (
    <>
      <path d="M13.25 8A5.25 5.25 0 1 1 11.6 4.2" />
      <path d="M13.25 2.25V5.5H10" />
    </>
  ),
  fit: P("M2.25 6V2.25H6M10 2.25h3.75V6M13.75 10v3.75H10M6 13.75H2.25V10"),
  play: P("M4.75 3v10l8-5Z"),
  stop: <rect x="3.75" y="3.75" width="8.5" height="8.5" />,
  menu: P("M2.25 4.25h11.5M2.25 8h11.5M2.25 11.75h11.5"),
  day: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.2 3.2l1.05 1.05M11.75 11.75l1.05 1.05M3.2 12.8l1.05-1.05M11.75 4.25 12.8 3.2" />
    </>
  ),
  dusk: (
    <>
      <path d="M1.75 11.25h12.5M4.75 14h6.5" />
      <path d="M4.5 11.25a3.5 3.5 0 0 1 7 0" />
      <path d="M8 3.5V5M3.4 5.65l1.05 1.05M12.6 5.65 11.55 6.7" />
    </>
  ),
  night: P("M13 10.1A5.5 5.5 0 0 1 5.9 3a5.5 5.5 0 1 0 7.1 7.1Z"),
  human: (
    <>
      <circle cx="8" cy="5.25" r="2.75" />
      <path d="M2.75 14.25c.55-2.7 2.6-4.25 5.25-4.25s4.7 1.55 5.25 4.25" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.75" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75v.01" />
    </>
  ),
  commit: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M1.25 8h4.25M10.5 8h4.25" />
    </>
  ),
  diff: P("M5.25 2.25v6M2.25 5.25h6M8.25 12.5h6"),
  file: (
    <>
      <path d="M3.25 1.75h6.25l3.25 3.25v9.25h-9.5Z" />
      <path d="M9.25 1.75v3.5h3.5" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.25" y="3.75" width="13.5" height="8.5" />
      <path d="M4 6.75h.01M6.67 6.75h.01M9.33 6.75h.01M12 6.75h.01M5 9.5h6" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />,
  ring: <circle cx="8" cy="8" r="4" />,
  layers: P("M8 2 14 5.25 8 8.5 2 5.25ZM2 8.25l6 3.25 6-3.25M2 11l6 3.25L14 11"),
  pause: P("M5.5 3.5v9M10.5 3.5v9"),
  send: P("M2.25 8h8.5M7.5 4.25 11.25 8 7.5 11.75M13.75 2.5v11"),
  park: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.25 11.25v-6.5h2.5a2 2 0 0 1 0 4h-2.5" />
    </>
  ),
  amend: P("M10.25 2.75 13.25 5.75 6 13H3v-3ZM8.75 4.25l3 3"),
  launch: (
    <>
      <path d="M8 1.75v8.5M4.75 5 8 1.75 11.25 5" />
      <path d="M2.25 10.5v3.75h11.5V10.5" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8c1.6-3 3.8-4.5 6.5-4.5s4.9 1.5 6.5 4.5c-1.6 3-3.8 4.5-6.5 4.5S3.1 11 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  filter: P("M2 3.25h12l-4.5 5.25v5L6.5 15V8.5Z"),
  grid: P("M2.25 2.25h11.5v11.5H2.25ZM6.08 2.25v11.5M9.92 2.25v11.5M2.25 6.08h11.5M2.25 9.92h11.5"),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25 13.75 13.75" />
    </>
  ),
  code: P("M5.5 4.25 1.75 8l3.75 3.75M10.5 4.25 14.25 8l-3.75 3.75"),
  key: (
    <>
      <circle cx="5.25" cy="10.75" r="2.75" />
      <path d="M7.25 8.75 13.25 2.75M10.75 5.25l1.75 1.75M12.25 3.75 14 5.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" />
    </>
  ),
  apps: P("M2.25 2.25h4.5v4.5h-4.5ZM9.25 2.25h4.5v4.5h-4.5ZM2.25 9.25h4.5v4.5h-4.5ZM9.25 9.25h4.5v4.5h-4.5Z"),
  "sign-out": P("M6.25 2.25h-4v11.5h4M10.25 4.75 13.5 8l-3.25 3.25M13.25 8h-7"),
  folder: P("M1.75 3.25h4.5l1.5 1.75h6.5v7.75H1.75Z"),
  inbox: P("M2.25 9.25h3.25l1 1.75h3l1-1.75h3.25M4 3.25h8l1.75 6v4.5H2.25v-4.5Z"),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  size?: number;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  title?: string;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, title, className, style, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={className ? `b-icon ${className}` : "b-icon"}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

/* ───────────── hull shapes (6) ───────────── */

export const HULL_NAMES = ["arrow", "chevron", "dart", "kite", "notch", "wedge"] as const;
export type HullName = (typeof HULL_NAMES)[number];

/** Hull outlines on a 16×16 grid, bow pointing north. */
export const HULL_PATHS: Record<HullName, string> = {
  arrow: "M8 1.5 13.5 14.5H2.5Z",
  chevron: "M8 1.5 14 14.5 8 11 2 14.5Z",
  dart: "M8 1 11.5 12.5 8 15 4.5 12.5Z",
  kite: "M8 1.5 13 6.5 8 14.5 3 6.5Z",
  notch: "M8 1.5 13 6V14.5L8 12 3 14.5V6Z",
  wedge: "M8 1.5C11 3.5 12.5 7 12.5 14.5H3.5C3.5 7 5 3.5 8 1.5Z",
};

export function hullName(index: number): HullName {
  return HULL_NAMES[((index % 6) + 6) % 6];
}

export interface HullProps {
  hull: HullName;
  size?: number;
  /** Heading in degrees, 0 = north. */
  heading?: number;
  color?: string;
  title?: string;
  className?: string;
}

export function Hull({ hull, size = 16, heading = 0, color = "currentColor", title, className }: HullProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className ? `b-hull ${className}` : "b-hull"}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        d={HULL_PATHS[hull]}
        fill={color}
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
        transform={heading ? `rotate(${heading} 8 8)` : undefined}
      />
    </svg>
  );
}

/* ───────────── logo mark: compass rose ───────────── */

/**
 * The gitring mark. A four-point compass rose; each point has a filled half and an
 * open half, like the rose on a printed chart. The north half carries the accent.
 */
export function Mark({ size = 20, title = "gitring", accent = true }: { size?: number; title?: string; accent?: boolean }) {
  const c = 16;
  const tip = 14.5;
  const w = 2.4;
  const pts = {
    n: [c, c - tip],
    e: [c + tip, c],
    s: [c, c + tip],
    w: [c - tip, c],
    ne: [c + w, c - w],
    se: [c + w, c + w],
    sw: [c - w, c + w],
    nw: [c - w, c - w],
  } as const;
  const tri = (a: readonly number[], b: readonly number[]) => `M${c} ${c} ${a[0]} ${a[1]} ${b[0]} ${b[1]}Z`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className="b-mark"
      role="img"
      aria-label={title}
      focusable="false"
    >
      <circle cx={c} cy={c} r="11" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <g strokeWidth="1" strokeLinejoin="round" stroke="currentColor">
        <path d={tri(pts.n, pts.ne)} fill="var(--bg)" />
        <path d={tri(pts.n, pts.nw)} fill={accent ? "var(--accent)" : "currentColor"} stroke={accent ? "var(--accent)" : "currentColor"} />
        <path d={tri(pts.e, pts.se)} fill="var(--bg)" />
        <path d={tri(pts.e, pts.ne)} fill="currentColor" />
        <path d={tri(pts.s, pts.sw)} fill="var(--bg)" />
        <path d={tri(pts.s, pts.se)} fill="currentColor" />
        <path d={tri(pts.w, pts.nw)} fill="var(--bg)" />
        <path d={tri(pts.w, pts.sw)} fill="currentColor" />
      </g>
    </svg>
  );
}
