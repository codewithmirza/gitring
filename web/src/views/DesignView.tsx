/**
 * /design — the living style guide. It renders the real tokens and components, so it
 * cannot drift from the product.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentInfo, CheckRun, Correction, CourseCheck, LogEntry } from "../../../src/core/types";
import {
  AttemptBadge,
  Badge,
  Button,
  Callsign,
  Checkbox,
  CodeBlock,
  CorrectionNotice,
  CourseCheckReadout,
  Dialog,
  DiffView,
  EmptyState,
  EvidenceBar,
  Field,
  IconButton,
  Input,
  IntentBadge,
  Kbd,
  LogLine,
  MethodBadge,
  Panel,
  ProgressRule,
  RangeIndicator,
  Segmented,
  Select,
  Stat,
  StatRow,
  TabPanel,
  Tabs,
  Textarea,
  Tooltip,
  toast,
} from "../design/components";
import { HULL_NAMES, HULL_PATHS, Hull, ICONS, Icon, Mark, type IconName } from "../design/icons";
import { THEMES, type Theme } from "../design/theme";
import { contrast, toHex, tokenRgb } from "../design/color";
import { FONTS } from "../design/fonts";
import { ChartLegend } from "../chart/ChartLegend";
import { Link } from "../app/router";
import "../chart/chart.css";
import "./design.css";

/* ───────────── sample data (static, so the guide works without a harbor) ───────────── */

const T0 = Date.now() - 4 * 60_000;

function run(names: string[], fail: string[] = [], scope: CheckRun["scope"] = "attempt"): CheckRun {
  const cases = names.map((name, i) => ({ file: "tests/search.test.js", name, ok: !fail.includes(name), error: fail.includes(name) ? "expected value to match /theme/" : undefined, ms: 3 + i }));
  const passed = cases.filter((c) => c.ok).length;
  return { id: "run", subject: "a1b2c3d", scope, ok: passed === cases.length, passed, failed: cases.length - passed, cases, ms: 212, at: T0 };
}
const CASES = ["matches a title", "matches an author", "ignores case", "returns no books for a nonsense query", "shows a message when nothing matches", "renders a search field with a label", "keeps the shelf at /"];

const CHECK: CourseCheck = {
  id: "ck-007",
  attemptId: "at-search-1",
  trigger: "declare",
  verdict: "correct",
  source: "clef-flash",
  confidence: 0.81,
  latencyMs: 44,
  at: T0,
  assessments: [{ otherAttemptId: "at-currency-1", collision: 0.58, interference: 3.1, duplicate: 0.03, giveWay: "incoming", giveWayConfidence: 0.88, rule: "R3-producer-stands-on" }],
  facts: [
    {
      otherAttemptId: "at-currency-1",
      otherAgentId: "ag-kestrel-7",
      otherIntentId: "in-currency",
      otherState: "active",
      sharedFiles: ["src/products.js", "src/render.js"],
      sharedSymbols: [],
      interfaceHits: [{ changedBy: "other", symbol: "src/products.js#formatPrice", usedAt: ["src/render.js#renderBookCard"] }],
      hunkOverlaps: [],
      range: 1,
      closing: false,
      intentSimilarity: 0.08,
    },
  ],
};

function corr(status: Correction["status"], kind: Correction["kind"] = "interface"): Correction {
  return {
    id: kind === "interface" ? "cr-01" : "cr-02",
    attemptId: "at-search-1",
    standOnAttemptId: kind === "interface" ? "at-currency-1" : "at-dark-1",
    kind,
    rule: kind === "interface" ? "R3-producer-stands-on" : "R4-first-declared-stands-on",
    message:
      kind === "interface"
        ? "Agent KESTREL-7 changes `formatPrice(cents)` to `formatPrice(cents, currency)` in `src/products.js`. Pass the currency when you render prices. Continue your work."
        : "Agent HERON-3 changes the header in `src/render.js`, lines 27–37. Do not edit these lines. Put the search form below the header. Continue your work.",
    constraints:
      kind === "interface"
        ? { useSignatures: [{ symbol: "src/products.js#formatPrice", signature: 'formatPrice(cents, currency = "GBP")' }] }
        : { avoidRegions: [{ path: "src/render.js", lines: [27, 37] }] },
    checkId: "ck-007",
    status,
    createdAt: T0,
    ackNote: status === "acknowledged" ? "Use formatPrice(p.cents, currency)." : undefined,
  };
}

const AGENT: AgentInfo = { id: "ag-kestrel-7", callsign: "KESTREL-7", kind: "builtin", model: "@cf/zai-org/glm-5.3-flash", color: 0, status: "underway", lastSeen: T0 };
const AGENT2: AgentInfo = { id: "ag-petrel-2", callsign: "PETREL-2", kind: "builtin", model: "@cf/openai/gpt-oss-120b", color: 2, status: "underway", lastSeen: T0 };
const LOGS: [LogEntry, AgentInfo | undefined][] = [
  [{ id: "l1", at: T0, kind: "declare", message: "Declare course: A search form in the header. Results use the normal shelf." }, AGENT2],
  [{ id: "l2", at: T0 + 1000, kind: "check", message: "Course check: correction · clef-flash 44 ms" }, AGENT2],
  [{ id: "l3", at: T0 + 1200, kind: "correction", message: "Correction for PETREL-2 · interface · R3 · KESTREL-7 stands on" }, AGENT2],
  [{ id: "l4", at: T0 + 9000, kind: "write", message: "Pass the currency from renderPage to renderBookCard. Update 2 call sites." }, AGENT],
  [{ id: "l5", at: T0 + 20000, kind: "land", message: "Landed on main d20153b · 3-way merge · “Show prices in the reader's currency” · 17/17 checks" }, AGENT],
  [{ id: "l6", at: T0 + 21000, kind: "decision", message: "“Search books by title or author” has 2 ready attempts. A human pick is necessary." }, undefined],
];

const DIFF = `diff --git a/src/products.js b/src/products.js
--- a/src/products.js
+++ b/src/products.js
@@ -38,6 +38,13 @@ export const books = [
   },
 ];

-export function formatPrice(cents) {
-  return "£" + (cents / 100).toFixed(2);
+// Fixed rates against GBP. Prices stay in integer pence in \`books\`.
+export const RATES = { GBP: 1, EUR: 1.17, USD: 1.27 };
+
+export function formatPrice(cents, currency = "GBP") {
+  const code = RATES[currency] ? currency : "GBP";
+  const amount = Math.round(cents * RATES[code]) / 100;
+  return new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).format(amount);
 }
`;

const names = (id: string) => ({ "at-currency-1": "KESTREL-7", "at-search-1": "PETREL-2", "at-dark-1": "HERON-3" })[id] ?? id;

/* ───────────── layout helpers ───────────── */

const TOC: [string, string][] = [
  ["principles", "Principles"],
  ["themes", "Themes and color"],
  ["voices", "Three voices"],
  ["type", "Type scale"],
  ["space", "Space, shape, depth"],
  ["motion", "Motion"],
  ["icons", "Icons"],
  ["components", "Components"],
  ["chart", "Chart primitives"],
  ["patterns", "Patterns"],
  ["a11y", "Accessibility"],
  ["copy", "Copy rules"],
];

function Section({ id, title, lede, children }: { id: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section className="ds-section" id={id} aria-labelledby={`${id}-h`}>
      <h2 className="ds-h2" id={`${id}-h`}>
        <a href={`#${id}`} className="ds-anchor" aria-hidden="true" tabIndex={-1}>
          #
        </a>
        {title}
      </h2>
      {lede && <p className="ds-lede">{lede}</p>}
      {children}
    </section>
  );
}

function Specimen({ title, note, children, wide }: { title: string; note?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={["ds-spec", wide && "ds-spec--wide"].filter(Boolean).join(" ")}>
      <div className="ds-spec__head">
        <h3 className="ds-h3">{title}</h3>
        {note && <p className="ds-spec__note">{note}</p>}
      </div>
      <div className="ds-spec__body">{children}</div>
    </div>
  );
}

/* ───────────── themes ───────────── */

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

function ThemeColumn({ theme }: { theme: Theme }) {
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

function MiniChart() {
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

function MotionDemo() {
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

/* ───────────── page ───────────── */

export function DesignView() {
  const [seg, setSeg] = useState<"chart" | "intents" | "logbook">("chart");
  const [tab, setTab] = useState<"a" | "b" | "c">("a");
  const [dialog, setDialog] = useState(false);
  const iconNames = Object.keys(ICONS) as IconName[];

  return (
    <div className="ds">
      <nav className="ds-toc" aria-label="Style guide sections">
        <p className="ds-toc__title">
          <Mark size={18} /> Chart room
        </p>
        <ol>
          {TOC.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="ds-main">
        <header className="ds-hero">
          <p className="page__eyebrow">
            <Icon name="grid" size={14} /> Gitring design system · v0.1
          </p>
          <h1 className="ds-title" tabIndex={-1}>
            Chart room
          </h1>
          <p className="ds-hero__lede">
            Gitring is a chart room for coding agents. Many agents move through one codebase at the same time. A human reads the chart, makes decisions and
            keeps the fleet clear of collisions. This page renders the real tokens and components.
          </p>
          <div className="ds-hero__voices">
            <p className="voice-human">“Add a dark mode. Keep text contrast at 4.5:1 or more.”</p>
            <p className="voice-agent">KESTREL-7 · formatPrice(cents, currency) · 0.58</p>
            <p className="voice-system">Land attempt · Declare course · Amend intent</p>
          </div>
        </header>

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

        <Section id="voices" title="Three voices" lede="Who speaks decides the typeface. A reader always knows if a human, an agent or Gitring wrote a line.">
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

        <Section id="icons" title="Icons" lede="16px grid, 1.5px stroke, square caps, currentColor. Drawn for Gitring.">
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

        <Section id="components" title="Components" lede="Each component has default, hover, focus-visible, active and disabled states. Loading uses a hairline progress rule, not a spinner.">
          <Specimen title="Button" note="32px (md) and 24px (sm). Verb + noun labels. Disabled buttons stay focusable (aria-disabled)." wide>
            <table className="ds-states">
              <thead>
                <tr>
                  <th />
                  {["Default", "Hover", "Focus", "Active", "Disabled", "Busy"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(["primary", "secondary", "ghost", "danger"] as const).map((v) => (
                  <tr key={v}>
                    <th className="voice-agent">{v}</th>
                    <td>
                      <Button variant={v} icon={v === "danger" ? "park" : "anchor"}>
                        {v === "danger" ? "Park intent" : "Land attempt"}
                      </Button>
                    </td>
                    <td>
                      <Button variant={v} state="hover">
                        Land attempt
                      </Button>
                    </td>
                    <td>
                      <Button variant={v} state="focus">
                        Land attempt
                      </Button>
                    </td>
                    <td>
                      <Button variant={v} state="active">
                        Land attempt
                      </Button>
                    </td>
                    <td>
                      <Button variant={v} disabled>
                        Land attempt
                      </Button>
                    </td>
                    <td>
                      <Button variant={v} busy>
                        Land attempt
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ds-row">
              <Button size="sm" icon="diff">
                Open diff
              </Button>
              <Button size="sm" variant="ghost" icon="plus">
                New intent
              </Button>
              <IconButton icon="reload" label="Reload preview" />
              <IconButton icon="plus" label="Zoom in" shortcut="+" variant="secondary" />
              <IconButton icon="close" label="Close" size="sm" />
            </div>
          </Specimen>

          <div className="ds-grid2">
            <Specimen title="Segmented" note='role="radiogroup"; arrow keys move.'>
              <Segmented
                label="Sample view switch"
                value={seg}
                onChange={setSeg}
                options={[
                  { value: "chart", label: "Chart", icon: "compass" },
                  { value: "intents", label: "Intents", icon: "amend" },
                  { value: "logbook", label: "Logbook", icon: "logbook" },
                ]}
              />
            </Specimen>
            <Specimen title="Tabs" note='role="tablist"; arrow keys move.'>
              <Tabs
                label="Sample tabs"
                idPrefix="ds"
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: "a", label: "Claude Code" },
                  { id: "b", label: "Codex" },
                  { id: "c", label: "Cursor", count: 3 },
                ]}
              />
              {(["a", "b", "c"] as const).map((id) => (
                <TabPanel key={id} idPrefix="ds" id={id} active={tab === id} className="t-xs ink-2">
                  {id === "a" ? "claude mcp add --transport http gitring <url>" : id === "b" ? "codex mcp add gitring --url <url>" : "Add the server to .cursor/mcp.json"}
                </TabPanel>
              ))}
            </Specimen>
          </div>

          <Specimen title="Input, Textarea, Select" note="--surface-2 fill, --line-strong border. Label above, help below, error in --danger with an icon." wide>
            <div className="ds-grid3">
              <Field label="Title" help="A short verb phrase.">
                <Input className="voice-human" defaultValue="Add a dark mode" />
              </Field>
              <Field label="Check file" help="Hover state.">
                <Input className="voice-agent" defaultValue="tests/dark-mode.test.js" state="hover" />
              </Field>
              <Field label="Reason" help="Focus state.">
                <Input defaultValue="Smaller diff." state="focus" />
              </Field>
              <Field label="Goal" error="Write the goal in one or two sentences.">
                <Input defaultValue="" placeholder="Show “In stock” under each price." />
              </Field>
              <Field label="Disabled">
                <Input disabled defaultValue="main 9c4d7e0" />
              </Field>
              <Field label="Model">
                <Select defaultValue="glm">
                  <option value="glm">glm-5.3-flash</option>
                  <option value="kimi">kimi-k2.7-code</option>
                </Select>
              </Field>
              <Field label="Why this attempt?" help="Human voice: serif italic.">
                <Textarea voice="human" rows={2} defaultValue="Smaller diff. The search form stays out of the header." />
              </Field>
              <div className="b-field">
                <span className="b-field__label">Models</span>
                <Checkbox label={<span className="voice-agent">glm-5.3-flash</span>} defaultChecked />
                <Checkbox label={<span className="voice-agent">gpt-oss-120b</span>} />
              </div>
            </div>
          </Specimen>

          <div className="ds-grid2">
            <Specimen title="Badge" note="Icon + text. Never color alone.">
              <div className="ds-row">
                <Badge tone="clear" icon="check">
                  Clear
                </Badge>
                <Badge tone="correction" icon="buoy">
                  Correction
                </Badge>
                <Badge tone="danger" icon="cross">
                  Checks fail
                </Badge>
                <Badge tone="caution" icon="range">
                  Closing
                </Badge>
                <Badge tone="neutral" icon="dot">
                  Underway
                </Badge>
              </div>
              <div className="ds-row">
                <MethodBadge method="fast-forward" />
                <MethodBadge method="merge" />
                <MethodBadge method="rederive" />
              </div>
              <div className="ds-row">
                <IntentBadge status="judging" />
                <IntentBadge status="landed" />
                <AttemptBadge status="ready" />
                <AttemptBadge status="stale" />
                <AttemptBadge status="alternate" />
              </div>
            </Specimen>
            <Specimen title="Callsign" note="Pennant (color) + hull (shape) + mono callsign (text). Screen readers hear “KESTREL-7, glm-5.3-flash”.">
              <div className="ds-row">
                <Callsign callsign="KESTREL-7" color={0} model={AGENT.model} />
                <Callsign callsign="PETREL-2" color={2} model={AGENT2.model} size="md" />
                <Callsign callsign="TERN-5" color={9} model="claude-code" showModel />
                <Callsign callsign="SKUA-1" color={7} dim />
              </div>
              <div className="ds-row ds-callsigns">
                {["KESTREL", "ALBATROSS", "PETREL", "TERN", "GANNET", "HERON", "SKUA", "CORMORANT", "FULMAR", "PUFFIN", "OSPREY", "CURLEW"].map((n, i) => (
                  <Callsign key={n} callsign={`${n}-${i + 1}`} color={i} />
                ))}
              </div>
            </Specimen>
          </div>

          <div className="ds-grid2">
            <Specimen title="EvidenceBar" note='One segment per check case. role="img" with a text alternative.'>
              <div className="ds-stack">
                <EvidenceBar run={run(CASES)} label="Alone" />
                <EvidenceBar run={run(CASES, ["renders a search field with a label"])} label="Alone" />
                <EvidenceBar run={null} checking pending={7} label="Alone" />
              </div>
            </Specimen>
            <Specimen title="RangeIndicator" note="R0–R1 danger, R2–R3 caution, R4–R5 neutral; magenta after a correction.">
              <div className="ds-row">
                {([0, 1, 2, 3, 4, 5] as const).map((r) => (
                  <RangeIndicator key={r} range={r} />
                ))}
              </div>
              <div className="ds-row">
                <RangeIndicator range={2} closing />
                <RangeIndicator range={1} corrected />
              </div>
            </Specimen>
          </div>

          <Specimen title="CorrectionNotice" note="Magenta 2px rule, buoy icon, kind, STE message, constraints, status. No shadow; a 6% magenta tint only." wide>
            <div className="ds-grid2 ds-grid2--tight">
              <CorrectionNotice correction={corr("pending")} from="KESTREL-7" to="PETREL-2" check={CHECK} nameOf={names} expanded />
              <div className="ds-stack">
                <CorrectionNotice correction={corr("delivered", "region")} from="HERON-3" to="PETREL-2" />
                <CorrectionNotice correction={corr("acknowledged")} from="KESTREL-7" to="PETREL-2" />
                <CorrectionNotice correction={{ ...corr("superseded", "region"), id: "cr-06" }} from="HERON-3" to="TERN-5" />
              </div>
            </div>
          </Specimen>

          <div className="ds-grid2">
            <Specimen title="CourseCheckReadout" note="Clef probabilities with the policy threshold as a tick. Source tag: clef, clef-flash or rules.">
              <CourseCheckReadout check={CHECK} nameOf={names} incoming="PETREL-2" />
            </Specimen>
            <Specimen title="Stat" note="Mono number + label, in a row with hairline dividers. Not cards.">
              <StatRow>
                <Stat value="47" label="course checks" />
                <Stat value="9" label="corrections" />
                <Stat value="0" label="human merge fixes" good />
              </StatRow>
              <StatRow>
                <Stat variant="inline" value="38" label="clear" />
                <Stat variant="inline" value="3" label="landings" />
              </StatRow>
            </Specimen>
          </div>

          <Specimen title="LogLine" note="Radio log row: time, callsign, kind icon, message. The container is a polite live region." wide>
            <div className="ds-log" role="list">
              {LOGS.map(([l, a]) => (
                <LogLine key={l.id} log={l} agent={a} />
              ))}
            </div>
          </Specimen>

          <Specimen title="DiffView" note="Unified, mono, line numbers, +/− gutters, hunk headers, collapsed unchanged regions." wide>
            <DiffView files={[{ path: "src/products.js", status: "M", additions: 7, deletions: 2, diff: DIFF }]} />
          </Specimen>

          <div className="ds-grid2">
            <Specimen title="Panel and rows" note="Header row (title + count + action), hairline under it. Selected row: --surface-2 and a 2px accent bar.">
              <div className="ds-panel">
                <Panel
                  title="Traffic"
                  count={3}
                  action={
                    <Badge tone="caution" icon="closing">
                      1 pair closing
                    </Badge>
                  }
                >
                  <button type="button" className="b-row is-selected ds-rowdemo">
                    <Callsign callsign="PETREL-2" color={2} />
                    <span className="voice-human">Search books by title or author</span>
                  </button>
                  <button type="button" className="b-row ds-rowdemo">
                    <Callsign callsign="HERON-3" color={5} />
                    <span className="voice-human">Add a dark mode</span>
                  </button>
                  <button type="button" className="b-row is-hover ds-rowdemo">
                    <Callsign callsign="TERN-5" color={9} />
                    <span className="voice-human">Mark staff picks</span>
                  </button>
                </Panel>
              </div>
            </Specimen>
            <Specimen title="Toast, Dialog, Tooltip, Kbd" note="Toasts dismiss in 6 s and pause on hover. Dialogs trap focus and return it.">
              <div className="ds-row">
                <Button size="sm" onClick={() => toast({ tone: "clear", title: "Landed on main d20153b", text: "Human merge fixes: 0." })}>
                  Show clear toast
                </Button>
                <Button size="sm" onClick={() => toast({ tone: "correction", title: "Correction for PETREL-2", text: "Interface · R3 producer stands on." })}>
                  Show correction toast
                </Button>
                <Button size="sm" onClick={() => toast({ tone: "danger", title: "The fork is not ready", text: "Try again in 5 seconds." })}>
                  Show danger toast
                </Button>
                <Button size="sm" variant="primary" onClick={() => setDialog(true)}>
                  Open dialog
                </Button>
              </div>
              <div className="ds-row">
                <Tooltip label="Tooltips repeat a label or add a hint. They never hold the only copy.">
                  <Button size="sm" variant="ghost" icon="info">
                    Hover or focus me
                  </Button>
                </Tooltip>
                <span className="ink-2">
                  <Kbd>g</Kbd> <Kbd>c</Kbd> opens the chart · <Kbd>?</Kbd> lists shortcuts
                </span>
              </div>
              <div className="ds-toasts">
                {(["info", "clear", "correction", "danger"] as const).map((t) => (
                  <div key={t} className={`b-toast b-toast--${t}`} style={{ animation: "none" }}>
                    <span className="b-toast__icon">
                      <Icon name={({ info: "info", clear: "check", correction: "buoy", danger: "cross" } as const)[t]} />
                    </span>
                    <div className="b-toast__body">
                      <div className="b-toast__title">{{ info: "Intent open", clear: "Landed on main", correction: "Correction sent", danger: "The launch failed" }[t]}</div>
                      <div className="b-toast__text">{{ info: "Launch attempts when you are ready.", clear: "Human merge fixes: 0.", correction: "PETREL-2 gives way (R3).", danger: "Try again in 5 seconds." }[t]}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Specimen>
          </div>

          <div className="ds-grid2">
            <Specimen title="CodeBlock" note='Mono block with a "Copy command" button.'>
              <CodeBlock shell label="Terminal" code="claude mcp add --transport http gitring https://gitring.example/mcp" />
            </Specimen>
            <Specimen title="EmptyState and ProgressRule" note="A small chart-frame drawing, one STE sentence, one action.">
              <EmptyState text="No vessels at sea. Launch an intent to start." action={<Button size="sm" variant="primary" icon="launch">Launch attempts</Button>} />
              <ProgressRule label="Sample progress" />
            </Specimen>
          </div>
        </Section>

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
              ["Judgment queue", "The top bar shows only the decisions that need a human. Everything else lands by itself.", "/", "See the queue"],
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
      </div>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Land PETREL-2"
        description="Gitring composes the attempt with main, runs every landed check, then lands it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="anchor" onClick={() => setDialog(false)}>
              Land attempt
            </Button>
          </>
        }
      >
        <Field label="Why this attempt?" help="Your reason goes into the logbook.">
          <Textarea voice="human" rows={3} defaultValue="Smaller diff. The search form stays out of the header." />
        </Field>
      </Dialog>
    </div>
  );
}
