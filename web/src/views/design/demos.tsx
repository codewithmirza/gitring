/**
 * Two demos of the style guide: a sample chart in SVG, and the motion demo.
 */
import { useState, type CSSProperties } from "react";
import { Button } from "../../design/components";
import { HULL_PATHS } from "../../design/icons";

export function MiniChart() {
  return (
    <svg className="ds-minichart" viewBox="0 0 320 120" role="img" aria-label="A chart sample: an island with files, two vessels at range R1 and a correction buoy">
      <rect width="320" height="120" className="c-water" />
      {[40, 80, 120, 160, 200, 240, 280].map((x) => (
        <line key={x} x1={x} y1={0} x2={x} y2={120} className="ds-grat" />
      ))}
      {[40, 80].map((y) => (
        <line key={y} x1={0} y1={y} x2={320} y2={y} className="ds-grat" />
      ))}
      <rect x="40" y="18" width="190" height="88" rx="14" className="c-shoal" />
      <rect x="52" y="30" width="166" height="64" rx="5" className="c-island" />
      <g className="c-parcel">
        <rect x="60" y="44" width="78" height="42" />
        <rect x="142" y="44" width="68" height="42" />
      </g>
      <text x="60" y="40" className="c-island-label" fontSize="8">
        src/
      </text>
      <text x="64" y="55" className="c-parcel-label" fontSize="8">
        render.js
      </text>
      <rect x="57" y="41" width="84" height="48" rx="4" className="c-contour" />
      <g className="c-range c-range--correction">
        <line x1="78" y1="70" x2="168" y2="70" />
      </g>
      <g className="c-buoy" transform="translate(130 52)">
        <path className="c-buoy__mark" d="M0 -5 L5 0 L0 5 L-5 0 Z" />
      </g>
      <g style={{ ["--vc" as string]: "var(--v0)" }}>
        <path className="c-vessel__hull" d={HULL_PATHS.arrow} transform="translate(70 62) scale(.9)" />
      </g>
      <g style={{ ["--vc" as string]: "var(--v2)" }}>
        <path className="c-vessel__hull" d={HULL_PATHS.dart} transform="translate(160 62) scale(.9) rotate(-90 8 8)" />
      </g>
      <g transform="translate(276 82)" className="c-rose">
        <circle r="18" />
        <path className="c-rose__dark" d="M0 0 L0 -14 L-3 -3Z" />
        <path className="c-rose__light" d="M0 0 L0 -14 L3 -3Z" />
      </g>
    </svg>
  );
}

/* ───────────── motion demo ───────────── */

export function MotionDemo() {
  const [at, setAt] = useState(false);
  const [pulse, setPulse] = useState(0);
  return (
    <div className="ds-motion">
      <svg viewBox="0 0 360 64" className="ds-motion__track" aria-hidden="true">
        <line x1="24" y1="32" x2="336" y2="32" className="c-wake" style={{ ["--vc" as string]: "var(--v5)" }} />
        <g className="ds-motion__vessel" style={{ transform: `translate(${at ? 320 : 24}px, 32px)`, ["--vc" as string]: "var(--v5)" } as CSSProperties}>
          <path className="c-vessel__hull" d={HULL_PATHS.wedge} transform="rotate(90) translate(-8 -8)" />
        </g>
        {pulse > 0 && (
          <g key={pulse} transform="translate(180 32)">
            <circle className="c-pulse" r="22" />
          </g>
        )}
      </svg>
      <div className="ds-motion__actions">
        <Button size="sm" icon="play" onClick={() => setAt(!at)}>
          Move vessel (--dur-track)
        </Button>
        <Button size="sm" icon="range" onClick={() => setPulse((p) => p + 1)}>
          Pulse once
        </Button>
      </div>
    </div>
  );
}
