/**
 * Boots the app state: the person, the project list and the project of the address.
 * It holds the one live client. Called by main.tsx (boot) and by App.tsx after each navigation (syncProject).
 * Never load a second project here: a link to another project reloads the page, so the socket and the store start clean.
 */
import type { ProjectInfo } from "../../../../src/core/accounts";
import { store } from "../store";
import { loadMe, loadProjects, rememberedProject } from "../account";
import { isProjectRoute, navigate, parseRoute, setSearchParam } from "../../app/router";
import { HttpError, isAbort } from "../http";
import { fetchState } from "./fetch-state";
import { LiveHarbor } from "./harbor-client";
import { LiveSocket } from "./live-socket";
import type { HarborClient } from "./types";

let client: HarborClient | null = null;
let socket: LiveSocket | null = null;
const clientListeners = new Set<() => void>();

export function harbor(): HarborClient {
  if (!client) throw new HttpError(0, "The project is not loaded yet. Try again in 2 seconds.");
  return client;
}

export function harborOrNull(): HarborClient | null {
  return client;
}

export function onHarbor(cb: () => void): () => void {
  clientListeners.add(cb);
  return () => {
    clientListeners.delete(cb);
  };
}

function setClient(c: HarborClient) {
  client = c;
  clientListeners.forEach((l) => l());
}

/** A signed-in person's project: the remembered one if they still see it, else their first own project. */
export function defaultProjectFor(projects: ProjectInfo[]): string | null {
  const remembered = rememberedProject();
  if (remembered && projects.some((p) => p.id === remembered)) return remembered;
  return projects.find((p) => p.role === "owner")?.id ?? null;
}

/**
 * The project for a project view: ?project=, else (signed in) the remembered or first own project.
 * null: a visitor without ?project=, or a person without a project.
 */
function chooseProject(params: URLSearchParams): string | null {
  const asked = params.get("project");
  if (asked) return asked;
  const s = store.get();
  return s.me?.user ? defaultProjectFor(s.projects) : null;
}

function needsProject(): boolean {
  return isProjectRoute(parseRoute(location.pathname));
}

/** /api/me and the project list stay fresh for this long at boot (the store keeps them after that). */
export const ME_TTL = 60_000;
export const PROJECTS_TTL = 30_000;

let bootTries = 0;
let inflight: Promise<void> | null = null;

/** Load the person, the project list and (on a project view) the project state. One run at a time. */
export function boot(): Promise<void> {
  inflight ??= run().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // The address names the project: ask for its state now, in parallel with the account requests.
  const early = !client && needsProject() && params.get("project") ? params.get("project")! : null;
  const statePromise = early ? fetchState(early) : null;
  statePromise?.catch(() => undefined); // handled below
  if (!store.get().accountReady) {
    await Promise.all([loadMe({ maxAge: ME_TTL }), loadProjects({ maxAge: PROJECTS_TTL })]).catch(() => undefined);
    store.setAccountReady();
  }
  if (client || !needsProject()) return;
  const projectId = early ?? chooseProject(params);
  if (!projectId) {
    // No project to show: visitors go to the start page, signed-in people to their projects.
    navigate(store.get().me?.user ? "/projects" : "/", { replace: true });
    return;
  }
  // Keep the project in the address, so a copied link opens the same project.
  if (!params.get("project")) setSearchParam("project", projectId);
  store.setProject(projectId);
  try {
    const { state, access } = await (statePromise ?? fetchState(projectId));
    bootTries = 0;
    setClient(new LiveHarbor(projectId));
    store.setMode("live");
    store.setAccess(access);
    store.dispatch({ type: "snapshot", state });
    socket?.stop();
    socket = new LiveSocket(projectId);
    socket.start();
  } catch (e) {
    if (isAbort(e)) return;
    const status = e instanceof HttpError ? e.status : 0;
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      store.setAccess(null);
      store.setConn("offline", (e as Error).message);
      return;
    }
    bootTries++;
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(bootTries - 1, 4));
    store.setConn("offline", `The server is not reachable. gitring tries again in ${Math.round(delay / 1000)} s.`);
    setTimeout(() => void boot(), delay);
  }
}

/**
 * After a navigation inside the app: load the project state that the new view needs.
 * A link to another project than the live one loads the page again, so the socket and the store start clean.
 */
export function syncProject(): void {
  if (inflight || !needsProject()) return;
  if (client) {
    const asked = new URLSearchParams(location.search).get("project");
    if (asked && asked !== client.projectId) location.reload();
    return;
  }
  void boot();
}
