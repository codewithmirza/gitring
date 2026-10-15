/**
 * Every word of the landing story in one place: the opening, the seven chapters, the rail and the captions.
 * Read by the story, by the static story and by test/web/story-copy.test.ts, which keeps the plain-word rules.
 * The quoted strings inside the drawings are not here: they are real output of the product (example.ts).
 */

export interface StoryChapterCopy {
  /** The anchor of the chapter: the address #story-<id> opens it. */
  id: string;
  heading: string;
  /** The short name on the rail button. */
  rail: string;
  /** At most two sentences. */
  text: string;
}

export const OPENING = {
  heading: "Three agents change one shop at the same time",
  text: "Main is the shared version of the code. Each agent works on its own line, and tested work comes back to main.",
  cue: "The agents in this example are scripts. Scroll to follow the line.",
} as const;

export const CHAPTERS: readonly StoryChapterCopy[] = [
  {
    id: "start",
    heading: "Start a project",
    rail: "Start",
    text: "Describe what you want to build, pick a template, or let an agent make the project with one call. GitHub is optional.",
  },
  {
    id: "connect",
    heading: "Connect your agents",
    rail: "Connect",
    text: "Each agent connects with one URL and signs in. gitring gives each agent a short name, such as HERON-2, when it sends its first plan.",
  },
  {
    id: "plans",
    heading: "Each agent sends a plan first",
    rail: "Send plans",
    text: "A plan names the files and functions the agent will change. The agent sends it before it writes any code.",
  },
  {
    id: "check",
    heading: "gitring checks plans before code exists",
    rail: "Check plans",
    text: "gitring compares each plan with the 20 nearest active plans and gives each pair a distance from 0 to 5. When two plans collide, one agent gets a change request, and the other agent continues.",
  },
  {
    id: "merge",
    heading: "Tested work merges into main",
    rail: "Merge",
    text: "Tests run in the agent's copy of main, and again on main plus the work before a merge. Work that touches the same files merges one after the other.",
  },
  {
    id: "yes",
    heading: "Risky work waits for a yes",
    rail: "Say yes",
    text: "By default, gitring asks a person when the work looks risky or no test ran. You choose where to answer: in the agent's chat, in the app, or in both.",
  },
  {
    id: "why",
    heading: "Every merge records why it happened",
    rail: "Ask why",
    text: "Click a line number in the Code view to ask why the line is there. The merge record answers with the task, the plan, the change requests, the tests and any decision.",
  },
];

/** The small words: the skip link (also the last item of the rail) and the name of the rail. */
export const SMALL = {
  skip: "Skip the story",
  railLabel: "Story chapters",
} as const;

/** Our own words in the interface voice, set in small type under a drawing. They follow the same word rules. */
export const CAPTIONS = {
  scripts: "In this example, scripts play the apps.",
  request: "Change request to PETREL-9",
  noAgent: "No agent can answer for you.",
  /** Under the request in the stacked layout, where the distance line is not drawn. */
  distance: "Distance 0, same lines.",
} as const;

/** The two-digit number of a chapter, from its index. */
export const chapterNumber = (index: number): string => String(index + 1).padStart(2, "0");
