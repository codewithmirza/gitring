/**
 * The views, each in its own chunk. A view's code loads when its route opens, or earlier when a link to it
 * gets hover or focus (preloadPath). Loading twice is free: the browser keeps each module once.
 */
import { lazy } from "react";
import { parseRoute, type Route } from "./router";

const loaders = {
  chart: () => import("../views/ChartView"),
  intents: () => import("../views/IntentsView"),
  logbook: () => import("../views/LogbookView"),
  approve: () => import("../views/ApproveView"),
  code: () => import("../views/CodeView"),
  connect: () => import("../views/ConnectView"),
  projects: () => import("../views/ProjectsView"),
  settings: () => import("../views/SettingsView"),
  account: () => import("../views/AccountView"),
  inbox: () => import("../views/InboxView"),
} satisfies Partial<Record<Route["name"], () => Promise<unknown>>>;

export const ChartView = lazy(() => loaders.chart().then((m) => ({ default: m.ChartView })));
export const IntentsView = lazy(() => loaders.intents().then((m) => ({ default: m.IntentsView })));
export const LogbookView = lazy(() => loaders.logbook().then((m) => ({ default: m.LogbookView })));
export const ApproveView = lazy(() => loaders.approve().then((m) => ({ default: m.ApproveView })));
export const CodeView = lazy(() => loaders.code().then((m) => ({ default: m.CodeView })));
export const ConnectView = lazy(() => loaders.connect().then((m) => ({ default: m.ConnectView })));
export const ProjectsView = lazy(() => loaders.projects().then((m) => ({ default: m.ProjectsView })));
export const SettingsView = lazy(() => loaders.settings().then((m) => ({ default: m.SettingsView })));
export const AccountView = lazy(() => loaders.account().then((m) => ({ default: m.AccountView })));
export const InboxView = lazy(() => loaders.inbox().then((m) => ({ default: m.InboxView })));

// The design page is a development aid. Production builds drop this import, so they have no chunk for it.
export const DesignView = import.meta.env.DEV ? lazy(() => import("../views/DesignView").then((m) => ({ default: m.DesignView }))) : null;

const started = new Set<string>();

/** Start loading the code of a view (once). */
export function preloadView(name: Route["name"]) {
  if (started.has(name) || !(name in loaders)) return;
  started.add(name);
  void loaders[name as keyof typeof loaders]().catch(() => started.delete(name));
}

/** Start loading the view for an app path ("/tasks/x?project=y"). */
export function preloadPath(to: string) {
  preloadView(parseRoute(to.split(/[?#]/)[0]).name);
}
