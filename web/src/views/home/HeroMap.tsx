/**
 * A drawing of the idea in the vocabulary of the map: two agents plan to change the same lines, and one gets a change request.
 * The start page shows it next to the headline. It is a still drawing, not a live map. It has no data and no motion.
 * It uses the tokens and the shapes of the real map (src/chart), so a stranger knows the map when the person opens a project.
 */
import type { CSSProperties } from "react";
import { HULL_PATHS, type HullName } from "../../design/icons";
import "./hero-map.css";

/* ───────────── what the drawing holds ───────────── */

const WIDTH = 380;
const HEIGHT = 288;
const STEP = 64;

const ISLAND = { x: 46, y: 62, w: 288, h: 170 };
const CART = { x: 60, y: 90, w: 110, h: 128 };
const PRICE = { x: 186, y: 90, w: 134, h: 128 };

interface Agent {
  callsign: string;
  color: number;
  hull: HullName;
  x: number;
  y: number;
  heading: number;
}

const HERON: Agent = { callsign: "HERON-2", color: 0, hull: "arrow", x: 206, y: 154, heading: 0 };
const PETREL: Agent = { callsign: "PETREL-9", color: 5, hull: "wedge", x: 82, y: 190, heading: 81 };

const colour = (n: number) => ({ "--vc": `var(--v${n})` }) as CSSProperties;

/* ───────────── parts ───────────── */

/** The frame of the chart: a double rule, the scale bars and the letters of the grid. */
function Frame() {
  const columns = [70, 134, 198, 262, 326];
  const rows = [58, 122, 186, 250];
  return (
    <g aria-hidden="true">
      <g className="hm-grat">
        {columns.map((x) => (
          <line key={x} x1={x} y1={6} x2={x} y2={HEIGHT - 6} />
        ))}
        {rows.map((y) => (
          <line key={y} x1={6} y1={y} x2={WIDTH - 6} y2={y} />
        ))}
      </g>
      {[6, 70, 134, 198, 262, 326].map((x, i) =>
        i % 2 === 0 ? (
          <g key={x}>
            <rect className="hm-bar" x={x} y={2} width={Math.min(STEP, WIDTH - 6 - x)} height={3} />
            <rect className="hm-bar" x={x} y={HEIGHT - 5} width={Math.min(STEP, WIDTH - 6 - x)} height={3} />
          </g>
        ) : null,
      )}
      <rect className="hm-rule" x={0.5} y={0.5} width={WIDTH - 1} height={HEIGHT - 1} />
      <rect className="hm-rule" x={5.5} y={5.5} width={WIDTH - 11} height={HEIGHT - 11} />
      {["B", "C", "D", "E", "F"].map((letter, i) => (
        <text key={letter} className="hm-tick" x={columns[i] + 4} y={20}>
          {letter}
        </text>
      ))}
      {["1", "2", "3", "4"].map((n, i) => (
        <text key={n} className="hm-tick" x={12} y={rows[i] - 4}>
          {n}
        </text>
      ))}
    </g>
  );
}

/** The land of the project: one island with two files, the sea around it, and the rings of the plans on one file. */
function Land() {
  const { x, y, w, h } = ISLAND;
  return (
    <g aria-hidden="true">
      <rect className="hm-depth" x={x - 30} y={y - 30} width={w + 60} height={h + 60} rx={26} />
      <rect className="hm-shoal" x={x - 13} y={y - 13} width={w + 26} height={h + 26} rx={14} />
      <rect className="hm-island" x={x} y={y} width={w} height={h} rx={5} />
      <text className="hm-island__label" x={x + 8} y={y + 15}>
        src/
      </text>
      {[
        { box: CART, name: "cart.js", size: "152 B" },
        { box: PRICE, name: "price.js", size: "179 B" },
      ].map(({ box, name, size }) => (
        <g key={name}>
          <rect className="hm-parcel" x={box.x} y={box.y} width={box.w} height={box.h} rx={1.5} />
          <text className="hm-parcel__name" x={box.x + 6} y={box.y + 15}>
            {name}
          </text>
          <text className="hm-parcel__size" x={box.x + 6} y={box.y + 29}>
            {size}
          </text>
        </g>
      ))}
      {[4, 8].map((o) => (
        <rect key={o} className="hm-contour" x={PRICE.x - o} y={PRICE.y - o} width={PRICE.w + o * 2} height={PRICE.h + o * 2} rx={2 + o} />
      ))}
    </g>
  );
}

/** The plan of PETREL-9: it has changed cart.js and its next file is price.js, where HERON-2 works. */
function Plans() {
  const anchor = { x: PRICE.x + PRICE.w / 2 + 14, y: PRICE.y + PRICE.h / 2 + 22 };
  return (
    <g aria-hidden="true">
      <path className="hm-course" style={colour(PETREL.color)} d={`M${PETREL.x} ${PETREL.y} L${anchor.x} ${anchor.y}`} />
      <circle className="hm-waypoint" style={colour(PETREL.color)} cx={anchor.x} cy={anchor.y} r={3} />
    </g>
  );
}

/** The dashed line between two agents whose plans meet, with its label. Magenta is the colour of a change request. */
function Meeting() {
  const mx = PETREL.x + (HERON.x - PETREL.x) * 0.6;
  const my = PETREL.y + (HERON.y - PETREL.y) * 0.6;
  const label = "same lines";
  const width = label.length * 6.1 + 12;
  return (
    <g className="hm-range" aria-hidden="true">
      <line x1={PETREL.x} y1={PETREL.y} x2={HERON.x} y2={HERON.y} />
      <rect className="hm-range__bg" x={mx - width / 2} y={my - 9} width={width} height={18} rx={2} />
      <text className="hm-range__text" x={mx} y={my + 4} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

/** One agent: its hull, its heading mark and its callsign flag. */
function Vessel({ agent }: { agent: Agent }) {
  const tagWidth = agent.callsign.length * 6.7 + 26;
  return (
    <g className="hm-vessel" style={colour(agent.color)} transform={`translate(${agent.x} ${agent.y})`} aria-hidden="true">
      <line className="hm-heading" x1={0} y1={-9} x2={0} y2={-20} transform={`rotate(${agent.heading})`} />
      <path className="hm-hull" d={HULL_PATHS[agent.hull]} transform={`rotate(${agent.heading}) translate(-8 -8)`} />
      <g transform="translate(12 -10)">
        <path className="hm-tag__bg" d={`M9 0 H${tagWidth} L${tagWidth - 5} 9 L${tagWidth} 18 H9 A9 9 0 0 1 9 0 Z`} />
        <path className="hm-tag__hull" d={HULL_PATHS[agent.hull]} transform="translate(5 4.5) scale(0.56)" />
        <text className="hm-tag__text" x={17} y={12.5}>
          {agent.callsign}
        </text>
      </g>
    </g>
  );
}

/** The change request: a magenta diamond on the file where the two plans meet. */
function Buoy() {
  const x = PRICE.x + PRICE.w - 14;
  const y = PRICE.y + PRICE.h - 16;
  return (
    <g className="hm-buoy" transform={`translate(${x} ${y})`} aria-hidden="true">
      <path className="hm-buoy__mark" d="M0 -7 L7 0 L0 7 L-7 0 Z" />
      <text className="hm-buoy__label" x={-12} y={4} textAnchor="end">
        change request
      </text>
    </g>
  );
}

/* ───────────── the figure ───────────── */

export function HeroMap() {
  return (
    <figure className="hm">
      <svg className="hm__svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby="hm-title">
        <title id="hm-title">
          A drawing of the map of gitring. Two agents, HERON-2 and PETREL-9, plan to change the same lines of price.js. gitring puts a change request on that file
          and sends it to PETREL-9.
        </title>
        <rect className="hm-water" x={0} y={0} width={WIDTH} height={HEIGHT} />
        <Frame />
        <Land />
        <Plans />
        <Meeting />
        <Buoy />
        <Vessel agent={PETREL} />
        <Vessel agent={HERON} />
      </svg>
      <figcaption className="hm__caption">
        The map of a project. Two agents plan to change the same lines. gitring sends one of them a change request.
      </figcaption>
    </figure>
  );
}
