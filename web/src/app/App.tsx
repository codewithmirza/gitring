import { lazy, Suspense, useEffect, useRef } from "react";
import { Button, ProgressRule, ToastHost, EmptyState, toast } from "../design/components";
import { store, useStore } from "../state/store";
import { syncProject } from "../state/api";
import { selectJudgmentQueue } from "../state/selectors";
import { TopBar } from "./TopBar";
import { SignInDialog, WatchBanner } from "./Account";
import { DiffDrawer, FileDrawer, NewIntentDialog, ShortcutsDialog } from "./Dialogs";
import { canonicalPath, isProjectRoute, Link, navigate, useLocationKey, useRoute, type Route } from "./router";
import { openNewIntent, openShortcuts, setUi } from "./ui";
import { ChartView } from "../views/ChartView";
import { HomeView } from "../views/HomeView";

const IntentsView = lazy(() => import("../views/IntentsView").then((m) => ({ default: m.IntentsView })));
const LogbookView = lazy(() => import("../views/LogbookView").then((m) => ({ default: m.LogbookView })));
const ConnectView = lazy(() => import("../views/ConnectView").then((m) => ({ default: m.ConnectView })));
const ProjectsView = lazy(() => import("../views/ProjectsView").then((m) => ({ default: m.ProjectsView })));
const SettingsView = lazy(() => import("../views/SettingsView").then((m) => ({ default: m.SettingsView })));
// The design page is a development aid. Production builds drop this import, so they have no chunk for it.
const DesignView = import.meta.env.DEV ? lazy(() => import("../views/DesignView").then((m) => ({ default: m.DesignView }))) : null;

const TITLES: Record<Route["name"], string> = {
  home: "Many coding agents, one codebase",
  chart: "Overview",
  intents: "Tasks",
  logbook: "History",
  connect: "Connect",
  design: "Design",
  projects: "Projects",
  settings: "Project settings",
  notfound: "Not found",
};

const GO: Record<string, string> = {
  o: "/overview",
  t: "/tasks",
  h: "/history",
  k: "/connect",
  ...(import.meta.env.DEV ? { d: "/design" } : {}),
};

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
      // A new task belongs to the open project: without a project the key does nothing.
      if (e.key === "n" && store.get().state) {
        e.preventDefault();
        openNewIntent();
      }
    };
    const onEvent = () => openShortcuts();
    window.addEventListener("keydown", onKey);
    window.addEventListener("gitring:shortcuts", onEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("gitring:shortcuts", onEvent);
    };
  }, []);
}

/** Announce new decisions once: the decisions list is the person's inbox. */
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
          title: item.kind === "pick" ? "Choose a work copy" : "A decision needs a person",
          text: `“${item.title}”. ${item.detail}.`,
          action: { label: "Compare work copies", onClick: () => navigate(`/tasks/${item.intentId}`) },
        });
      }
      for (const k of [...seen]) if (!q.some((x) => x.key === k)) seen.delete(k);
    });
  }, []);
}

/** Old paths ("/chart", "/intents/…", "/logbook/…") still open, then show the current path. */
function useLocationSync() {
  const loc = useLocationKey();
  useEffect(() => {
    const path = canonicalPath(location.pathname);
    if (path) navigate(path + location.search, { replace: true });
    syncProject();
  }, [loc]);
}

function NotFound() {
  return (
    <div className="page">
      <h1 className="page__title" tabIndex={-1}>
        Not found
      </h1>
      <EmptyState text="This page does not exist." action={<Link to="/overview">Open the overview</Link>} />
    </div>
  );
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
      return <HomeView />;
    case "chart":
      return <ChartView />;
    case "intents":
      return <IntentsView id={route.id} />;
    case "logbook":
      return <LogbookView id={route.id} />;
    case "connect":
      return <ConnectView />;
    case "design":
      return DesignView ? <DesignView /> : <NotFound />;
    case "projects":
      return <ProjectsView />;
    case "settings":
      return <SettingsView />;
    default:
      return <NotFound />;
  }
}

/** Before the first project state: load it, or say why there is no project to show. */
function Booting() {
  const conn = useStore((s) => s.conn);
  const error = useStore((s) => s.error);
  const signedIn = useStore((s) => Boolean(s.me?.user));
  if (conn === "offline" && error) {
    return (
      <div className="booting">
        <EmptyState
          text={error}
          action={
            <div className="c-empty__actions">
              <Link to="/projects">Open the projects</Link>
              {!signedIn && (
                <Button variant="primary" icon="human" onClick={() => setUi({ signIn: true })}>
                  Sign in
                </Button>
              )}
            </div>
          }
        />
      </div>
    );
  }
  return (
    <div className="booting">
      <ProgressRule label="Loading the project" />
      <p>Loading the project…</p>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const ready = useStore((s) => s.state !== null);
  const project = useStore((s) => s.state?.project.name);
  const first = useRef(true);
  const needsProject = isProjectRoute(route);
  useShortcuts();
  useQueueToasts();
  useLocationSync();

  const key = route.name + ("id" in route ? `:${route.id ?? ""}` : "");
  useEffect(() => {
    document.title = route.name === "home" ? `gitring · ${TITLES.home}` : `${TITLES[route.name]}${project && needsProject ? ` · ${project}` : ""} · gitring`;
  }, [route.name, project, needsProject]);
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
        {needsProject && <WatchBanner />}
        {needsProject && !ready ? (
          <Booting />
        ) : (
          <Suspense fallback={<ProgressRule label="Loading the view" />}>
            <View key={key.startsWith("intents") || key.startsWith("logbook") ? route.name : key} route={route} />
          </Suspense>
        )}
      </main>
      <NewIntentDialog />
      <SignInDialog />
      <ShortcutsDialog />
      <FileDrawer />
      <DiffDrawer />
      <ToastHost />
    </div>
  );
}
