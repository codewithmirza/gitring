// Reads the command line and the environment of scripts/shots.mjs.
// Used by: scripts/shots.mjs. It never reads a key from the command line: a key on a command line shows in the process list.
import { SIZES } from "./browser.mjs";

export const THEMES = ["day", "dusk", "night"];

export const USAGE = [
  "Usage: node scripts/shots.mjs [--only screen,screen] [--themes day,dusk,night] [--sizes desktop,phone] [--out folder] [--full] [--no-start] [--waitlist]",
  "  --only    the screens to shoot, by id (default: all, or with --waitlist the screens of the landing story). A project screen needs the seed: the tool makes it.",
  "  --themes  day, dusk or night (default: all three).",
  "  --sizes   desktop is 1440x900, phone is 390x844 (default: both).",
  "  --out     the folder for the PNGs and index.json (default: tmp/shots).",
  "  --full    also save a tall PNG of the whole page (name ends with -full.png).",
  "  --no-start  use a gitring that runs already. The address comes from GITRING_URL and the key from GITRING_KEY.",
  "  --waitlist  start gitring with the waitlist gate on, and shoot the landing story (scroll positions, with motion). It cannot shoot the other screens.",
  "Without --no-start the tool builds the app when it is old, starts gitring on free ports, and stops it at the end.",
];

/** Splits "a,b" and checks each part against the allowed values. */
function list(raw, allowed, name) {
  const parts = String(raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const bad = parts.find((part) => !allowed.includes(part));
  if (!parts.length || bad) throw new Error(`${name} must be a list of: ${allowed.join(", ")}.${bad ? ` "${bad}" is not one.` : ""}`);
  return parts;
}

/** Returns the options, or { code, lines } when the tool must print and stop. */
export function parseArgs(argv, env, screenIds, waitlistIds = []) {
  const options = { only: [], themes: [...THEMES], sizes: Object.keys(SIZES), out: "tmp/shots", full: false, start: true, waitlist: false, url: "", key: "" };
  try {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
      const value = () => inline ?? argv[++i];
      if (flag === "--help" || flag === "-h") return { code: 0, lines: USAGE };
      else if (flag === "--only") options.only = list(value(), screenIds, "--only");
      else if (flag === "--themes") options.themes = list(value(), THEMES, "--themes");
      else if (flag === "--sizes") options.sizes = list(value(), Object.keys(SIZES), "--sizes");
      else if (flag === "--out") options.out = String(value() ?? "");
      else if (flag === "--full") options.full = true;
      else if (flag === "--no-start") options.start = false;
      else if (flag === "--waitlist") options.waitlist = true;
      else throw new Error(`Unknown option ${arg}.`);
    }
    if (!options.out) throw new Error("--out needs a folder.");
    // The screens of the landing story need the gate of the waitlist. The other screens need the app, so the two sets never mix.
    const normalIds = screenIds.filter((id) => !waitlistIds.includes(id));
    if (!options.only.length) options.only = options.waitlist ? [...waitlistIds] : normalIds;
    const wrong = options.only.filter((id) => waitlistIds.includes(id) !== options.waitlist);
    if (wrong.length) throw new Error(options.waitlist ? `With --waitlist the tool shoots only the landing story. ${wrong.join(", ")} needs the app.` : `${wrong.join(", ")} needs --waitlist.`);
    if (!options.start) {
      if (!env.GITRING_URL || !env.GITRING_KEY) throw new Error("--no-start needs GITRING_URL and GITRING_KEY in the environment.");
      // Passkeys need a host name, not an address.
      options.url = new URL(env.GITRING_URL).origin.replace("//127.0.0.1", "//localhost");
      options.key = String(env.GITRING_KEY);
    }
    return { options };
  } catch (error) {
    return { code: 2, lines: [String(error?.message ?? error), ...USAGE] };
  }
}
