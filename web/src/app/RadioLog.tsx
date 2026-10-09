import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../../../src/core/types";
import { IconButton, LogLine, Segmented } from "../design/components";
import { useStore } from "../state/store";
import { byId } from "../state/selectors";

type Filter = "all" | "corrections" | "landings" | "decisions";
const EMPTY: LogEntry[] = [];

const FILTERS: Record<Filter, (l: LogEntry) => boolean> = {
  all: () => true,
  corrections: (l) => l.kind === "correction" || l.kind === "ack",
  landings: (l) => l.kind === "land" || l.kind === "stale" || l.kind === "rederive" || l.kind === "replot",
  decisions: (l) => l.kind === "decision" || l.kind === "intent",
};

function readPref(): boolean {
  try {
    return localStorage.getItem("bearing.radio") !== "closed";
  } catch {
    return true;
  }
}

/** Radio log: every log line from every vessel. An ARIA live region (polite). */
export function RadioLog() {
  const logs = useStore((s) => s.state?.logs ?? EMPTY);
  const agents = useStore((s) => (s.state ? byId(s.state.agents) : null));
  const [open, setOpen] = useState(readPref);
  const [filter, setFilter] = useState<Filter>("all");
  const body = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const shown = useMemo(() => logs.filter(FILTERS[filter]).slice(-150), [logs, filter]);
  const last = logs[logs.length - 1];

  useEffect(() => {
    try {
      localStorage.setItem("bearing.radio", open ? "open" : "closed");
    } catch {
      /* storage blocked */
    }
  }, [open]);

  useEffect(() => {
    if (!stick.current) return;
    // Scroll after paint: no forced layout while events stream in.
    const id = requestAnimationFrame(() => {
      const el = body.current;
      if (el) el.scrollTop = 1e9;
    });
    return () => cancelAnimationFrame(id);
  }, [shown, open]);

  return (
    <section className={["radio", open ? "is-open" : "is-closed"].join(" ")} aria-labelledby="radio-title">
      <div className="radio__head">
        <IconButton
          icon={open ? "chevron-down" : "chevron-up"}
          label={open ? "Collapse the radio log" : "Expand the radio log"}
          size="sm"
          aria-expanded={open}
          aria-controls="radio-body"
          onClick={() => setOpen(!open)}
        />
        <h2 className="radio__title" id="radio-title">
          Radio log
        </h2>
        {open ? (
          <Segmented<Filter>
            label="Filter the radio log"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "corrections", label: "Corrections" },
              { value: "landings", label: "Landings" },
              { value: "decisions", label: "Decisions" },
            ]}
          />
        ) : (
          last && (
            <div className="radio__ticker" aria-hidden="true">
              <LogLine log={last} agent={last.agentId ? agents?.get(last.agentId) : undefined} />
            </div>
          )
        )}
      </div>
      <div
        id="radio-body"
        ref={body}
        className="radio__body"
        hidden={!open}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Radio log"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <div role="list">
          {shown.map((l) => (
            <LogLine key={l.id} log={l} agent={l.agentId ? agents?.get(l.agentId) : undefined} />
          ))}
        </div>
      </div>
    </section>
  );
}
