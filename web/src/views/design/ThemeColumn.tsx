/**
 * One theme of the style guide: its color tokens with their contrast, and the 12 agent colors.
 * It reads the real computed colors, so the numbers cannot drift from the product.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { HULL_NAMES, Hull, Icon, type IconName } from "../../design/icons";
import { THEMES, type Theme } from "../../design/theme";
import { contrast, toHex, tokenRgb } from "../../design/color";
import { MiniChart } from "./demos";

const BASE_TOKENS: [string, string, "text" | "ui" | "surface" | "land"][] = [
  ["--bg", "Chart water, page", "surface"],
  ["--surface-1", "Rails, panels", "surface"],
  ["--surface-2", "Raised rows, inputs", "surface"],
  ["--line", "Hairline dividers", "ui"],
  ["--line-strong", "Input borders (≥3:1)", "ui"],
  ["--ink-1", "Primary text", "text"],
  ["--ink-2", "Secondary text", "text"],
  ["--ink-3", "Muted text", "text"],
  ["--land", "Code islands", "land"],
  ["--land-edge", "Coastline", "ui"],
  ["--shoal", "Activity, hover water", "surface"],
];
const SIGNAL_TOKENS: [string, string, IconName][] = [
  ["--accent", "Interaction, focus", "compass"],
  ["--magenta", "Correction only", "buoy"],
  ["--clear", "Clear, pass, landed", "check"],
  ["--danger", "Collision, failure", "cross"],
  ["--caution", "Closing, waiting", "range"],
  ["--caution-fill", "Caution fill (dark text)", "range"],
];

export function ThemeColumn({ theme }: { theme: Theme }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [vals, setVals] = useState<Record<string, { value: string; hex: string; ratio: number | null }>>({});
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bg = tokenRgb(el, "--bg").rgb;
    const ink = tokenRgb(el, "--ink-1").rgb;
    const land = tokenRgb(el, "--land").rgb;
    const onCaution = tokenRgb(el, "--on-caution").rgb;
    const out: typeof vals = {};
    const all = [...BASE_TOKENS.map((t) => t[0]), ...SIGNAL_TOKENS.map((t) => t[0]), ...Array.from({ length: 12 }, (_, i) => `--v${i}`)];
    for (const name of all) {
      const { value, rgb } = tokenRgb(el, name);
      let ratio: number | null = null;
      if (rgb && bg && ink) {
        const kind = BASE_TOKENS.find((t) => t[0] === name)?.[2];
        if (kind === "surface" || kind === "land") ratio = contrast(rgb, ink);
        else if (name === "--caution-fill" && onCaution) ratio = contrast(rgb, onCaution);
        else if (name.startsWith("--v") && land) ratio = Math.min(contrast(rgb, bg), contrast(rgb, land));
        else ratio = contrast(rgb, bg);
      }
      out[name] = { value: value.replace(/\s+/g, " "), hex: rgb ? toHex(rgb) : "", ratio };
    }
    setVals(out);
  }, [theme]);
  const meta = THEMES.find((t) => t.id === theme)!;
  const rat = (name: string, min: number) => {
    const r = vals[name]?.ratio;
    if (r == null) return null;
    return (
      <span className={["ds-ratio", r >= min ? "is-ok" : "is-low"].join(" ")} title={`Contrast ${r.toFixed(2)}:1, target ${min}:1`}>
        {r.toFixed(1)}
      </span>
    );
  };
  return (
    <div className="ds-theme" data-theme={theme} ref={ref}>
      <div className="ds-theme__head">
        <Icon name={theme} />
        <span className="ds-theme__name">{meta.label}</span>
        <span className="ds-theme__help">{meta.help}</span>
      </div>
      <MiniChart />
      <ul className="ds-swatches" aria-label={`${meta.label} base tokens`}>
        {BASE_TOKENS.map(([name, role, kind]) => (
          <li key={name}>
            <span className="ds-chip" style={{ background: `var(${name})` }} />
            <span className="ds-sw__name voice-agent">{name}</span>
            <span className="ds-sw__role">{role}</span>
            {rat(name, kind === "text" ? 4.5 : kind === "ui" ? (name === "--line" ? 1 : 3) : 4.5)}
          </li>
        ))}
      </ul>
      <ul className="ds-swatches" aria-label={`${meta.label} signal tokens`}>
        {SIGNAL_TOKENS.map(([name, role, icon]) => (
          <li key={name}>
            <span className="ds-chip" style={{ background: `var(${name})` }} />
            <span className="ds-sw__name voice-agent">{name}</span>
            <span className="ds-sw__role">
              <Icon name={icon} size={12} /> {role}
            </span>
            {rat(name, 4.5)}
          </li>
        ))}
      </ul>
      <div className="ds-vessels" aria-label={`${meta.label} vessel identity colors`}>
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className="ds-vessel" title={`--v${i} ${vals[`--v${i}`]?.value ?? ""} · ${vals[`--v${i}`]?.ratio?.toFixed(1) ?? ""}:1 on water and land`}>
            <Hull hull={HULL_NAMES[i % 6]} size={16} color={`var(--v${i})`} />
            <span className="voice-agent">{i}</span>
          </span>
        ))}
      </div>
      <p className="ds-theme__values voice-agent">
        bg {vals["--bg"]?.value} · accent {vals["--accent"]?.value}
      </p>
    </div>
  );
}
