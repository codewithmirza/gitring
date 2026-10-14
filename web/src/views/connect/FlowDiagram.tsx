/**
 * The diagram at the top of the connect page: what goes into gitring, the stages inside, and what comes out.
 * It shows only real parts: the inputs this deployment has and the outputs this project uses.
 */
import { Icon, Mark, type IconName } from "../../design/icons";
import { type ConnectInfo } from "../../state/api";
import { FLOW_STAGES } from "../connect-text";

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
  const stages: Stage[] = FLOW_STAGES;
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

export function FlowDiagram({ vertical, info, githubOn }: { vertical: boolean; info: ConnectInfo; githubOn: boolean }) {
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
