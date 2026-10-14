/**
 * The foundations of the style guide: principles, themes and color, the three voices, type, space, motion and icons.
 */
import { HULL_NAMES, Hull, Icon, Mark } from "../../design/icons";
import { THEMES } from "../../design/theme";
import { FONTS } from "../../design/fonts";
import { ThemeColumn } from "./ThemeColumn";
import { MotionDemo } from "./demos";
import { Section, Specimen } from "./layout";
import type { DesignState } from "./useDesignState";

export function Foundations({ samples }: { samples: DesignState }) {
  const { iconNames } = samples;
  return (
    <>
      <Section
        id="principles"
        title="Principles"
        lede={
          <>
            Learned from Paper's essay <em>“A real space to design in the age of agents”</em> (Agu Seguí, 2026). We use the ideas, not their visual skin. Our
            analog counterweight is the nautical chart.
          </>
        }
      >
        <ol className="ds-principles">
          {[
            ["The bottleneck moved to the human mind.", "Design for good human judgment, not for agent volume. Show decisions, not noise."],
            ["Spatial thinking keeps many futures visible.", "The home screen is a chart, not a chat and not a list of pull requests."],
            ["Keep the road not taken visible.", "Attempts that did not land stay as alternates. We never delete them."],
            ["Expand before you narrow.", "Fan out attempts, compare them side by side, then land one."],
            ["No beautiful lies. Use the real material.", "Every attempt shows its live preview, its real diff and its real check results."],
            ["A living spec.", "The intent is the source. Humans and corrections amend it. Every version is kept."],
            ["Both directions, no dead ends.", "Agents act through MCP and git. Humans act through the chart. Both see one state."],
            ["Infinite power needs a map.", "The chart shows every vessel, its course, its range to others and every correction."],
            ["Avoid the slot machine.", "There is no regenerate button. A re-derive needs a reason. Results arrive as a set."],
            ["Care over taste.", "Human words look different from agent words. Decisions carry a reason."],
          ].map(([p, m], i) => (
            <li key={p}>
              <span className="ds-pn voice-agent">P{i + 1}</span>
              <span className="ds-pp">{p}</span>
              <span className="ds-pm">{m}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        id="themes"
        title="Themes and color"
        lede="Day for bright light, Dusk for dim light, Night for the dark. Night is not an inverted Day: it keeps night vision. All values are OKLCH. The number on each swatch is its computed WCAG contrast: text tokens against the page, surfaces against primary text, vessel colors against water and land."
      >
        <div className="ds-themes">
          {THEMES.map((t) => (
            <ThemeColumn key={t.id} theme={t.id} />
          ))}
        </div>
        <ul className="ds-rules">
          <li>
            <Icon name="buoy" size={14} /> Magenta is reserved for corrections. It is an aid to navigation, not decoration.
          </li>
          <li>
            <Icon name="check" size={14} /> Color is never the only signal: every signal also has an icon and a text label.
          </li>
          <li>
            <Icon name="diff" size={14} /> Diffs use <span className="code-inline">--clear</span> and <span className="code-inline">--danger</span> at 14% with
            +/− gutters.
          </li>
          <li>
            <Icon name="range" size={14} /> Text on <span className="code-inline">--caution-fill</span> uses <span className="code-inline">--on-caution</span>{" "}
            (dark in every theme): light ink on that fill fails AA in Dusk and Night.
          </li>
        </ul>
      </Section>

      <Section id="voices" title="Three voices" lede="Who speaks decides the typeface. A reader always knows if a human, an agent or gitring wrote a line.">
        <div className="ds-voices">
          <div className="ds-voice">
            <p className="ds-voice__who">
              <Icon name="human" size={14} /> Human · {FONTS.human.family}, italic
            </p>
            <p className="voice-human ds-voice__big">Search books by title or author</p>
            <p className="voice-human ds-voice__small">“Smaller diff. The search form stays out of the header.”</p>
            <p className="ds-voice__use">Intents, goals, decisions, rationale, amendments. {FONTS.human.license}.</p>
          </div>
          <div className="ds-voice">
            <p className="ds-voice__who">
              <Icon name="compass" size={14} /> Agent · {FONTS.agent.family}
            </p>
            <p className="voice-agent ds-voice__big">formatPrice(cents, currency)</p>
            <p className="voice-agent ds-voice__small">14:02:33 KESTREL-7 Write src/products.js (+8 −3)</p>
            <p className="ds-voice__use">Code, diffs, logs, callsigns, SHAs, probabilities, soundings. {FONTS.agent.license}.</p>
          </div>
          <div className="ds-voice">
            <p className="ds-voice__who">
              <Icon name="grid" size={14} /> System · {FONTS.system.family}
            </p>
            <p className="voice-system ds-voice__big">Land attempt</p>
            <p className="voice-system ds-voice__small">Compare the attempts. Land one. The others stay as alternates.</p>
            <p className="ds-voice__use">All interface text: labels, buttons, help. Designed for low-vision readers. {FONTS.system.license}.</p>
          </div>
        </div>
      </Section>

      <Section id="type" title="Type scale" lede="Pixel sizes with fixed line heights. Weights 400 and 500; 600 for one heading per view at most. Use at most four sizes in one view.">
        <table className="ds-type">
          <tbody>
            {[
              ["--t-2xs", "10 / 12", "500 mono", "Chart soundings, axis ticks", "R2 · closing", "voice-agent"],
              ["--t-xs", "11 / 16", "400–500", "Metadata, callsign tags, badges", "Pick 1 of 2 ready attempts", ""],
              ["--t-sm", "13 / 20", "400", "Default UI text", "Land attempt", ""],
              ["--t-md", "15 / 24", "400", "Reading text, intent goals", "Add a dark color theme.", "voice-human"],
              ["--t-lg", "20 / 28", "500", "Section and view titles", "Living spec", ""],
              ["--t-xl", "28 / 34", "500", "Page titles, key numbers", "Search books by title", "voice-human"],
              ["--t-2xl", "44 / 48", "400", "Stats hero only", "4.9k", "voice-agent"],
            ].map(([tok, size, weight, use, sample, voice]) => (
              <tr key={tok}>
                <td className="voice-agent ds-type__tok">{tok}</td>
                <td className="voice-agent ink-3">{size}</td>
                <td className="ink-3">{weight}</td>
                <td className="ink-2">{use}</td>
                <td>
                  <span className={voice} style={{ fontSize: `var(${tok})`, lineHeight: `var(--lh-${tok.slice(4)})`, fontWeight: tok === "--t-2xs" || tok === "--t-lg" || tok === "--t-xl" ? 500 : 400 }}>
                    {sample}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="space" title="Space, shape, depth" lede="Pixel-literal spacing. Hairlines for structure. No card shadows on the page: only overlays cast a shadow.">
        <div className="ds-grid2">
          <Specimen title="Spacing" note="--s-0 … --s-11">
            <ul className="ds-space">
              {[2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64].map((px, i) => (
                <li key={px}>
                  <span className="voice-agent ds-space__tok">--s-{i}</span>
                  <span className="ds-space__bar" style={{ width: px }} />
                  <span className="voice-agent ink-3">{px}</span>
                </li>
              ))}
            </ul>
          </Specimen>
          <Specimen title="Radius" note="Charts are crisp: no pill shapes except the callsign pennant.">
            <div className="ds-radii">
              {[
                ["--r-1", 2, "chips"],
                ["--r-2", 4, "buttons, inputs"],
                ["--r-3", 6, "panels, menus"],
                ["--r-4", 10, "dialogs, previews"],
              ].map(([tok, px, use]) => (
                <div key={tok as string} className="ds-radius">
                  <span style={{ borderRadius: px as number }} />
                  <span className="voice-agent">{tok}</span>
                  <span className="ink-3">
                    {px}px · {use}
                  </span>
                </div>
              ))}
            </div>
          </Specimen>
          <Specimen title="Lines" note="Hairline 1px. The chart frame is a double rule: 1px, a 3px band of scale bars, 1px.">
            <div className="ds-lines">
              <div className="ds-line">
                <span className="ds-line__rule" /> <span className="ink-3">--line · section rule</span>
              </div>
              <div className="ds-line">
                <span className="ds-line__strong" /> <span className="ink-3">--line-strong · inputs, focusable edges</span>
              </div>
              <div className="ds-frame">
                <span className="ink-3">Chart frame</span>
              </div>
            </div>
          </Specimen>
          <Specimen title="Depth and layers" note="chart 0 · chart overlay 10 · rails 20 · popover 40 · toast 50 · dialog 60">
            <div className="ds-depth">
              <div className="ds-depth__page">Page: no shadow</div>
              <div className="ds-depth__overlay">Overlay: --shadow-overlay</div>
            </div>
          </Specimen>
        </div>
      </Section>

      <Section
        id="motion"
        title="Motion"
        lede="Motion explains a change of state; it never loops. A range ring pulses once when two vessels start to close. With reduced motion there is no movement, fades are 120 ms or less and there are no pulses."
      >
        <div className="ds-grid2">
          <Specimen title="Durations and easing">
            <table className="ds-tokens">
              <tbody>
                {[
                  ["--dur-1", "120ms", "hover, press"],
                  ["--dur-2", "200ms", "panels, toasts"],
                  ["--dur-3", "320ms", "layout"],
                  ["--dur-track", "800ms", "vessel moves"],
                  ["--ease-out", "cubic-bezier(.2,.7,.2,1)", "enter"],
                  ["--ease-in-out", "cubic-bezier(.6,0,.3,1)", "move"],
                ].map(([a, b, c]) => (
                  <tr key={a}>
                    <td className="voice-agent">{a}</td>
                    <td className="voice-agent ink-2">{b}</td>
                    <td className="ink-3">{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Specimen>
          <Specimen title="Try it">
            <MotionDemo />
          </Specimen>
        </div>
      </Section>

      <Section id="icons" title="Icons" lede="16px grid, 1.5px stroke, square caps, currentColor. Drawn for gitring.">
        <div className="ds-hulls">
          {HULL_NAMES.map((h, i) => (
            <div key={h} className="ds-hull">
              <Hull hull={h} size={28} color={`var(--v${i * 2})`} />
              <span className="voice-agent">{h}</span>
            </div>
          ))}
          <div className="ds-hull">
            <Mark size={28} />
            <span className="voice-agent">mark</span>
          </div>
        </div>
        <ul className="ds-icons">
          {iconNames.map((n) => (
            <li key={n}>
              <Icon name={n} />
              <span className="voice-agent">{n}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
