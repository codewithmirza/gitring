// The list of screens to shoot: each route, and the clicks that make the state a person sees.
// Used by: scripts/shots.mjs. A prepare step must act like a person (click, type, press a key). It must not call the API.
// A screen needs one phase: "out" (signed out), "empty" (signed in, no project yet) or "project" (signed in, with the seed).
// The phase "story" is for the landing story: signed out, with the waitlist gate on, and with motion allowed (node scripts/shots.mjs --waitlist).
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHOP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "shop");
const DESCRIPTION = "A small shop API with a cart and prices, with tests";

// ───── Helpers ─────

/** A path of the project of the seed, with ?project= so that the app opens that project. */
const inProject = (route, ids, project = ids.project) => `${route}${route.includes("?") ? "&" : "?"}project=${project}`;

const choose = (page, name) => page.getByRole("button", { name }).first().click();

/** Opens the sign-in panel of the top bar. */
const openSignIn = async (page) => {
  await page.locator("[data-signin-anchor]").first().click();
  await page.getByText("Sign in to gitring").waitFor();
};

/** On the first page of "new project": type a description, then go to its step. */
const describe = async (page) => {
  await page.locator(".np-describe__input").fill(DESCRIPTION);
  await choose(page, /^Next/);
  await page.getByRole("button", { name: /All sources/ }).first().waitFor();
};

// ───── The network ─────

const STATE_URL = new RegExp("/api/projects/[^/]+/state");

/** Holds the project state back for `ms`, so that the screen shows its loading state. Returns the function that puts the network back. */
const slowState = (ms) => async (page) => {
  const handler = async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => undefined);
  };
  await page.route(STATE_URL, handler);
  return () => page.unroute(STATE_URL, handler).catch(() => undefined);
};

/** Makes the project state fail, like a lost connection. Returns the function that puts the network back. */
const lostState = async (page) => {
  const handler = (route) => route.abort("failed");
  await page.route(STATE_URL, handler);
  return () => page.unroute(STATE_URL, handler).catch(() => undefined);
};

// ───── Screens ─────

/**
 * A screen: its id, its phase, its route, an optional `prepare` (clicks), an optional `before` (changes the network, returns a function that
 * puts it back), `loading` (shoot while the content loads), and a sentence that says what it is.
 * @type {{ id: string, phase: "out" | "story" | "empty" | "project", waitlist?: boolean, route: (ids: Record<string, string>) => string, prepare?: (page: import("playwright").Page, ids: Record<string, string>) => Promise<void>, before?: (page: import("playwright").Page, ids: Record<string, string>) => Promise<() => Promise<unknown>>, loading?: boolean, about: string }[]}
 */
export const SCREENS = [
  { id: "landing", phase: "out", route: () => "/", about: "The start page for a stranger." },
  { id: "sign-in", phase: "out", route: () => "/", prepare: openSignIn, about: "The sign-in panel." },
  {
    id: "sign-in-create",
    phase: "out",
    route: () => "/",
    prepare: async (page) => {
      await openSignIn(page);
      await choose(page, /Create an account with a passkey/);
      await page.getByLabel("Your name").waitFor();
    },
    about: "The panel that makes an account with a passkey.",
  },
  { id: "approve-signed-out", phase: "out", route: (ids) => inProject(`/approve/${ids.attempt}`, ids), about: "A person opens the link of a merge question and is not signed in." },

  { id: "overview-no-project", phase: "empty", route: () => "/overview", about: "A new person opens the overview before any project exists." },
  { id: "projects-empty", phase: "empty", route: () => "/projects", about: "The first minute: no project yet." },
  { id: "new-project-describe", phase: "empty", route: () => "/projects", prepare: describe, about: "New project, step: gitring's guesses for a description." },
  {
    id: "new-project-template",
    phase: "empty",
    route: () => "/projects",
    prepare: async (page) => {
      await choose(page, /^Template/);
      await page.getByRole("button", { name: /All sources/ }).first().waitFor();
    },
    about: "New project, step: choose a template.",
  },
  {
    id: "new-project-empty",
    phase: "empty",
    route: () => "/projects",
    prepare: async (page) => {
      await choose(page, /^Empty project/);
      await page.getByRole("button", { name: /All sources/ }).first().waitFor();
    },
    about: "New project, step: an empty project.",
  },
  {
    id: "new-project-git",
    phase: "empty",
    route: () => "/projects",
    prepare: async (page) => {
      await choose(page, /^Import from a git URL/);
      await page.getByRole("button", { name: /All sources/ }).first().waitFor();
    },
    about: "New project, step: import from a git URL.",
  },
  {
    id: "new-project-push",
    phase: "empty",
    route: () => "/projects",
    prepare: async (page) => {
      await choose(page, /^Push with git/);
      await page.getByRole("button", { name: /All sources/ }).first().waitFor();
    },
    about: "New project, step: push with git.",
  },
  {
    id: "new-project-upload",
    phase: "empty",
    route: () => "/projects",
    prepare: async (page) => {
      await page.locator("input[type=file]").setInputFiles(SHOP);
      await page.getByRole("button", { name: /All sources/ }).first().waitFor();
    },
    about: "New project, step: upload a folder.",
  },

  { id: "projects", phase: "project", route: () => "/projects", about: "The list of projects of a person." },
  {
    id: "projects-new",
    phase: "project",
    route: () => "/projects?new=1",
    prepare: async (page) => {
      await page.locator(".np-describe__input").waitFor();
    },
    about: "The New project panel, opened from the button.",
  },
  { id: "overview", phase: "project", route: (ids) => inProject("/overview", ids), about: "The map of the work." },
  { id: "tasks", phase: "project", route: (ids) => inProject("/tasks", ids), about: "The tasks, with the first one open." },
  { id: "task", phase: "project", route: (ids) => inProject(`/tasks/${ids.taskChange}`, ids), about: "One task whose agent got a change request." },
  { id: "task-long", phase: "project", route: (ids) => inProject(`/tasks/${ids.taskLong}`, ids), about: "One task with a very long title and goal." },
  {
    id: "composer",
    phase: "project",
    route: (ids) => inProject("/tasks", ids),
    prepare: async (page) => {
      await page.keyboard.press("n");
      await page.getByPlaceholder(/What must change/).waitFor();
    },
    about: "The panel that writes a new task.",
  },
  { id: "tasks-many", phase: "project", route: (ids) => inProject("/tasks", ids, ids.many), about: "The tasks of a project with 80 tasks." },
  { id: "tasks-loading", phase: "project", route: (ids) => inProject("/tasks", ids), loading: true, before: slowState(8000), about: "The tasks while the project state is still on its way." },
  { id: "overview-offline", phase: "project", route: (ids) => inProject("/overview", ids), before: lostState, about: "The overview when the connection to the project fails." },
  { id: "history", phase: "project", route: (ids) => inProject("/history", ids), about: "The list of merges." },
  { id: "history-entry", phase: "project", route: (ids) => inProject(`/history/${ids.landing}`, ids), about: "The merge record of one merge." },
  { id: "approve", phase: "project", route: (ids) => inProject(`/approve/${ids.attempt}`, ids), about: "The page where a person answers a merge question." },
  { id: "code", phase: "project", route: (ids) => inProject("/code", ids), about: "The code view with no file open." },
  { id: "code-file", phase: "project", route: (ids) => inProject("/code/main/src/price.js", ids), about: "One file, with the agents that work on it." },
  {
    id: "code-why",
    phase: "project",
    route: (ids) => inProject("/code/main/src/price.js", ids),
    prepare: async (page) => {
      await page.locator('.cv-line[data-line="4"] .cv-ln').click();
      await choose(page, /Why line 4/);
      await page.getByText("Open the merge record").waitFor();
    },
    about: "Why is this line here? The popover of line 4.",
  },
  { id: "connect", phase: "project", route: (ids) => inProject("/connect", ids), about: "How to connect an agent." },
  { id: "replay", phase: "project", route: (ids) => inProject("/replay", ids), about: "The replay before play." },
  {
    id: "replay-playing",
    phase: "project",
    route: (ids) => inProject("/replay", ids),
    prepare: async (page) => {
      await page.getByRole("radio", { name: /60 times/ }).click();
      await choose(page, /^Play$/);
      await page.waitForTimeout(2500);
      await choose(page, /^Pause$/);
    },
    about: "The replay in the middle of the history.",
  },
  { id: "settings", phase: "project", route: (ids) => inProject("/settings", ids), about: "The settings of a project." },
  { id: "account", phase: "project", route: () => "/account", about: "The account of the person." },
  { id: "inbox", phase: "project", route: () => "/inbox", about: "What waits for the person, in all projects." },
  {
    id: "palette",
    phase: "project",
    route: (ids) => inProject("/overview", ids),
    prepare: async (page) => {
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox").first().waitFor();
    },
    about: "The command palette.",
  },
  { id: "notfound", phase: "project", route: () => "/nowhere", about: "A path that does not exist." },
  { id: "project-missing", phase: "project", route: () => "/overview?project=p_missing", about: "A link to a project that the person cannot open." },
  { id: "overview-new-project", phase: "project", route: (ids) => inProject("/overview", ids, ids.quiet), about: "The overview of a project with no activity (a long project name)." },
  { id: "tasks-new-project", phase: "project", route: (ids) => inProject("/tasks", ids, ids.quiet), about: "The tasks of a project with no tasks." },
  { id: "history-new-project", phase: "project", route: (ids) => inProject("/history", ids, ids.quiet), about: "The history of a project with no merge." },
  { id: "code-new-project", phase: "project", route: (ids) => inProject("/code", ids, ids.quiet), about: "The code of a project that has only its first files." },
];

// ───── The landing story ─────

/** The scroll positions of the story, as a share of the pinned part (or of the stacked part on a phone). */
const STORY_STEPS = [0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.84, 1];

/** Scrolls the box of the page (.wl) so that the story is at a progress, then waits until the engine has caught up. */
const storyAt = (progress) => async (page) => {
  await page.waitForSelector(".story[data-ready]");
  await page.evaluate((share) => {
    const root = document.querySelector(".wl");
    const section = document.querySelector("#story");
    const stage = section.querySelector(".story-stage");
    const top = section.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    const pinned = section.dataset.mode === "horizontal" ? section.offsetHeight - stage.offsetHeight : section.offsetHeight - root.clientHeight;
    root.scrollTop = top + share * pinned;
  }, progress);
  await page.waitForTimeout(900);
};

SCREENS.push(
  ...STORY_STEPS.map((progress) => ({
    id: `landing-story-${String(Math.round(progress * 100)).padStart(3, "0")}`,
    phase: "story",
    waitlist: true,
    route: () => "/",
    prepare: storyAt(progress),
    about: `The scroll story of the landing page at ${Math.round(progress * 100)} percent (the gate of the waitlist is on).`,
  })),
);

export const SCREEN_IDS = SCREENS.map((screen) => screen.id);
/** The screens that need the gate of the waitlist. The tool shoots them only with --waitlist. */
export const WAITLIST_IDS = SCREENS.filter((screen) => screen.waitlist).map((screen) => screen.id);

// ───── The ids that the screens need ─────

/** Picks the work copy, merge and tasks of the seed that the screens open. */
export function idsFrom(seed) {
  const { state } = seed;
  const intents = state.intents ?? [];
  const waiting = (state.attempts ?? []).find((attempt) => attempt.status === "ready");
  return {
    project: seed.project,
    quiet: seed.quiet ?? seed.project,
    many: seed.many ?? seed.project,
    attempt: waiting?.id ?? "a_missing",
    landing: (state.landings ?? []).at(-1)?.id ?? "ld_missing",
    taskChange: intents.find((intent) => intent.title.startsWith("Round prices"))?.id ?? "i_missing",
    taskLong: intents.find((intent) => intent.title.startsWith("Show one line"))?.id ?? "i_missing",
  };
}
