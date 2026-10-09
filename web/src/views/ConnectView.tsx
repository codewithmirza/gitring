import { useEffect, useState, type ReactNode } from "react";
import { Button, CodeBlock, Field, Input, Tabs, TabPanel, toast } from "../design/components";
import type { ApiKeyInfo } from "../../../src/core/accounts";
import { createKey, listKeys, revokeKey, useMe } from "../state/account";
import { setUi } from "../app/ui";
import { Icon, Mark, type IconName } from "../design/icons";
import { harborOrNull, onHarbor, defaultConnectInfo, type ConnectInfo } from "../state/api";
import { useStore } from "../state/store";
import "./connect.css";

/* ───────────── flow diagram ───────────── */

interface Node {
  label: string;
  via: string;
  icon: IconName;
  group: "agent" | "git" | "app";
}

const INPUTS: Node[] = [
  { label: "Claude Code", via: "MCP + hook", icon: "compass", group: "agent" },
  { label: "Codex", via: "MCP", icon: "compass", group: "agent" },
  { label: "Cursor", via: "MCP", icon: "compass", group: "agent" },
  { label: "Any git client", via: "git push to a fork", icon: "fork", group: "git" },
  { label: "GitHub issue", via: "webhook", icon: "plug", group: "app" },
  { label: "Any app", via: "JSON to /hooks/intents", icon: "plug", group: "app" },
  { label: "Slack /gitring", via: "webhook", icon: "plug", group: "app" },
];

const OUTPUTS: { label: string; via: string; icon: IconName }[] = [
  { label: "main in Cloudflare Artifacts", via: "single writer", icon: "anchor" },
  { label: "Slack message", via: "webhook, Slack format", icon: "send" },
  { label: "Webhook JSON", via: "landing · correction · decision", icon: "plug" },
  { label: "CI or deploy hook", via: "webhook on each landing", icon: "launch" },
  { label: "Browser UI", via: "live events over WebSocket", icon: "compass" },
];

const STAGES: { label: string; icon: IconName; note: string }[] = [
  { label: "Course check", icon: "range", note: "Clef-flash · ~0.3 s" },
  { label: "Corrections", icon: "buoy", note: "rules of the road" },
  { label: "Re-plot", icon: "compass", note: "work moves onto each new main" },
  { label: "Landing ladder", icon: "anchor", note: "ff → merge → re-derive" },
  { label: "Logbook", icon: "logbook", note: "the why, as git notes" },
];

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

function FlowDiagram({ vertical }: { vertical: boolean }) {
  if (vertical) {
    const W = 360;
    const nodeH = 46;
    const inY = (i: number) => 40 + i * (nodeH + 8);
    const midTop = inY(INPUTS.length) + 34;
    const midH = 76 + STAGES.length * 46;
    const outY = (i: number) => midTop + midH + 50 + i * (nodeH + 8);
    const H = outY(OUTPUTS.length) + 10;
    return (
      <svg className="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="flow-title flow-desc">
        <text x={0} y={16} className="flow__col">
          In
        </text>
        {INPUTS.map((n, i) => (
          <NodeBox key={n.label} x={0} y={inY(i)} w={W} h={nodeH} label={n.label} via={n.via} icon={n.icon} side="in" />
        ))}
        <path className="flow__wire" d={`M${W / 2} ${inY(INPUTS.length) - 4} V${midTop}`} markerEnd="url(#flow-arrow)" />
        <GitringBox x={0} y={midTop} w={W} h={midH} />
        <path className="flow__wire" d={`M${W / 2} ${midTop + midH} V${midTop + midH + 40}`} markerEnd="url(#flow-arrow)" />
        <text x={0} y={midTop + midH + 32} className="flow__col">
          Out
        </text>
        {OUTPUTS.map((n, i) => (
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
  const H = inY(INPUTS.length) + 10;
  const bx = 392;
  const bw = 356;
  const by = 50;
  const bh = H - 84;
  const outX = W - outW;
  // The corrections stage (index 1) sends the magenta wire back to the agents.
  const stageStep = (bh - 76) / STAGES.length;
  const corrY = by + 60 + stageStep + (stageStep - 10) / 2;
  return (
    <svg className="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="flow-title flow-desc">
      <text x={0} y={18} className="flow__col">
        In: agents and apps send work
      </text>
      <text x={outX} y={18} className="flow__col">
        Out: gitring sends results
      </text>
      {INPUTS.map((n, i) => {
        const y = inY(i) + nodeH / 2;
        const ty = by + 48 + i * ((bh - 96) / (INPUTS.length - 1));
        return (
          <path
            key={`w${n.label}`}
            className={`flow__wire flow__wire--${n.group}`}
            d={`M${nodeW} ${y} C${nodeW + 70} ${y}, ${bx - 70} ${ty}, ${bx - 2} ${ty}`}
            markerEnd="url(#flow-arrow)"
          />
        );
      })}
      {/* corrections return to the agents: the only magenta in the diagram */}
      <path
        className="flow__return"
        d={`M${bx + 2} ${corrY} C${bx - 70} ${corrY}, ${nodeW + 80} ${inY(2) + nodeH - 4}, ${nodeW + 4} ${inY(2) + nodeH - 8}`}
        markerEnd="url(#flow-arrow-magenta)"
      />
      <text x={(nodeW + bx) / 2} y={inY(3) + 6} className="flow__returnlabel" textAnchor="middle">
        <tspan x={(nodeW + bx) / 2}>corrections</tspan>
        <tspan x={(nodeW + bx) / 2} dy="14">
          back to agents
        </tspan>
      </text>
      {INPUTS.map((n, i) => (
        <NodeBox key={n.label} x={0} y={inY(i)} w={nodeW} h={nodeH} label={n.label} via={n.via} icon={n.icon} side="in" />
      ))}
      <GitringBox x={bx} y={by} w={bw} h={bh} />
      {OUTPUTS.map((n, i) => {
        const y = outY(i) + nodeH / 2;
        const sy = by + 60 + i * ((bh - 120) / (OUTPUTS.length - 1));
        return <path key={`o${n.label}`} className="flow__wire" d={`M${bx + bw + 2} ${sy} C${bx + bw + 70} ${sy}, ${outX - 70} ${y}, ${outX - 2} ${y}`} markerEnd="url(#flow-arrow)" />;
      })}
      {OUTPUTS.map((n, i) => (
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

function GitringBox({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const step = (h - 76) / STAGES.length;
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
      {STAGES.map((s, i) => {
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
            {i < STAGES.length - 1 && <path className="flow__wire" d={`M${(w - 32) / 2} ${step - 10} V${step}`} />}
          </g>
        );
      })}
    </g>
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

/* ───────────── page ───────────── */

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

type Client = "claude" | "codex" | "cursor" | "other";

/** Personal API keys: MCP clients, hooks and scripts send one as `Authorization: Bearer gk_…`. */
function KeysSection() {
  const me = useMe();
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [name, setName] = useState("my laptop");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = Boolean(me?.user);

  useEffect(() => {
    if (!signedIn) return;
    listKeys().then(setKeys, () => setKeys([]));
  }, [signedIn]);

  if (!signedIn) {
    return (
      <Section
        id="cx-keys"
        title="API keys"
        aside={<p>Agents and scripts need a personal API key. Sign in to create one.</p>}
      >
        <Button variant="primary" icon="human" onClick={() => setUi({ signIn: true })}>
          Sign in
        </Button>
      </Section>
    );
  }

  const create = async () => {
    setBusy(true);
    try {
      const res = await createKey(name.trim() || "key");
      setFresh(res.key);
      setKeys(await listKeys());
    } catch (e) {
      toast({ tone: "danger", title: "The key was not created", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k: ApiKeyInfo) => {
    try {
      await revokeKey(k.id);
      setKeys(await listKeys());
      toast({ tone: "info", title: "Key revoked", text: `${k.name} (${k.prefix}…) stops working now.` });
    } catch (e) {
      toast({ tone: "danger", title: "The key was not revoked", text: (e as Error).message });
    }
  };

  return (
    <Section
      id="cx-keys"
      title="API keys"
      aside={
        <>
          <p>A key acts as you: it can do what your roles allow on each project. gitring shows a new key once. Keep it in an environment variable.</p>
          <p className="cx__note">
            <Icon name="info" size={12} /> Revoke a key at once if it leaks.
          </p>
        </>
      }
    >
      <div className="keys">
        <div className="keys__new">
          <Field label="Key name" help="Where the key lives, for example “my laptop” or “CI”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Button variant="primary" icon="plus" busy={busy} onClick={() => void create()}>
            Create key
          </Button>
        </div>
        {fresh && (
          <div className="keys__fresh" role="status">
            <p>Copy the key now. gitring does not show it again.</p>
            <CodeBlock shell label="Terminal" code={`export GITRING_KEY=${fresh}`} copyLabel="Copy key" />
          </div>
        )}
        <ul className="keys__list" aria-label="Your API keys">
          {(keys ?? []).map((k) => (
            <li key={k.id}>
              <span className="keys__name">{k.name}</span>
              <span className="voice-agent keys__prefix">{k.prefix}…</span>
              <span className="keys__meta">{k.lastUsed ? `used ${new Date(k.lastUsed).toLocaleDateString()}` : "not used yet"}</span>
              <Button size="sm" variant="ghost" icon="close" onClick={() => void revoke(k)}>
                Revoke
              </Button>
            </li>
          ))}
          {keys && !keys.length && <li className="keys__empty">No keys yet.</li>}
        </ul>
      </div>
    </Section>
  );
}

export function ConnectView() {
  const projectId = useStore((s) => s.projectId);
  const [info, setInfo] = useState<ConnectInfo>(() => defaultConnectInfo(projectId));
  const [client, setClient] = useState<Client>("claude");
  const narrow = useNarrow();
  const origin = typeof location !== "undefined" ? location.origin : "";

  useEffect(() => {
    const load = () => {
      harborOrNull()
        ?.connect()
        .then(setInfo)
        .catch(() => setInfo(defaultConnectInfo(projectId)));
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
  const cursor = JSON.stringify({ mcpServers: { gitring: { url: info.mcpUrl, headers: { Authorization: "Bearer ${env:GITRING_KEY}" } } } }, null, 2);
  const remote = info.gitRemoteExample ?? `https://<account-id>.artifacts.cloudflare.net/git/gitring/${projectId}--kestrel-7.git`;

  return (
    <div className="page connect">
      <p className="page__eyebrow">
        <Icon name="plug" size={14} /> Connect
      </p>
      <h1 className="page__title" tabIndex={-1}>
        Connect other apps
      </h1>
      <p className="page__lede">
        Agents and apps send work to gitring through MCP, git and webhooks. gitring checks every course, sends corrections back to the agents, lands the work
        on main and sends the results out.
      </p>

      <figure className="flowfig">
        <span className="vh" id="flow-title">
          How inputs and outputs connect to gitring
        </span>
        <span className="vh" id="flow-desc">
          In: Claude Code, Codex and Cursor connect through MCP; any git client pushes to a fork; GitHub issues, Slack and any app send webhooks. gitring runs
          the course check, sends corrections back to the agents, re-plots work in progress onto each new main, lands work through the landing ladder and
          writes the logbook. Out: main in Cloudflare Artifacts, Slack messages, webhook JSON, CI or deploy hooks, and live events for the browser UI.
        </span>
        <FlowDiagram vertical={narrow} />
      </figure>

      <KeysSection />

      <Section
        id="cx-agents"
        title="Connect a coding agent"
        aside={
          <>
            <p>Add the gitring MCP server to your agent. The agent then declares its course before it writes code, and it gets corrections in every tool result.</p>
            <p className="cx__note">
              <Icon name="info" size={12} /> {info.projectKeyHint}
            </p>
          </>
        }
      >
        <Tabs<Client>
          label="Agent client"
          idPrefix="cx"
          value={client}
          onChange={setClient}
          tabs={[
            { id: "claude", label: "Claude Code" },
            { id: "codex", label: "Codex" },
            { id: "cursor", label: "Cursor" },
            { id: "other", label: "Other MCP clients" },
          ]}
        />
        <TabPanel idPrefix="cx" id="claude" active={client === "claude"} className="cx__panel">
          <CodeBlock shell label="Terminal" code={`claude mcp add --transport http gitring ${info.mcpUrl} --header "Authorization: Bearer $GITRING_KEY"`} />
          <p className="cx__step">
            Optional: get corrections in the middle of a task. Add this hook to <span className="code-inline">.claude/settings.json</span>. Claude Code sends
            each tool result to gitring; gitring answers with the corrections that wait for this agent.
          </p>
          <CodeBlock label=".claude/settings.json" code={hook} copyLabel="Copy hook" />
        </TabPanel>
        <TabPanel idPrefix="cx" id="codex" active={client === "codex"} className="cx__panel">
          <CodeBlock label="~/.codex/config.toml" code={`[mcp_servers.gitring]\nurl = "${info.mcpUrl}"\nbearer_token_env_var = "GITRING_KEY"`} copyLabel="Copy config" />
          <p className="cx__step">Codex reads the corrections in each tool result and continues its work.</p>
        </TabPanel>
        <TabPanel idPrefix="cx" id="cursor" active={client === "cursor"} className="cx__panel">
          <CodeBlock label=".cursor/mcp.json" code={cursor} copyLabel="Copy config" />
          <p className="cx__step">Restart Cursor. The gitring tools show in the MCP list.</p>
        </TabPanel>
        <TabPanel idPrefix="cx" id="other" active={client === "other"} className="cx__panel">
          <CodeBlock label="MCP endpoint (streamable HTTP, header Authorization: Bearer <key>)" code={info.mcpUrl} copyLabel="Copy URL" />
          <ul className="tools">
            {[
              ["gitring_intents", "Read the open intents and a traffic summary."],
              ["gitring_declare", "Declare your course: plan, files, symbols. Get a clearance."],
              ["gitring_log", "Log a step. Other agents see it as traffic."],
              ["gitring_traffic", "Read the vessels near your course."],
              ["gitring_read · gitring_list", "Read files of your working tree."],
              ["gitring_write", "Write files. gitring checks the course again."],
              ["gitring_check", "Run the intent checks in an isolate."],
              ["gitring_submit", "Submit the attempt for landing."],
              ["gitring_ack", "Acknowledge a correction."],
            ].map(([t, d]) => (
              <li key={t}>
                <span className="voice-agent">{t}</span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </TabPanel>
      </Section>

      <Section
        id="cx-git"
        title="Push with git"
        aside={
          <p>
            Declare a course in git mode. The clearance has a fork remote and a short-lived token. Push to the fork; gitring checks the course on every push.
            You never push to main: gitring lands the work.
          </p>
        }
      >
        <CodeBlock
          shell
          label="Terminal"
          code={`# 1. Declare a course with mode "git" (gitring_declare). Keep the token from the clearance.
git remote add gitring "https://x:$GITRING_FORK_TOKEN@${remote.replace(/^https:\/\//, "")}"
# 2. Push your work to the fork. Each push runs a course check.
git push gitring HEAD:main
# 3. Submit through MCP (gitring_submit). gitring lands it on main.`}
        />
      </Section>

      <Section
        id="cx-in"
        title="Send intents from other apps"
        aside={
          <>
            <p>Any app can open an intent with one HTTP call. GitHub issues with the label <span className="code-inline">gitring</span> and the Slack command{" "}
              <span className="code-inline">/gitring</span> open intents too.</p>
          </>
        }
      >
        <CodeBlock
          shell
          label="Terminal"
          code={`curl -X POST ${origin}/hooks/intents \\
  -H 'content-type: application/json' \\
  -H "authorization: Bearer $GITRING_KEY" \\
  -d '{"project":"${projectId}","title":"Show the stock count","goal":"Show In stock or Sold out under each price."}'`}
        />
      </Section>

      <Section
        id="cx-out"
        title="Get events out"
        aside={
          <p>
            Add a webhook target to the project. gitring posts <span className="code-inline">landing</span>, <span className="code-inline">correction</span> and{" "}
            <span className="code-inline">decision</span> events as JSON, or as Slack messages. Every landing links to its why trail.
          </p>
        }
      >
        <CodeBlock
          label="POST to your webhook"
          copyLabel="Copy example"
          code={JSON.stringify(
            {
              type: "landing",
              project: projectId,
              landing: {
                id: "ld-02",
                intentId: "in-currency",
                method: "merge",
                mainAfter: "d20153b",
                correctionsApplied: 1,
                checks: { passed: 17, failed: 0 },
              },
              why: `${origin}/logbook/ld-02`,
            },
            null,
            2,
          )}
        />
      </Section>
    </div>
  );
}
