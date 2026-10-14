import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { IntentsRail } from "../app/IntentsRail";
import { TrafficRail } from "../app/TrafficRail";
import { RadioLog } from "../app/RadioLog";
import { setSearchParam, useSearchParam } from "../app/router";
import { openDiff, openFile } from "../app/ui";
import { AttemptBadge, Button, Callsign, ChartFrameArt, Tabs } from "../design/components";
import { useStore } from "../state/store";
import { selectVessels } from "../state/selectors";
import "./chartview.css";

type MobileTab = "chart" | "intents" | "traffic" | "log";

/**
 * The map (and d3-hierarchy for its layout) is its own chunk. Its download starts as soon as this
 * view's code loads, so it runs in parallel with the first render of the rails.
 */
const loadChart = () => import("../chart/Chart");
const chartChunk = typeof window !== "undefined" ? loadChart() : null;
chartChunk?.catch(() => undefined);
const Chart = lazy(() => (chartChunk ?? loadChart()).catch(() => loadChart()).then((m) => ({ default: m.Chart })));

/** The map's place while its code loads: the frame of the map, and a word only after a short wait. */
function MapLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="c-chart c-chart--loading" role="status" aria-label="Please wait for the map">
      {slow && (
        <div className="c-chart__wait">
          <ChartFrameArt size={88} />
          <span>Please wait for the map…</span>
        </div>
      )}
    </div>
  );
}

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

  const onParcel = useCallback((p: string) => openFile(p), []);

  return (
    <div className="chartview" data-tab={tab} data-traffic={trafficOpen ? "open" : "closed"}>
      <h1 className="vh" tabIndex={-1}>
        Overview of {name}
      </h1>
      <Tabs<MobileTab>
        className="chartview__tabs"
        label="Parts of the overview"
        idPrefix="cv"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "chart", label: "Map" },
          { id: "intents", label: "Tasks", count: intents },
          { id: "traffic", label: "Active work", count: count },
          { id: "log", label: "Activity" },
        ]}
      />
      <aside className="chartview__left" id="cv-panel-intents" aria-label="Tasks">
        <IntentsRail />
      </aside>
      <section className="chartview__center" aria-label="Map and activity">
        <div className="chartview__chart" id="cv-panel-chart">
          <Suspense fallback={<MapLoading />}>
            <Chart selected={selected} hovered={hovered} onSelect={select} onBuoy={onBuoy} onParcel={onParcel} focusRequest={focusReq} projectName={name} />
          </Suspense>
          {selVessel && (
            <div className="chartview__selbar" role="status">
              <Callsign callsign={selVessel.callsign} color={selVessel.color} hull={selVessel.hull} model={selVessel.model} />
              <AttemptBadge status={selVessel.status} failing={selVessel.failing} />
              <Button size="sm" variant="primary" onClick={() => setTab("traffic")}>
                Show details
              </Button>
              <Button size="sm" icon="diff" onClick={() => openDiff(selVessel.attemptId, selVessel.callsign)}>
                Open in code
              </Button>
            </div>
          )}
          <div className="chartview__traffic-toggle">
            <Button size="sm" variant="secondary" icon="layers" aria-expanded={trafficOpen} onClick={() => setTrafficOpen(!trafficOpen)}>
              Active work {count}
            </Button>
          </div>
        </div>
        <div className="chartview__log" id="cv-panel-log">
          <RadioLog />
        </div>
      </section>
      <aside className="chartview__right" id="cv-panel-traffic" aria-label="Active work">
        <TrafficRail selected={selected} onSelect={(id) => select(id, "list")} onHover={setHovered} focusCorrection={focusCorrection} />
      </aside>
    </div>
  );
}
