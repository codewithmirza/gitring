import { lazy, Suspense, useEffect, useRef } from "react";
import { ProgressRule, ToastHost, EmptyState, toast } from "../design/components";
import { store, useStore } from "../state/store";
import { selectJudgmentQueue } from "../state/selectors";
import { TopBar } from "./TopBar";
import { DiffDrawer, FileDrawer, NewIntentDialog, ShortcutsDialog } from "./Dialogs";
import { Link, navigate, useRoute, type Route } from "./router";
import { openNewIntent, openShortcuts } from "./ui";
import { ChartView } from "../views/ChartView";

const IntentsView = lazy(() => import("../views/IntentsView").then((m) => ({ default: m.IntentsView })));
const LogbookView = lazy(() => import("../views/LogbookView").then((m) => ({ default: m.LogbookView })));
const ConnectView = lazy(() => import("../views/ConnectView").then((m) => ({ default: m.ConnectView })));
const SimView = lazy(() => import("../views/SimView").then((m) => ({ default: m.SimView })));
const DesignView = lazy(() => import("../views/DesignView").then((m) => ({ default: m.DesignView })));

const TITLES: Record<Route["name"], string> = {
  chart: "Chart",
  intents: "Intents",
  logbook: "Logbook",
  connect: "Connect",
  sim: "Simulation",
  design: "Design system",
  notfound: "Not found",
};

const GO: Record<string, string> = { c: "/", i: "/intents", l: "/logbook", k: "/connect", s: "/sim", d: "/design" };

function useShortcuts() {
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "?") {
        e.preventDefault();
        openShortcuts();
        return;
      }
      if (e.key === "g") {
        gAt = Date.now();
        return;
      }
      if (gAt && Date.now() - gAt < 1200) {
        gAt = 0;
        const to = GO[e.key];
        if (to) {
          e.preventDefault();
          navigate(to);
        }
        return;
      }
      if (e.key === "n") {
        e.preventDefault();
        openNewIntent();
      }
    };
    const onEvent = () => openShortcuts();
    window.addEventListener("keydown", onKey);
    window.addEventListener("bearing:shortcuts", onEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("bearing:shortcuts", onEvent);
    };
  }, []);
}

/** Announce new decisions once: the judgment queue is the human's inbox. */
function useQueueToasts() {
  useEffect(() => {
    let seen: Set<string> | null = null;
    let lastState: unknown = null;
    return store.subscribe(() => {
      const st = store.get().state;
      if (!st || st === lastState) return;
      lastState = st;
      const q = selectJudgmentQueue(st);
      if (!seen) {
        seen = new Set(q.map((x) => x.key));
        return;
      }
      for (const item of q) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        toast({
          tone: "info",
          title: item.kind === "pick" ? "A pick is necessary" : "An escalation needs a human",
          text: `“${item.title}”. ${item.detail}.`,
          action: { label: "Compare attempts", onClick: () => navigate(`/intents/${item.intentId}`) },
        });
      }
      for (const k of [...seen]) if (!q.some((x) => x.key === k)) seen.delete(k);
    });
  }, []);
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case "chart":
      return <ChartView />;
    case "intents":
      return <IntentsView id={route.id} />;
    case "logbook":
      return <LogbookView id={route.id} />;
    case "connect":
      return <ConnectView />;
    case "sim":
      return <SimView />;
    case "design":
      return <DesignView />;
    default:
      return (
        <div className="page">
          <h1 className="page__title" tabIndex={-1}>
            Not found
          </h1>
          <EmptyState text="This page is not on the chart. Go back to the chart." action={<Link to="/">Open the chart</Link>} />
        </div>
      );
  }
}

export function App() {
  const route = useRoute();
  const ready = useStore((s) => s.state !== null);
  const project = useStore((s) => s.state?.project.name);
  const first = useRef(true);
  useShortcuts();
  useQueueToasts();

  const key = route.name + ("id" in route ? `:${route.id ?? ""}` : "");
  useEffect(() => {
    document.title = `${TITLES[route.name]}${project ? ` · ${project}` : ""} · Bearing`;
  }, [route.name, project]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Move focus to the new view's heading so screen readers announce the change.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#main h1")?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name]);

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to the content
      </a>
      <TopBar route={route} />
      <main id="main" className={`app__main app__main--${route.name}`} tabIndex={-1}>
        {!ready && route.name !== "design" ? (
          <div className="booting">
            <ProgressRule label="Bearing connects to the harbor" />
            <p>Bearing connects to the harbor.</p>
          </div>
        ) : (
          <Suspense fallback={<ProgressRule label="Loading the view" />}>
            <View key={key.startsWith("intents") || key.startsWith("logbook") ? route.name : key} route={route} />
          </Suspense>
        )}
      </main>
      <NewIntentDialog />
      <ShortcutsDialog />
      <FileDrawer />
      <DiffDrawer />
      <ToastHost />
    </div>
  );
}
