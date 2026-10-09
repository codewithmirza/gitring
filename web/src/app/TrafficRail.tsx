import { memo, useEffect, useMemo, useRef } from "react";
import type { AgentInfo, Correction, LogEntry } from "../../../src/core/types";
import { AttemptBadge, Badge, Button, Callsign, CorrectionNotice, EmptyState, IconButton, LogLine, Panel, RangeIndicator, SectionLabel } from "../design/components";
import { Icon } from "../design/icons";
import { useStore } from "../state/store";
import { byId, indexes, selectVessels, type VesselModel } from "../state/selectors";
import { modelShort, plural } from "../state/format";
import { Link } from "./router";
import { openDiff, openFile } from "./ui";
import { useNow } from "./useNow";

const EMPTY: VesselModel[] = [];

const KIND_TEXT: Record<AgentInfo["kind"], string> = { builtin: "Built-in", mcp: "MCP", git: "Git", sim: "Simulated" };

const VesselRow = memo(function VesselRow({
  v,
  selected,
  names,
  onSelect,
  onHover,
}: {
  v: VesselModel;
  selected: boolean;
  names: Map<string, string>;
  onSelect: (id: string | null) => void;
  onHover?: (id: string | null) => void;
}) {
  const near = v.ranges.filter((r) => r.range <= 3).slice(0, 2);
  return (
    <li>
      <button
        type="button"
        className={["vrow b-row", selected && "is-selected"].filter(Boolean).join(" ")}
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : v.attemptId)}
        onMouseEnter={() => onHover?.(v.attemptId)}
        onMouseLeave={() => onHover?.(null)}
        onFocus={() => onHover?.(v.attemptId)}
        onBlur={() => onHover?.(null)}
      >
        <span className="vrow__top">
          <Callsign callsign={v.callsign} color={v.color} hull={v.hull} model={v.model} />
          <span className="vrow__model voice-agent">{modelShort(v.model)}</span>
          <span className="vrow__status">
            <AttemptBadge status={v.status} failing={v.failing} />
          </span>
        </span>
        <span className="vrow__intent voice-human">{v.intentTitle}</span>
        {(near.length > 0 || v.corrections.length > 0) && (
          <span className="vrow__signals">
            {near.map((r) => (
              <span key={r.other} className="vrow__range">
                <RangeIndicator range={r.range} closing={r.closing} corrected={r.corrected} showText={false} to={names.get(r.other)} />
                <span className="voice-agent ink-3">{names.get(r.other)}</span>
                {r.closing && <span className="vrow__closing">closing</span>}
              </span>
            ))}
            {v.corrections.length > 0 && (
              <Badge tone="correction" icon="buoy">
                {plural(v.corrections.length, "correction")}
              </Badge>
            )}
          </span>
        )}
      </button>
    </li>
  );
});

function VesselDetail({ v, onClose, focusCorrection }: { v: VesselModel; onClose: () => void; focusCorrection?: string | null }) {
  const now = useNow(10_000);
  const st = useStore((s) => s.state);
  const ref = useRef<HTMLDivElement | null>(null);
  const idx = st ? indexes(st) : null;
  const agent = idx?.agentById.get(v.agentId);
  const attempt = idx?.attemptById.get(v.attemptId);
  const names = useMemo(() => {
    const m = new Map<string, string>();
    if (st) for (const a of st.attempts) m.set(a.id, byId(st.agents).get(a.agentId)?.callsign ?? a.agentId);
    return m;
  }, [st]);
  const logs = useMemo<LogEntry[]>(() => (st ? st.logs.filter((l) => l.attemptId === v.attemptId).slice(-8) : []), [st, v.attemptId]);
  const corrections: Correction[] = v.corrections;

  useEffect(() => {
    if (!focusCorrection) return;
    const el = ref.current?.querySelector(`[data-corr="${focusCorrection}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusCorrection]);

  if (!attempt) return null;
  const nameOf = (id: string) => names.get(id) ?? id;
  return (
    <div className="vdetail" ref={ref} aria-labelledby="vdetail-title" role="region">
      <div className="vdetail__head">
        <h3 id="vdetail-title" className="vdetail__title">
          <Callsign callsign={v.callsign} color={v.color} hull={v.hull} model={v.model} size="md" />
        </h3>
        <IconButton icon="close" label="Close the vessel detail" size="sm" onClick={onClose} shortcut="Esc" />
      </div>
      <div className="vdetail__meta">
        <AttemptBadge status={v.status} />
        <span className="voice-agent ink-2">{modelShort(v.model)}</span>
        <span className="ink-3">
          {KIND_TEXT[v.kind]}
          {agent?.client ? ` · ${agent.client}` : ""}
          {v.generation > 1 ? ` · generation ${v.generation}` : ""}
        </span>
      </div>
      <Link to={`/intents/${v.intentId}`} className="vdetail__intent voice-human">
        {v.intentTitle}
        <Icon name="arrow-right" size={14} />
      </Link>

      <SectionLabel>Course</SectionLabel>
      <div className="vdetail__block">
        <p className="vdetail__approach voice-agent">{attempt.course.approach}</p>
        <ol className="vdetail__plan voice-agent">
          {attempt.course.plan.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ol>
        <ul className="vdetail__files" role="list" aria-label="Declared files">
          {attempt.course.files.map((f) => {
            const touched = v.track.includes(f);
            const fp = attempt.footprint.files[f];
            return (
              <li key={f}>
                <button type="button" className="filechip" onClick={() => openFile(f)} title={`Read ${f} on main`}>
                  <Icon name={touched ? "file" : "ring"} size={12} />
                  <span className="voice-agent">{f}</span>
                  {fp && (
                    <span className="filechip__stat voice-agent">
                      <span className="add">+{fp.additions}</span> <span className="del">−{fp.deletions}</span>
                    </span>
                  )}
                  {v.file === f && <span className="filechip__here">here</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {v.ranges.length > 0 && (
        <>
          <SectionLabel count={v.ranges.length}>Range to other vessels</SectionLabel>
          <ul className="vdetail__ranges" role="list">
            {v.ranges.map((r) => (
              <li key={r.other}>
                <RangeIndicator range={r.range} closing={r.closing} corrected={r.corrected} to={nameOf(r.other)} />
                <span className="voice-agent">{nameOf(r.other)}</span>
                <span className="ink-3">{r.corrected ? "correction sent" : r.verdict === "clear" ? "clear" : r.verdict ?? "watch"}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionLabel count={corrections.length}>Corrections</SectionLabel>
      <div className="vdetail__block vdetail__corrs">
        {corrections.length === 0 ? (
          <p className="ink-3">No corrections. The course is clear.</p>
        ) : (
          corrections
            .slice()
            .reverse()
            .map((c) => (
              <div key={c.id} data-corr={c.id}>
                <CorrectionNotice
                  correction={c}
                  to={v.callsign}
                  from={c.standOnAttemptId ? nameOf(c.standOnAttemptId) : undefined}
                  check={st ? idx!.checkById.get(c.checkId) : undefined}
                  nameOf={nameOf}
                  expanded={c.id === focusCorrection}
                  now={now}
                />
              </div>
            ))
        )}
      </div>

      <SectionLabel>Recent log</SectionLabel>
      <div className="vdetail__log" role="list">
        {logs.map((l) => (
          <LogLine key={l.id} log={l} agent={agent} />
        ))}
      </div>

      <div className="vdetail__actions">
        <Button size="sm" icon="diff" onClick={() => openDiff(v.attemptId, v.callsign)}>
          Open diff
        </Button>
        <Link to={`/intents/${v.intentId}`} className="b-btn b-btn--ghost b-btn--sm">
          Compare attempts
        </Link>
      </div>
    </div>
  );
}

export function TrafficRail({
  selected,
  onSelect,
  onHover,
  focusCorrection,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  focusCorrection?: string | null;
}) {
  const vessels = useStore((s) => (s.state ? selectVessels(s.state) : EMPTY));
  const names = useMemo(() => new Map(vessels.map((v) => [v.attemptId, v.callsign])), [vessels]);
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    if (!selected) return;
    requestAnimationFrame(() => listRef.current?.querySelector(".vrow.is-selected")?.scrollIntoView({ block: "nearest" }));
  }, [selected]);
  const sel = vessels.find((v) => v.attemptId === selected) ?? null;
  const closing = vessels.reduce((n, v) => n + v.ranges.filter((r) => r.closing).length, 0) / 2;
  return (
    <Panel
      title="Traffic"
      count={vessels.length}
      headingId="traffic-title"
      className={["rail rail--traffic", sel && "has-detail"].filter(Boolean).join(" ")}
      action={closing > 0 ? <Badge tone="caution" icon="closing">{plural(closing, "pair")} closing</Badge> : undefined}
    >
      <div className="traffic">
        {vessels.length === 0 ? (
          <EmptyState art={false} text="No vessels at sea. Launch an intent to start." />
        ) : (
          <ul role="list" className="traffic__list" aria-label="Vessels" ref={listRef}>
            {vessels.map((v) => (
              <VesselRow key={v.attemptId} v={v} selected={v.attemptId === selected} names={names} onSelect={onSelect} onHover={onHover} />
            ))}
          </ul>
        )}
        {sel ? (
          <VesselDetail v={sel} onClose={() => onSelect(null)} focusCorrection={focusCorrection} />
        ) : (
          vessels.length > 0 && <p className="traffic__hint">Select a vessel to see its course, its corrections and its log.</p>
        )}
      </div>
    </Panel>
  );
}
