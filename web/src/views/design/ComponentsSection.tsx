/**
 * The components section of the style guide: every component of the design system in its states, live.
 * Some samples need state (the segment, the tab, the dialog), so the section reads it from the page.
 */
import {
  AttemptBadge,
  Badge,
  Button,
  Callsign,
  Checkbox,
  CodeBlock,
  CorrectionNotice,
  CourseCheckReadout,
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
} from "../../design/components";
import { Icon } from "../../design/icons";
import { Section, Specimen } from "./layout";
import { AGENT, AGENT2, CASES, CHECK, corr, DIFF, LOGS, names, run } from "./sample-data";
import type { DesignState } from "./useDesignState";

export function ComponentsSection({ m }: { m: DesignState }) {
  const { seg, setSeg, tab, setTab, setDialog } = m;
  return (
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
              <option value="glm-big">glm-5.3</option>
            </Select>
          </Field>
          <Field label="Why this attempt?" help="Human voice: serif italic.">
            <Textarea voice="human" rows={2} defaultValue="Smaller diff. The search form stays out of the header." />
          </Field>
          <div className="b-field">
            <span className="b-field__label">Models</span>
            <Checkbox label={<span className="voice-agent">glm-5.3-flash</span>} defaultChecked />
            <Checkbox label={<span className="voice-agent">glm-5.3</span>} />
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
  );
}
