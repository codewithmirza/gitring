import { Suspense, useEffect, useRef } from "react";
import { Button, EmptyState, SkeletonPage, SkeletonSplit, ToastHost, toast } from "../design/components";
import { store, useStore } from "../state/store";
import { atLeast } from "../../../src/core/accounts";
import { syncProject } from "../state/api";
import { selectJudgmentQueue, type OtherJudgmentItem } from "../state/selectors";
import { tabTitle, useMyQuestions } from "../state/approvals";
import { TopBar, ViewNav } from "./TopBar";
import { ApprovalTray } from "./ApprovalTray";
import { SignInPopover, WatchBanner } from "./Account";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsPopover } from "./Shortcuts";
import { canonicalPath, isProjectRoute, Link, navigate, setPreloader, setSearchParam, useLocationKey, useRoute, type Route } from "./router";
import { getUi, openNewIntent, openPalette, openShortcuts, openSignIn, setUi, takeAfterSignIn } from "./ui";
import { typing } from "./keys";
import * as V from "./views";
import { HomeView } from "../views/HomeView";

// Links start loading a view's code on hover and focus.
setPreloader(V.preloadPath);

const TITLES: Record<Route["name"], string> = {
  home: "Many coding agents, one codebase",
  chart: "Overview",
  intents: "Tasks",
  logbook: "History",
  approve: "Approve a merge",
  code: "Code",
  connect: "Connect",
  design: "Design",
  projects: "Projects",
  settings: "Project settings",
  account: "Account",
  notfound: "Not found",
};

const GO: Record<string, string> = {
  o: "/overview",
  t: "/tasks",
  h: "/history",
  c: "/code",
  k: "/connect",
  p: "/projects",
  a: "/account",
  ...(import.meta.env.DEV ? { d: "/design" } : {}),
};

function useShortcuts() {
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+K or ⌘K opens and closes the palette from anywhere, also from a text field.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (getUi().palette) setUi({ palette: false });
        else openPalette();
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      if (document.querySelector("dialog[open]")) return;
      // Inside a popover, letters belong to the popover (a menu jumps to an item by its first letter).
      if ((e.target as HTMLElement | null)?.closest?.(".b-pop")) return;
      if (e.key === "?") {
        e.preventDefault();
        openShortcuts();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        openPalette();
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

/** How long "work could not merge" must last before it gets a toast (see useQueueToasts). */
const SETTLE_MS = 1500;

/**
 * Announce new decisions once. A merge that waits for a yes has its own chip in the tray, so it gets no toast:
 * this is for the other items (work that could not merge, a conflict check that asks for a person).
 * "Could not merge" can be a short moment: when a person sends work back, its work copy is stale for a moment
 * before the new one starts. That kind of item waits a little, and the toast comes only if it is still there.
 */
function useQueueToasts() {
  useEffect(() => {
    let seen: Set<string> | null = null;
    let lastState: unknown = null;
    const waiting = new Map<string, number>();
    const items = (): OtherJudgmentItem[] => {
      const s = store.get();
      // Only people who can decide get the toast.
      return s.state && atLeast(s.access, "member")
        ? selectJudgmentQueue(s.state, { id: s.me?.user?.id, role: s.access }).filter((x): x is OtherJudgmentItem => x.kind !== "approval")
        : [];
    };
    const announce = (item: OtherJudgmentItem) => {
      toast({
        tone: "info",
        title: item.kind === "pick" ? "Work is ready to merge" : "A decision needs you",
        text: `“${item.title}”. ${item.detail}.`,
        action: { label: item.kind === "pick" ? "Compare work copies" : "Open the task", onClick: () => navigate(`/tasks/${item.intentId}`) },
      });
    };
    const unsubscribe = store.subscribe(() => {
      const st = store.get().state;
      if (!st || st === lastState) return;
      lastState = st;
      const q = items();
      if (!seen) {
        seen = new Set(q.map((x) => x.key));
        return;
      }
      for (const item of q) {
        if (seen.has(item.key) || waiting.has(item.key)) continue;
        if (!item.key.startsWith("stuck:")) {
          seen.add(item.key);
          announce(item);
          continue;
        }
        waiting.set(
          item.key,
          window.setTimeout(() => {
            waiting.delete(item.key);
            const now = items().find((x) => x.key === item.key);
            if (!now || !seen || seen.has(now.key)) return;
            seen.add(now.key);
            announce(now);
          }, SETTLE_MS),
        );
      }
      for (const k of [...seen]) if (!q.some((x) => x.key === k)) seen.delete(k);
      for (const [k, timer] of waiting) {
        if (q.some((x) => x.key === k)) continue;
        window.clearTimeout(timer);
        waiting.delete(k);
      }
    });
    return () => {
      unsubscribe();
      waiting.forEach((t) => window.clearTimeout(t));
    };
  }, []);
}

/** Old paths ("/chart", "/intents/…", "/logbook/…") still open, then show the current path. */
function useLocationSync() {
  const loc = useLocationKey();
  useEffect(() => {
    const path = canonicalPath(location.pathname);
    if (path) navigate(path + location.search + location.hash, { replace: true });
    syncProject();
  }, [loc]);
}

/**
 * After the sign-in redirect: finish what the person started (open the composer, the new project picker),
 * or open the sign-in panel again with the reason when the sign-in failed (?signin_error=…).
 */
function useSignInReturn() {
  const ready = useStore((s) => s.accountReady);
  const signedIn = useStore((s) => Boolean(s.me?.user));
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const p = new URLSearchParams(location.search);
    const code = p.get("signin_error");
    if (code) {
      // The Worker sends a fixed code, never free text: a link cannot put its own words on this page.
      const who = p.get("provider") === "google" ? "Google" : p.get("provider") === "github" ? "GitHub" : "The provider";
      const text =
        code === "stopped"
          ? "You stopped the sign-in. Nothing changed."
          : code === "expired"
            ? "The sign-in took too long. Try again."
            : code === "taken"
              ? `This ${who} account belongs to another gitring account. Sign in with it, or remove it there first.`
              : `${who} did not sign you in. Try again.`;
      for (const k of ["signin_error", "provider"]) setSearchParam(k, null);
      if (!signedIn) requestAnimationFrame(() => openSignIn({ error: text }));
      else toast({ tone: "danger", title: code === "taken" ? `${who} was not added` : "Sign-in stopped", text });
      return;
    }
    if (!signedIn) return;
    const then = takeAfterSignIn();
    if (!then) return;
    if (then.kind === "newTask") requestAnimationFrame(() => openNewIntent());
    else if (then.kind === "newProject") navigate("/projects?new=1");
    else navigate(then.to);
  }, [ready, signedIn]);
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
      return <V.ChartView />;
    case "intents":
      return <V.IntentsView id={route.id} />;
    case "logbook":
      return <V.LogbookView id={route.id} />;
    case "approve":
      return <V.ApproveView id={route.id} />;
    case "code":
      return <V.CodeView />;
    case "connect":
      return <V.ConnectView />;
    case "design":
      return V.DesignView ? <V.DesignView /> : <NotFound />;
    case "projects":
      return <V.ProjectsView />;
    case "settings":
      return <V.SettingsView />;
    case "account":
      return <V.AccountView />;
    default:
      return <NotFound />;
  }
}

/** Skeletons in the shape of the view that loads. */
function ViewSkeleton({ route }: { route: Route }) {
  if (route.name === "intents" || route.name === "chart" || route.name === "code") return <SkeletonSplit label={`Loading ${TITLES[route.name].toLowerCase()}`} />;
  return <SkeletonPage label={route.name === "approve" ? "Loading the merge question" : `Loading ${TITLES[route.name].toLowerCase()}`} />;
}

/** Before the first project state: load it, or say why there is no project to show. */
function Booting({ route }: { route: Route }) {
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
                <Button variant="primary" onClick={(e) => openSignIn({ anchor: e.currentTarget, reason: route.name === "approve" ? "Sign in to answer." : "Sign in to open your projects." })}>
                  Sign in
                </Button>
              )}
            </div>
          }
        />
      </div>
    );
  }
  return <ViewSkeleton route={route} />;
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
  useSignInReturn();

  // The code of the view for this route starts loading at once, in parallel with the project state.
  useEffect(() => {
    V.preloadView(route.name);
  }, [route.name]);
  // When the project shows and the browser is idle, load the views people open next.
  useEffect(() => {
    if (!ready) return;
    // Safari has no requestIdleCallback: a timer stands in.
    const w = window as Window & { requestIdleCallback?: Window["requestIdleCallback"]; cancelIdleCallback?: Window["cancelIdleCallback"] };
    const run = () => {
      V.preloadView("intents");
      V.preloadView("chart");
    };
    const id = w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 4000 }) : window.setTimeout(run, 1500);
    return () => (w.cancelIdleCallback ? w.cancelIdleCallback(id) : window.clearTimeout(id));
  }, [ready]);

  const key = route.name + ("id" in route ? `:${route.id ?? ""}` : "");
  // Merges that wait for a yes from this person: the tab title shows the count.
  const waiting = useMyQuestions().length;
  useEffect(() => {
    const usual = route.name === "home" ? `gitring · ${TITLES.home}` : `${TITLES[route.name]}${project && needsProject ? ` · ${project}` : ""} · gitring`;
    document.title = tabTitle(needsProject ? waiting : 0, usual);
  }, [route.name, project, needsProject, waiting]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Move focus to the new view's heading so screen readers announce the change.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#main h1")?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name, route.name === "approve" ? route.id : ""]);

  const showNav = needsProject;
  return (
    <div className={["app", showNav && "app--nav"].filter(Boolean).join(" ")}>
      <a href="#main" className="skip-link">
        Skip to the content
      </a>
      <TopBar route={route} />
      <main id="main" className={`app__main app__main--${route.name}`} tabIndex={-1}>
        {needsProject && <WatchBanner />}
        {needsProject && !ready ? (
          <Booting route={route} />
        ) : (
          <Suspense fallback={<ViewSkeleton route={route} />}>
            <View key={key.startsWith("intents") || key.startsWith("logbook") || key.startsWith("code") ? route.name : key} route={route} />
          </Suspense>
        )}
      </main>
      {showNav && <ViewNav route={route} className="viewnav bottomnav" />}
      <SignInPopover />
      <CommandPalette />
      <ShortcutsPopover />
      <ApprovalTray route={route} />
      <ToastHost />
    </div>
  );
}
