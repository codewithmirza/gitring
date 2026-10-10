/**
 * "/connect": add gitring to an agent as an MCP connector (OAuth: no key to copy), or use an API key,
 * then git mode, the Claude Code hook, inputs from other apps and events out.
 *
 * Requests: the connect info once per project; the OAuth apps every 5 s only while this tab is visible
 * and no app is connected yet (agents that work on the project arrive over the live socket).
 */
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button, CodeBlock, Field, Input, Tabs, TabPanel } from "../design/components";
import type { AgentInfo } from "../../../src/core/types";
import type { OAuthGrantInfo } from "../../../src/core/accounts";
import { createKey, useMe } from "../state/account";
import { isAbort, listGrants, RequestError } from "../state/github";
import { openSignIn } from "../app/ui";
import { Link } from "../app/router";
import { useNow } from "../app/useNow";
import { Icon, Mark, type IconName } from "../design/icons";
import { harborOrNull, onHarbor, defaultConnectInfo, type ConnectInfo } from "../state/api";
import { ago } from "../state/format";
import { useStore } from "../state/store";
import "./connect.css";
import "./projects.css";

/* ───────────── flow diagram ───────────── */

interface FlowNode {
  label: string;
  via: string;
  icon: IconName;
  group: "agent" | "git" | "app";
}

interface Stage {
  label: string;
  icon: IconName;
  note: string;
}

/** Only real parts: the inputs this deployment has, the outputs this project uses. */
function flowParts(info: ConnectInfo, githubOn: boolean) {
  const inputs: FlowNode[] = [
    { label: "Claude", via: "MCP connector", icon: "compass", group: "agent" },
    { label: "Claude Code", via: "MCP", icon: "compass", group: "agent" },
    { label: "Codex", via: "MCP", icon: "compass", group: "agent" },
    { label: "Cursor", via: "MCP", icon: "compass", group: "agent" },
    { label: "Any git client", via: "git push into a work copy", icon: "fork", group: "git" },
    { label: "Any app", via: "HTTP + API key", icon: "plug", group: "app" },
    ...(info.inputs.githubIssues ? [{ label: "GitHub issues", via: "label gitring", icon: "plug", group: "app" } satisfies FlowNode] : []),
    ...(info.inputs.slack ? [{ label: "Slack", via: "the /gitring command", icon: "plug", group: "app" } satisfies FlowNode] : []),
  ];
  const stages: Stage[] = [
    { label: "Conflict check", icon: "range", note: "each plan and each change" },
    { label: "Change requests", icon: "buoy", note: "back to the agents" },
    { label: "Rebase", icon: "compass", note: "onto each new main" },
    { label: "Merge", icon: "anchor", note: "fast-forward · 3-way merge · redo" },
    { label: "History", icon: "logbook", note: "a git note on each merge commit" },
  ];
  const outputs: { label: string; via: string; icon: IconName }[] = [
    { label: "main in Cloudflare Artifacts", via: "only gitring writes main", icon: "anchor" },
    ...(githubOn ? [{ label: "GitHub", via: "pull request or main", icon: "fork" as IconName }] : []),
    { label: "Webhooks", via: "JSON or Slack message", icon: "send" },
    { label: "Live web pages", via: "updates over a WebSocket", icon: "compass" },
  ];
  return { inputs, stages, outputs };
}

function NodeBox({ x, y, w, h, label, via, icon, side }: { x: number; y: number; w: number; h: number; label: string; via: string; icon: IconName; side: "in" | "out" }) {
  return (
    <g className={`flow__node flow__node--${side}`} transform={`translate(${x} ${y})`}>
      <rect width={w} height={h} rx={4} />
      <g transform="translate(12 15)" className="flow__icon">
        <Icon name={icon} />
      </g>
      <text x={36} y={20} className="flow__label">
        {label}
      </text>
      <text x={36} y={36} className="flow__via">
        {via}
      </text>
    </g>
  );
}

function FlowDiagram({ vertical, info, githubOn }: { vertical: boolean; info: ConnectInfo; githubOn: boolean }) {
  const { inputs, stages, outputs } = flowParts(info, githubOn);
  if (vertical) {
    const W = 360;
    const nodeH = 46;
    const inY = (i: number) => 40 + i * (nodeH + 8);
    const midTop = inY(inputs.length) + 34;
    const midH = 76 + stages.length * 46;
    const outY = (i: number) => midTop + midH + 50 + i * (nodeH + 8);
    const H = outY(outputs.length) + 10;
    return (
      <svg className="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="flow-title flow-desc">
        <text x={0} y={16} className="flow__col">
          In
        </text>
        {inputs.map((n, i) => (
          <NodeBox key={n.label} x={0} y={inY(i)} w={W} h={nodeH} label={n.label} via={n.via} icon={n.icon} side="in" />
        ))}
        <path className="flow__wire" d={`M${W / 2} ${inY(inputs.length) - 4} V${midTop}`} markerEnd="url(#flow-arrow)" />
        <GitringBox x={0} y={midTop} w={W} h={midH} stages={stages} />
        <path className="flow__wire" d={`M${W / 2} ${midTop + midH} V${midTop + midH + 40}`} markerEnd="url(#flow-arrow)" />
        <text x={0} y={midTop + midH + 32} className="flow__col">
          Out
        </text>
        {outputs.map((n, i) => (
          <NodeBox key={n.label} x={0} y={outY(i)} w={W} h={nodeH} label={n.label} via={n.via} icon={n.icon} side="out" />
        ))}
        <Defs />
      </svg>
    );
  }
  const W = 1120;
  const nodeW = 240;
  const outW = 262;
  const nodeH = 46;
  const inY = (i: number) => 36 + i * (nodeH + 10);
  const outY = (i: number) => 36 + 56 + i * (nodeH + 14);
  // Room for the stages, also when the deployment has few inputs.
  const H = Math.max(inY(inputs.length) + 10, outY(outputs.length) + 40, 400);
  const bx = 392;
  const bw = 356;
  const by = 50;
  const bh = H - 84;
  const outX = W - outW;
  // The change-request stage (index 1) sends the magenta wire back to the agents.
  const stageStep = (bh - 76) / stages.length;
  const corrY = by + 60 + stageStep + (stageStep - 10) / 2;
  return (
    <svg className="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="flow-title flow-desc">
      <text x={0} y={18} className="flow__col">
        In: agents and apps send work
      </text>
      <text x={outX} y={18} className="flow__col">
        Out: gitring sends results
      </text>
      {inputs.map((n, i) => {
        const y = inY(i) + nodeH / 2;
        const ty = by + 48 + i * ((bh - 96) / Math.max(1, inputs.length - 1));
        return (
          <path
            key={`w${n.label}`}
            className={`flow__wire flow__wire--${n.group}`}
            d={`M${nodeW} ${y} C${nodeW + 70} ${y}, ${bx - 70} ${ty}, ${bx - 2} ${ty}`}
            markerEnd="url(#flow-arrow)"
          />
        );
      })}
      {/* change requests return to the agents: the only magenta in the diagram */}
      <path
        className="flow__return"
        d={`M${bx + 2} ${corrY} C${bx - 70} ${corrY}, ${nodeW + 80} ${inY(3) + nodeH - 4}, ${nodeW + 4} ${inY(3) + nodeH - 8}`}
        markerEnd="url(#flow-arrow-magenta)"
      />
      <text x={(nodeW + bx) / 2} y={inY(4) + 6} className="flow__returnlabel" textAnchor="middle">
        <tspan x={(nodeW + bx) / 2}>change requests</tspan>
        <tspan x={(nodeW + bx) / 2} dy="14">
          back to agents
        </tspan>
      </text>
      {inputs.map((n, i) => (
        <NodeBox key={n.label} x={0} y={inY(i)} w={nodeW} h={nodeH} label={n.label} via={n.via} icon={n.icon} side="in" />
      ))}
      <GitringBox x={bx} y={by} w={bw} h={bh} stages={stages} />
      {outputs.map((n, i) => {
        const y = outY(i) + nodeH / 2;
        const sy = by + 60 + i * ((bh - 120) / Math.max(1, outputs.length - 1));
        return <path key={`o${n.label}`} className="flow__wire" d={`M${bx + bw + 2} ${sy} C${bx + bw + 70} ${sy}, ${outX - 70} ${y}, ${outX - 2} ${y}`} markerEnd="url(#flow-arrow)" />;
      })}
      {outputs.map((n, i) => (
        <NodeBox key={n.label} x={outX} y={outY(i)} w={outW} h={nodeH} label={n.label} via={n.via} icon={n.icon} side="out" />
      ))}
      <Defs />
    </svg>
  );
}

function Defs() {
  return (
    <defs>
      <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0 0 L8 4 L0 8 Z" className="flow__arrowhead" />
      </marker>
      <marker id="flow-arrow-magenta" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0 0 L8 4 L0 8 Z" className="flow__arrowhead--magenta" />
      </marker>
    </defs>
  );
}

function GitringBox({ x, y, w, h, stages }: { x: number; y: number; w: number; h: number; stages: Stage[] }) {
  const step = (h - 76) / stages.length;
  return (
    <g className="flow__gitring" transform={`translate(${x} ${y})`}>
      <rect className="flow__frame" width={w} height={h} />
      <rect className="flow__frame" x={4} y={4} width={w - 8} height={h - 8} />
      <g transform="translate(16 16)">
        <Mark size={24} title="gitring" />
      </g>
      <text x={48} y={34} className="flow__title">
        gitring
      </text>
      <text x={w - 16} y={34} className="flow__via" textAnchor="end">
        one coordinator per project
      </text>
      {stages.map((s, i) => {
        const sy = 60 + i * step;
        return (
          <g key={s.label} transform={`translate(16 ${sy})`} className="flow__stage">
            <rect width={w - 32} height={step - 10} rx={3} />
            <g transform={`translate(10 ${(step - 10) / 2 - 8})`} className="flow__icon">
              <Icon name={s.icon} />
            </g>
            <text x={36} y={(step - 10) / 2 + 4} className="flow__label">
              {s.label}
            </text>
            <text x={w - 44} y={(step - 10) / 2 + 4} className="flow__via" textAnchor="end">
              {s.note}
            </text>
            {i < stages.length - 1 && <path className="flow__wire" d={`M${(w - 32) / 2} ${step - 10} V${step}`} />}
          </g>
        );
      })}
    </g>
  );
}

function flowText(info: ConnectInfo, githubOn: boolean): string {
  const apps = ["any app sends HTTP requests with an API key", info.inputs.githubIssues && "GitHub issues with the label gitring open tasks", info.inputs.slack && "the Slack command /gitring opens tasks"]
    .filter(Boolean)
    .join("; ");
  return (
    `In: Claude connects as a connector, and Claude Code, Codex and Cursor connect through MCP; any git client pushes into a work copy; ${apps}. ` +
    "gitring runs a conflict check on each plan and each change, sends change requests back to the agents, rebases active work onto each new main, " +
    "merges the work (fast-forward, 3-way merge or redo) and writes the history as a git note on each merge commit. " +
    `Out: main in Cloudflare Artifacts${githubOn ? ", GitHub (a pull request or main)" : ""}, webhooks (JSON or Slack messages) and live updates for the web pages.`
  );
}

function useNarrow(q = "(max-width: 760px)") {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

/** A choice that this browser remembers (the agent client, the key tab). */
function useRemembered<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      return s && allowed.includes(s) ? s : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (n: T) => {
    setV(n);
    try {
      localStorage.setItem(key, n);
    } catch {
      /* storage off: the choice holds for this visit */
    }
  };
  return [v, set];
}

/* ───────────── page parts ───────────── */

function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside: ReactNode }) {
  return (
    <section className="cx" aria-labelledby={id}>
      <div className="cx__text">
        <h2 className="page__h2" id={id}>
          {title}
        </h2>
        {aside}
      </div>
      <div className="cx__code">{children}</div>
    </section>
  );
}

/** One line to copy: a read-only field (focus selects it) and a button. */
function CopyField({ value, label, button = "Copy URL" }: { value: string; label: string; button?: string }) {
  const id = useId();
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied("idle"), 1800);
  };
  return (
    <div className="cx-url">
      <label className="vh" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="cx-url__input voice-agent" readOnly value={value} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
      <Button variant="primary" icon={copied === "ok" ? "check" : "copy"} onClick={() => void copy()}>
        {copied === "ok" ? "Copied" : button}
      </Button>
      <span className="vh" aria-live="polite">
        {copied === "ok" ? "Copied." : copied === "fail" ? "The browser did not copy. Select the text and copy it." : ""}
      </span>
    </div>
  );
}

type Client = "claude" | "claude-code" | "cursor" | "codex" | "other";
const CLIENTS: { id: Client; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "other", label: "Other" },
];
const CLIENT_IDS = CLIENTS.map((c) => c.id);

const CLIENT_NAMES: Record<string, string> = {
  claude: "Claude",
  "claude-ai": "Claude",
  "claude.ai": "Claude",
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

function clientName(a: AgentInfo): string {
  const c = (a.client ?? "").toLowerCase();
  return CLIENT_NAMES[c] ?? a.client ?? a.callsign;
}

function cursorLink(url: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=gitring&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`;
}

const NO_AGENTS: AgentInfo[] = [];

/** "Waiting for an agent" until an app signs in through OAuth; then the apps and the agents that work here. */
function LiveStatus({ client }: { client: Client }) {
  const me = useMe();
  const signedIn = Boolean(me?.user);
  const agents = useStore((s) => s.state?.agents ?? NO_AGENTS);
  const outside = useMemo(() => agents.filter((a) => a.kind === "mcp").sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 3), [agents]);
  const [grants, setGrants] = useState<OAuthGrantInfo[] | null>(null);
  const [missing, setMissing] = useState(false);
  const now = useNow(15_000);

  useEffect(() => {
    if (!signedIn) return;
    const ctl = new AbortController();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const list = await listGrants(ctl.signal);
        setGrants(list);
        setMissing(false);
        if (list.length) return; // connected: no more polling (a visit back to the tab looks once more)
      } catch (e) {
        if (isAbort(e)) return;
        // No such endpoint, or no session: stop asking.
        if (e instanceof RequestError && (e.status === 404 || e.status === 401 || e.status === 403)) {
          setMissing(true);
          return;
        }
      }
      if (Date.now() - started < 10 * 60_000) timer = setTimeout(() => void tick(), 5000);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctl.abort();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [signedIn]);

  const want = CLIENTS.find((c) => c.id === client)?.label ?? "your agent";
  const connected = (grants ?? []).slice().sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));

  if (!signedIn) {
    return (
      <div className="cx-live" role="status">
        <Icon name="human" size={14} className="cx-live__icon" />
        <span className="cx-live__text">Sign in first. Your agent then signs in as you.</span>
        <Button size="sm" variant="primary" onClick={openSignIn}>
          Sign in
        </Button>
      </div>
    );
  }
  return (
    <div className="cx-live" role="status" aria-live="polite">
      {connected.length > 0 ? (
        <>
          <Icon name="check" size={14} className="cx-live__icon cx-live__icon--ok" />
          <div className="cx-live__text">
            <ul className="cx-live__list">
              {connected.slice(0, 4).map((g) => (
                <li key={g.id}>
                  <strong>{g.clientName}</strong> is connected{g.lastUsedAt ? ` · used ${ago(g.lastUsedAt, now)}` : ` · allowed ${ago(g.createdAt, now)}`}
                </li>
              ))}
              {outside.map((a) => (
                <li key={a.id}>
                  <strong>{clientName(a)}</strong> worked on this project {ago(a.lastSeen, now)}
                </li>
              ))}
            </ul>
            <Link to="/account" className="cx-live__more">
              See or revoke connected apps
            </Link>
          </div>
        </>
      ) : outside.length > 0 ? (
        <>
          <Icon name="check" size={14} className="cx-live__icon cx-live__icon--ok" />
          <ul className="cx-live__list cx-live__text">
            {outside.map((a) => (
              <li key={a.id}>
                <strong>{clientName(a)}</strong> worked on this project {ago(a.lastSeen, now)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <span className="cx-live__wait" aria-hidden="true" />
          <span className="cx-live__text">
            {grants === null && !missing ? "gitring looks for connected agents…" : `Waiting for ${want}. This line changes when your agent signs in.`}
          </span>
        </>
      )}
    </div>
  );
}

function Step({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

function ConnectorSection({ mcpUrl }: { mcpUrl: string }) {
  const [client, setClient] = useRemembered<Client>("gitring.connect.client", "claude", CLIENT_IDS);
  const cursorJson = JSON.stringify({ mcpServers: { gitring: { url: mcpUrl } } }, null, 2);
  return (
    <section className="cx-hero" aria-labelledby="cx-connector">
      <div className="cx-hero__text">
        <h2 className="page__h2" id="cx-connector">
          Add gitring as a connector
        </h2>
        <p>One URL for every agent. Your agent signs in with your gitring account (OAuth), so you do not copy a key.</p>
      </div>
      <CopyField value={mcpUrl} label="MCP URL" />
      <Tabs<Client> label="Your agent" idPrefix="cxc" value={client} onChange={setClient} tabs={CLIENTS} />
      <TabPanel idPrefix="cxc" id="claude" active={client === "claude"} className="cx__panel">
        <ol className="cx-steps">
          <Step>Copy the URL.</Step>
          <Step>
            In Claude, open <strong>Settings → Connectors</strong>, then click <strong>Add custom connector</strong>.{" "}
            <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer">
              Open Claude settings <Icon name="external" size={12} className="cx-ext" />
            </a>
          </Step>
          <Step>
            Name it <span className="code-inline">gitring</span>, paste the URL and click <strong>Add</strong>. Then click <strong>Connect</strong>.
          </Step>
          <Step>
            gitring asks you to allow Claude. Click <strong>Allow</strong>. Claude can now read your projects, send plans and push work in any chat.
          </Step>
        </ol>
        <p className="cx__note">
          <Icon name="info" size={12} />
          <span>On Team and Enterprise plans, an owner adds the connector in Organization settings → Connectors.</span>
        </p>
      </TabPanel>
      <TabPanel idPrefix="cxc" id="claude-code" active={client === "claude-code"} className="cx__panel">
        <CodeBlock shell label="Terminal" code={`claude mcp add --transport http --scope user gitring ${mcpUrl}`} />
        <ol className="cx-steps" start={2}>
          <Step>
            In Claude Code, type <span className="code-inline">/mcp</span>, choose <strong>gitring</strong>, then <strong>Authenticate</strong>.
          </Step>
          <Step>
            Your browser opens gitring. Click <strong>Allow</strong>.
          </Step>
        </ol>
        <p className="cx__note">
          <Icon name="info" size={12} />
          <span>Optional: add the Claude Code hook (below). Then change requests also arrive in the middle of a task.</span>
        </p>
      </TabPanel>
      <TabPanel idPrefix="cxc" id="cursor" active={client === "cursor"} className="cx__panel">
        <div className="cx-row">
          <a className="b-btn b-btn--primary cx-cursor" href={cursorLink(mcpUrl)}>
            <Icon name="plus" />
            Add to Cursor
          </a>
          <span className="cx__step">Cursor opens and asks to install gitring.</span>
        </div>
        <ol className="cx-steps" start={2}>
          <Step>
            In Cursor, open <strong>Settings → MCP</strong> and click <strong>Login</strong> next to gitring.
          </Step>
          <Step>
            Your browser opens gitring. Click <strong>Allow</strong>.
          </Step>
        </ol>
        <details className="cx-more">
          <summary>Add it by hand</summary>
          <CodeBlock label="~/.cursor/mcp.json" code={cursorJson} copyLabel="Copy config" />
        </details>
      </TabPanel>
      <TabPanel idPrefix="cxc" id="codex" active={client === "codex"} className="cx__panel">
        <CodeBlock shell label="Terminal" code={`codex mcp add gitring --url ${mcpUrl}\ncodex mcp login gitring`} />
        <ol className="cx-steps" start={2}>
          <Step>
            The second command opens your browser. Click <strong>Allow</strong>.
          </Step>
        </ol>
        <p className="cx__note">
          <Icon name="info" size={12} />
          <span>In the Codex app: Settings → MCP servers → Add server, then paste the URL.</span>
        </p>
      </TabPanel>
      <TabPanel idPrefix="cxc" id="other" active={client === "other"} className="cx__panel">
        <p className="cx__step">
          Any MCP client with OAuth 2.1 can connect: streamable HTTP at the URL above, with dynamic client registration and PKCE. The client finds the gitring sign-in by
          itself in the metadata at <span className="code-inline">/.well-known/oauth-protected-resource</span>.
        </p>
        <p className="cx__step">
          A client without OAuth sends a personal API key in the header <span className="code-inline">Authorization: Bearer gk_…</span>. See{" "}
          <a
            href="#cx-keys"
            onClick={(e) => {
              e.preventDefault();
              const el = document.getElementById("cx-keys");
              el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
              el?.setAttribute("tabindex", "-1");
              el?.focus({ preventScroll: true });
            }}
          >
            Use an API key instead
          </a>
          .
        </p>
        <ul className="tools" aria-label="The gitring tools">
          {TOOLS.map(([t, d]) => (
            <li key={t}>
              <span className="voice-agent">{t}</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </TabPanel>
      <LiveStatus client={client} />
    </section>
  );
}

type KeyClient = "claude-code" | "codex" | "cursor" | "other";
const KEY_TABS: { id: KeyClient; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "other", label: "Other" },
];

/** A personal API key: for scripts, hooks and clients without OAuth. The key shows one time only. */
function KeySection({ info }: { info: ConnectInfo }) {
  const me = useMe();
  const signedIn = Boolean(me?.user);
  const [tab, setTab] = useRemembered<KeyClient>("gitring.connect.keytab", "claude-code", KEY_TABS.map((t) => t.id));
  const [name, setName] = useState("my laptop");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createKey(name.trim() || "key");
      setFresh(res.key);
    } catch (err) {
      setError(`The key was not created. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const cursor = JSON.stringify({ mcpServers: { gitring: { url: info.mcpUrl, headers: { Authorization: "Bearer ${env:GITRING_KEY}" } } } }, null, 2);
  return (
    <Section
      id="cx-keys"
      title="Use an API key instead"
      aside={
        <>
          <p>For scripts, hooks and MCP clients without OAuth. A key acts as you: it can do what your roles allow on each project. Keep it in an environment variable.</p>
          <p className="cx__note">
            <Icon name="info" size={12} />
            <span>
              See and revoke your keys on your <Link to="/account">account page</Link>. If a key leaks, revoke it at once.
            </span>
          </p>
        </>
      }
    >
      {signedIn ? (
        <form className="keys__new" onSubmit={create}>
          <Field label="Key name" help="Where you use the key, for example “my laptop” or “CI”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Button type="submit" icon="plus" busy={busy}>
            Create key
          </Button>
        </form>
      ) : (
        <div className="cx-row">
          <span className="cx__step">Sign in to create a key.</span>
          <Button size="sm" variant="primary" onClick={openSignIn}>
            Sign in
          </Button>
        </div>
      )}
      {error && (
        <p className="st-error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      {fresh && (
        <div className="keys__fresh" role="status">
          <p>Copy the key now. gitring shows it only once.</p>
          <CodeBlock shell label="Terminal" code={`export GITRING_KEY=${fresh}`} copyLabel="Copy key" />
        </div>
      )}
      <Tabs<KeyClient> label="Agent client with an API key" idPrefix="cxk" value={tab} onChange={setTab} tabs={KEY_TABS} />
      <TabPanel idPrefix="cxk" id="claude-code" active={tab === "claude-code"} className="cx__panel">
        <CodeBlock shell label="Terminal" code={`claude mcp add --transport http gitring ${info.mcpUrl} --header "Authorization: Bearer $GITRING_KEY"`} />
      </TabPanel>
      <TabPanel idPrefix="cxk" id="codex" active={tab === "codex"} className="cx__panel">
        <CodeBlock label="~/.codex/config.toml" code={`[mcp_servers.gitring]\nurl = "${info.mcpUrl}"\nbearer_token_env_var = "GITRING_KEY"`} copyLabel="Copy config" />
      </TabPanel>
      <TabPanel idPrefix="cxk" id="cursor" active={tab === "cursor"} className="cx__panel">
        <CodeBlock label=".cursor/mcp.json" code={cursor} copyLabel="Copy config" />
        <p className="cx__step">Restart Cursor. The gitring tools show in the MCP list.</p>
      </TabPanel>
      <TabPanel idPrefix="cxk" id="other" active={tab === "other"} className="cx__panel">
        <CodeBlock label="MCP endpoint (streamable HTTP, header Authorization: Bearer <key>)" code={info.mcpUrl} copyLabel="Copy URL" />
      </TabPanel>
    </Section>
  );
}

const TOOLS: [string, string][] = [
  ["gitring_intents", "List the open tasks of a project. Without a project: list your projects."],
  ["gitring_declare", "Send your plan: steps, files and functions. The answer has the result of the conflict check."],
  ["gitring_log", "Report a step. Other agents see it. In git mode, give headSha after each push."],
  ["gitring_traffic", "Read the active work near your plan, and the tasks that merged after your base."],
  ["gitring_read · gitring_list", "Read the files of your work copy."],
  ["gitring_write", "Write files into your work copy. gitring checks your plan again."],
  ["gitring_check", "Run the tests of your work copy."],
  ["gitring_submit", "Submit your work. gitring merges it when the tests pass, or asks a person to choose."],
  ["gitring_ack", "Confirm that you applied a change request."],
  ["gitring_update", "Bring the new main into your work copy. In git mode, you get a read-only remote for main."],
];

export function ConnectView() {
  const projectId = useStore((s) => s.projectId);
  const branch = useStore((s) => s.state?.project.repo.defaultBranch ?? "main");
  const githubOn = useStore((s) => (s.state?.project.settings.github?.mode ?? "off") !== "off");
  const [info, setInfo] = useState<ConnectInfo>(() => defaultConnectInfo(projectId));
  const narrow = useNarrow();

  useEffect(() => {
    setInfo(defaultConnectInfo(projectId));
    const load = () => {
      harborOrNull()
        ?.connect()
        // Fill fields that an older server does not send, so that the page never breaks on them.
        .then((i) => setInfo({ ...defaultConnectInfo(projectId), ...i, inputs: { ...defaultConnectInfo(projectId).inputs, ...(i?.inputs ?? {}) } }))
        .catch(() => undefined);
    };
    load();
    return onHarbor(load);
  }, [projectId]);

  const hook = JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|MultiEdit|Write|Bash",
            hooks: [
              {
                type: "command",
                command: `curl -s -X POST '${info.hookUrl}' -H 'content-type: application/json' -H "authorization: Bearer $GITRING_KEY" --data-binary @-`,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
  const project = info.projectId || projectId;
  const payload = JSON.stringify(
    {
      event: "landing",
      project,
      at: "2026-10-10T12:00:00.000Z",
      landing: { id: "…", intentId: "…", attemptId: "…", method: "merge", mainBefore: "…", mainAfter: "…", correctionsApplied: 1 },
      intent: { id: "…", title: "…" },
      callsign: "…",
      mainSha: "…",
    },
    null,
    2,
  );
  const slackUrl = `${location.origin}/hooks/slack?project=${encodeURIComponent(project)}`;

  return (
    <div className="page connect">
      <p className="page__eyebrow">
        <Icon name="plug" size={14} /> Connect
      </p>
      <h1 className="page__title" tabIndex={-1}>
        Connect your agents
      </h1>
      <p className="page__lede">
        Agents work on this project through MCP or git. gitring checks each plan, sends change requests back to the agents, and merges the work into main when the
        tests pass.
      </p>

      <ConnectorSection mcpUrl={info.mcpUrl} />

      <KeySection info={info} />

      <section className="cx cx--wide" aria-labelledby="cx-flow">
        <div className="cx__text">
          <h2 className="page__h2" id="cx-flow">
            How work flows through gitring
          </h2>
        </div>
        <figure className="flowfig">
          <span className="vh" id="flow-title">
            How agents and apps connect to gitring
          </span>
          <span className="vh" id="flow-desc">
            {flowText(info, githubOn)}
          </span>
          <FlowDiagram vertical={narrow} info={info} githubOn={githubOn} />
        </figure>
      </section>

      <Section
        id="cx-modes"
        title="Two ways to work"
        aside={
          <>
            <p>
              <strong>Edit through gitring.</strong> The agent reads and writes files with <span className="code-inline">gitring_read</span> and{" "}
              <span className="code-inline">gitring_write</span>. gitring keeps the work copy. This is good for small changes.
            </p>
            <p>
              <strong>Git mode.</strong> We recommend it for agents on your computer. The agent works in your repository folder and pushes with git.
            </p>
            <ol className="cx__steps">
              <li>
                Call <span className="code-inline">gitring_declare</span> with <span className="code-inline">mode</span> "git" and{" "}
                <span className="code-inline">workdir</span> set to your repository folder.
              </li>
              <li>Clone the work copy, or add it as a remote. Use the remote and the token from the answer. The token works for 6 hours.</li>
              <li>Commit, then push to that remote.</li>
              <li>
                Call <span className="code-inline">gitring_check</span>, then <span className="code-inline">gitring_submit</span>. gitring reads your latest push
                at check and at submit.
              </li>
              <li>
                Optional: call <span className="code-inline">gitring_log</span> with <span className="code-inline">headSha</span> after each push. You get a
                conflict check at once.
              </li>
            </ol>
          </>
        }
      >
        <CodeBlock
          shell
          label="Git mode, in your repository folder"
          code={`# 1. The answer of gitring_declare has a remote and a token.
export GITRING_REMOTE="<remote from the answer>"
export GITRING_TOKEN="<token from the answer>"
# 2. Add the work copy as a remote.
git remote add gitring "https://x:$GITRING_TOKEN@\${GITRING_REMOTE#https://}"
# 3. Commit, then push.
git push gitring HEAD:${branch}
# 4. Call gitring_check, then gitring_submit.`}
        />
      </Section>

      <Section
        id="cx-hook"
        title="Claude Code hook (optional)"
        aside={
          <>
            <p>Claude Code sends each edit to gitring. gitring answers with the change requests that wait for this agent. The hook uses an API key (GITRING_KEY).</p>
            <p>
              Give your repository folder as <span className="code-inline">workdir</span> when you call <span className="code-inline">gitring_declare</span>. The
              hook finds your work copy by that folder and adds waiting change requests to the agent's context.
            </p>
          </>
        }
      >
        <CodeBlock label=".claude/settings.json" code={hook} copyLabel="Copy hook" />
      </Section>

      <Section
        id="cx-in"
        title="Open tasks from other apps"
        aside={
          <>
            <p>Any app can open a task with one HTTP call and an API key of a project member.</p>
            {info.inputs.githubIssues && (
              <p>
                <strong>GitHub issues.</strong> Label an issue <span className="code-inline">gitring</span> in a GitHub repository that you imported into a project
                where you are a member. gitring opens a task.
              </p>
            )}
            {info.inputs.slack && (
              <p>
                <strong>Slack.</strong> The command <span className="code-inline">/gitring Add a dark mode — Readers can switch to a dark theme.</span> opens a
                task. Set the command URL to <span className="code-inline">{slackUrl}</span>.
              </p>
            )}
          </>
        }
      >
        <CodeBlock
          shell
          label="Terminal"
          code={`curl -X POST ${info.intentsUrl} \\
  -H 'content-type: application/json' \\
  -H "authorization: Bearer $GITRING_KEY" \\
  -d '{"project":"${project}","title":"Add a dark mode","goal":"Readers can switch to a dark theme."}'`}
        />
      </Section>

      <Section
        id="cx-out"
        title="Send events out"
        aside={
          <>
            <p>
              Add a webhook in <Link to="/settings?section=webhooks">Settings → Webhooks</Link>. gitring sends these events as JSON, or as Slack messages:
            </p>
            <ul className="cx__events">
              <li>
                <span className="code-inline">landing</span> a merge
              </li>
              <li>
                <span className="code-inline">correction</span> a change request
              </li>
              <li>
                <span className="code-inline">decision</span> a person decided
              </li>
              <li>
                <span className="code-inline">intent</span> a new task
              </li>
            </ul>
          </>
        }
      >
        <CodeBlock label="POST to your webhook (JSON)" copyLabel="Copy example" code={payload} />
      </Section>

      <Section
        id="cx-github"
        title="Send merged code to GitHub"
        aside={
          <p>
            Turn it on in <Link to="/settings?section=github">Settings → GitHub</Link>. gitring sends each merge to a pull request, or straight to main, and brings
            changes from GitHub in.
          </p>
        }
      >
        <div className="cx__links">
          <Link to="/settings?section=github" className="b-btn b-btn--secondary">
            <Icon name="fork" />
            Open the GitHub settings
          </Link>
        </div>
      </Section>
    </div>
  );
}
