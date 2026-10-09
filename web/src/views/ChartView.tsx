import { useCallback, useEffect, useState } from "react";
import { Chart } from "../chart/Chart";
import { IntentsRail } from "../app/IntentsRail";
import { TrafficRail } from "../app/TrafficRail";
import { RadioLog } from "../app/RadioLog";
import { setSearchParam, useSearchParam } from "../app/router";
import { openFile } from "../app/ui";
import { AttemptBadge, Button, Callsign, Tabs } from "../design/components";
import { useStore } from "../state/store";
import { selectVessels } from "../state/selectors";

type MobileTab = "chart" | "intents" | "traffic" | "log";

export function ChartView() {
  const vParam = useSearchParam("v");
  const [selected, setSelected] = useState<string | null>(vParam);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);
  const [focusCorrection, setFocusCorrection] = useState<string | null>(null);
  const [tab, setTab] = useState<MobileTab>("chart");
  const [trafficOpen, setTrafficOpen] = useState(false);
  const name = useStore((s) => s.state?.project.name ?? "the project");
  const count = useStore((s) => (s.state ? selectVessels(s.state).length : 0));
  const selVessel = useStore((s) => (s.state && selected ? selectVessels(s.state).find((v) => v.attemptId === selected) ?? null : null));
  const intents = useStore((s) => s.state?.intents.length ?? 0);

  useEffect(() => {
    if (vParam !== selected) setSelected(vParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vParam]);

  const select = useCallback((id: string | null, from: "chart" | "list" = "chart") => {
    setSelected(id);
    setSearchParam("v", id);
    setFocusCorrection(null);
    if (id) {
      setTrafficOpen(true);
      if (from === "list") setFocusReq((r) => ({ id, n: (r?.n ?? 0) + 1 }));
    }
  }, []);

  const onBuoy = useCallback(
    (correctionId: string, attemptId: string) => {
      select(attemptId);
      setFocusCorrection(correctionId);
      setTab("traffic");
    },
    [select],
  );

  return (
    <div className="chartview" data-tab={tab} data-traffic={trafficOpen ? "open" : "closed"}>
      <h1 className="vh" tabIndex={-1}>
        Chart of {name}
      </h1>
      <Tabs<MobileTab>
        className="chartview__tabs"
        label="Chart areas"
        idPrefix="cv"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "chart", label: "Chart" },
          { id: "intents", label: "Intents", count: intents },
          { id: "traffic", label: "Traffic", count: count },
          { id: "log", label: "Log" },
        ]}
      />
      <aside className="chartview__left" id="cv-panel-intents" aria-label="Intents">
        <IntentsRail />
      </aside>
      <section className="chartview__center" aria-label="Chart and radio log">
        <div className="chartview__chart" id="cv-panel-chart">
          <Chart
            selected={selected}
            hovered={hovered}
            onSelect={select}
            onBuoy={onBuoy}
            onParcel={(p) => openFile(p)}
            focusRequest={focusReq}
            projectName={name}
          />
          {selVessel && (
            <div className="chartview__selbar" role="status">
              <Callsign callsign={selVessel.callsign} color={selVessel.color} hull={selVessel.hull} model={selVessel.model} />
              <AttemptBadge status={selVessel.status} failing={selVessel.failing} />
              <Button size="sm" variant="primary" onClick={() => setTab("traffic")}>
                Show details
              </Button>
            </div>
          )}
          <div className="chartview__traffic-toggle">
            <Button size="sm" variant="secondary" icon="layers" aria-expanded={trafficOpen} onClick={() => setTrafficOpen(!trafficOpen)}>
              Traffic {count}
            </Button>
          </div>
        </div>
        <div className="chartview__log" id="cv-panel-log">
          <RadioLog />
        </div>
      </section>
      <aside className="chartview__right" id="cv-panel-traffic" aria-label="Traffic">
        <TrafficRail selected={selected} onSelect={(id) => select(id, "list")} onHover={setHovered} focusCorrection={focusCorrection} />
      </aside>
    </div>
  );
}
