/**
 * The last sections of the style guide: chart primitives, patterns, accessibility and the copy rules.
 */
import type { ReactNode } from "react";
import { HULL_PATHS, Icon } from "../../design/icons";
import { ChartLegend } from "../../chart/ChartLegend";
import { Link } from "../../app/router";
import { Section, Specimen } from "./parts";

export function ChartAndRules() {
  return (
    <>
        <Section id="chart" title="Chart primitives" lede="The chart is SVG. Geometry is in world units; hairlines do not scale; glyphs and labels keep their screen size when you zoom.">
          <div className="ds-prims">
            {[
              ["Island", "A directory. --land fill, --land-edge coastline, mono label top-left.", <g key="i"><rect x="6" y="8" width="108" height="56" rx="14" className="c-shoal" /><rect x="14" y="16" width="92" height="40" rx="4" className="c-island" /><text x="18" y="27" className="c-island-label" fontSize="8">src/</text></g>],
              ["Parcel", "A file inside an island (squarified treemap). Hover: --shoal. Label when it fits.", <g key="p"><rect x="10" y="12" width="100" height="48" rx="4" className="c-island" /><g className="c-parcel"><rect x="16" y="18" width="52" height="36" /><rect x="72" y="18" width="32" height="36" /></g><rect x="72" y="18" width="32" height="36" className="c-parcel-hover" /><text x="20" y="29" className="c-parcel-label" fontSize="8">render.js</text><text x="20" y="40" className="c-sounding" fontSize="8">1.8 kB</text></g>],
              ["Contour", "Activity: 1–3 hairline rings at 35% accent. More vessels, more rings.", <g key="c"><rect x="30" y="22" width="60" height="28" rx="2" className="c-island" />{[4, 8, 12].map((o) => <rect key={o} x={30 - o} y={22 - o} width={60 + o * 2} height={28 + o * 2} rx={2 + o} className="c-contour" />)}</g>],
              ["Vessel", "Hull in identity color, rotated to its heading, with a callsign pennant.", <g key="v" style={{ ["--vc" as string]: "var(--v0)" }}><line className="c-vessel__heading" x1="34" y1="27" x2="34" y2="16" /><path className="c-vessel__hull" d={HULL_PATHS.arrow} transform="translate(26 28)" /><g className="c-tag" transform="translate(48 26)"><path className="c-tag__bg" d="M9 0 H72 L67 9 L72 18 H9 A9 9 0 0 1 9 0 Z" /><text className="c-tag__text" x="14" y="12.5">KESTREL-7</text></g></g>],
              ["Course line", "Dashed while the check runs; solid when clear. Waypoints on declared files.", <g key="cl" style={{ ["--vc" as string]: "var(--v2)" }}><path className="c-course-pending" d="M10 24 H110" /><path className="c-course" d="M10 48 H100" /><circle className="c-waypoint" cx="104" cy="48" r="3" /></g>],
              ["Wake", "Solid hairline through touched files at 40%.", <g key="w" style={{ ["--vc" as string]: "var(--v5)" }}><path className="c-wake" d="M10 50 L40 30 L80 42 L110 22" /></g>],
              ["Range line", "Range ≤ 2: caution; magenta after a correction; danger at R0 with no correction.", <g key="r"><g className="c-range c-range--caution"><line x1="10" y1="16" x2="110" y2="16" /></g><g className="c-range c-range--correction"><line x1="10" y1="36" x2="110" y2="36" /></g><g className="c-range c-range--danger"><line x1="10" y1="56" x2="110" y2="56" /></g></g>],
              ["Buoy", "Magenta diamond where a correction applies. Filled: pending. Open: acknowledged.", <g key="b"><g className="c-buoy" transform="translate(40 36)"><path className="c-buoy__mark" d="M0 -8 L8 0 L0 8 L-8 0 Z" /><text className="c-buoy__label" x="11" y="-6">R3</text></g><g className="c-buoy is-done" transform="translate(84 36)"><path className="c-buoy__mark" d="M0 -8 L8 0 L0 8 L-8 0 Z" /></g></g>],
              ["Landing ripple", "Changed parcels flash --clear at 30% for 800 ms. No flash with reduced motion.", <g key="lr"><rect x="20" y="16" width="80" height="40" rx="3" className="c-island" /><rect x="20" y="16" width="80" height="40" rx="3" fill="var(--clear)" opacity=".3" /></g>],
              ["Graticule and frame", "Grid every 64 units at 50% --line. Double rule with alternating scale bars.", <g key="g"><rect x="2" y="2" width="116" height="68" fill="none" className="c-frame__rule" /><rect x="7" y="7" width="106" height="58" fill="none" className="c-frame__rule" />{[0, 2, 4].map((k) => <rect key={k} x={7 + k * 21} y="3" width="21" height="3" className="c-frame__bar" />)}{[28, 49, 70, 91].map((x) => <line key={x} x1={x} y1="8" x2={x} y2="64" className="ds-grat" />)}<text x="30" y="16" className="c-tick">C</text></g>],
            ].map(([t, note, art]) => (
              <figure key={t as string} className="ds-prim">
                <svg viewBox="0 0 120 72" aria-hidden="true">
                  {art as ReactNode}
                </svg>
                <figcaption>
                  <span className="ds-h3">{t as string}</span>
                  <span className="ink-2">{note as string}</span>
                </figcaption>
              </figure>
            ))}
          </div>
          <Specimen title="Legend" note="The chart carries the same legend in its title block." wide>
            <ChartLegend wide />
          </Specimen>
        </Section>

        <Section id="patterns" title="Patterns" lede="How the pieces work together. Each pattern lives in the product.">
          <ol className="ds-patterns">
            {[
              ["Declare → check → clear or correct", "A vessel appears with a dashed course. The course check runs in about 40 ms. Clear: the course turns solid. Correction: a buoy appears on the shared file and the radio log names the rule.", "/", "Open the chart"],
              ["Expand, then narrow", "Launch asks for the fan-out (1–4) and the models. The intent view shows all attempts as lanes. A human lands one.", "/intents", "Open the intents"],
              ["Alternates shelf", "After a landing, sibling attempts stay in the intent view, dimmed and labeled “Alternate”, with their preview and diff.", "/intents/in-picks", "See an alternate"],
              ["Living spec", "An intent shows its version and its amendments: who, why, text. Corrections that change scope amend the constraints.", "/intents/in-search", "See a living spec"],
              ["Judgment queue", "The top bar shows only the decisions that need a human. The project decides which merges need one.", "/", "See the queue"],
              ["Why trail", "From any landing: intent → course → corrections → checks → decision → diff.", "/logbook", "Open the logbook"],
              ["Connect other apps", "One screen shows how inputs arrive and where outputs go.", "/connect", "Open Connect"],
              ["Theme", "Day, Dusk and Night in the top bar. The choice persists per viewer.", "/design#themes", "See the themes"],
            ].map(([t, d, to, cta], i) => (
              <li key={t}>
                <span className="ds-pn voice-agent">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3 className="ds-h3">{t}</h3>
                  <p className="ink-2">{d}</p>
                  <Link to={to}>{cta}</Link>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="a11y" title="Accessibility" lede="WCAG 2.1 AA. The chart has a text twin: the Traffic list shows every vessel, range and correction as rows.">
          <ul className="ds-checklist">
            {[
              "Text contrast 4.5:1 or more; UI boundaries and chart objects 3:1 or more.",
              "Every interactive element has a visible focus ring: 2px accent, 2px offset.",
              "Tab moves through the rails and the vessels. Arrow keys pan the chart; + and − zoom; 0 fits.",
              "Enter opens; Escape closes; g c, g i, g l go to Chart, Intents, Logbook; ? lists the shortcuts.",
              "The radio log is a polite live region. Corrections are announced once.",
              "Hit targets are 24×24px or more (32px preferred).",
              "Reduced motion: no movement transitions, fades of 120 ms or less, no pulses.",
              "The UI works at 320px: rails collapse into tabs and the chart stays pannable.",
            ].map((x) => (
              <li key={x}>
                <Icon name="check" size={14} />
                {x}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="copy" title="Copy rules" lede="All UI copy and every message to agents follows ASD-STE100 Simplified Technical English.">
          <table className="ds-dodont">
            <thead>
              <tr>
                <th scope="col">Do</th>
                <th scope="col">Don't</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Land attempt", "Merge this pull request"],
                ["Land this attempt.", "This attempt can be landed."],
                ["The fork is not ready. Try again in 5 seconds.", "Oops! Something went wrong."],
                ["Checks fail on main. Re-derive the attempt.", "Re-deriving due to failing checks…"],
                ["Do not edit lines 18–40 of src/render.js. Continue your work.", "Please avoid making changes to the header area if possible."],
                ["Use the glossary: intent, attempt, course, correction, traffic, landing, logbook, chart, vessel.", "Mix synonyms: task, PR, branch, conflict, merge request."],
                ["Sentence case. Callsigns stay uppercase: KESTREL-7.", "ALL-CAPS LABELS."],
              ].map(([d, n]) => (
                <tr key={d}>
                  <td>
                    <Icon name="check" size={14} /> {d}
                  </td>
                  <td>
                    <Icon name="cross" size={14} /> {n}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ds-credit">
            Principles inspired by Paper's essay “A real space to design in the age of agents” (Agu Seguí, 2026) and by ship chart display standards (ECDIS
            Day/Dusk/Night palettes). Fonts: Atkinson Hyperlegible Next and Mono (Braille Institute, OFL 1.1), Source Serif 4 (Adobe, OFL 1.1).
          </p>
        </Section>
    </>
  );
}
