/**
 * Reads the command line: checks the command, its arguments and its options, and says what is wrong.
 * main() in cli/gitring.mjs calls parseArgs. The SPEC table must list the same commands as commands/index.mjs.
 * Never run a command here. Throw a CliError with code 2 instead.
 */
import { CliError } from "./errors.mjs";

// ───── The rules of each command ─────

/** Each command: the number of arguments (min, max), the usage line, and the options it takes. */
const SPEC = {
  login: { min: 0, max: 0, usage: "gitring login [--server URL] [--open]", flags: ["open"] },
  logout: { min: 0, max: 0, usage: "gitring logout" },
  whoami: { min: 0, max: 0, usage: "gitring whoami" },
  projects: { min: 0, max: 0, usage: "gitring projects" },
  new: { min: 1, max: 1, usage: "gitring new <name> [--template NAME] [--describe TEXT] [--public]", flags: ["template", "describe", "public"], missing: "Give a name for the project" },
  clone: { min: 1, max: 2, usage: "gitring clone <project> [folder]", missing: "Give a project" },
  tasks: { min: 1, max: 1, usage: "gitring tasks <project>", missing: "Give a project" },
  task: { min: 3, max: 3, usage: 'gitring task <project> "title" "goal"', missing: "Give a project, a title and a goal" },
  inbox: { min: 0, max: 0, usage: "gitring inbox" },
  yes: { min: 1, max: 2, usage: 'gitring yes <item> ["note"]', missing: "Give an item from gitring inbox" },
  back: { min: 2, max: 2, usage: 'gitring back <item> "note"', missing: "Give an item and a note. The note tells the agent what to change" },
  watch: { min: 1, max: 1, usage: "gitring watch <project>", missing: "Give a project" },
};
const VALUE_FLAGS = new Set(["server", "template", "describe"]);
const BOOL_FLAGS = new Set(["json", "open", "public", "help", "version"]);
/** Options that every command takes. */
const COMMON = new Set(["server", "json", "help", "version"]);

// ───── Reading the command line ─────

/** Read the command line. Throws CliError (code 2) with plain words when it is wrong. */
export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--") {
      rest.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (!a.startsWith("--") || a === "--") {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq < 0 && String(value).startsWith("--"))) throw new CliError(`--${name} needs a value.`, 2);
      flags[name] = String(value);
    } else if (BOOL_FLAGS.has(name) && eq < 0) {
      flags[name] = true;
    } else {
      throw new CliError(`Unknown option ${a}.`, 2);
    }
  }
  if (!rest.length) return { command: flags.version && !flags.help ? "version" : "help", args: [], flags };
  const [command, ...args] = rest;
  if (command === "help") return { command: "help", args: [], flags };
  const spec = SPEC[command];
  if (!spec) throw new CliError(`Unknown command ${command}.`, 2);
  if (flags.help) return { command: "help", args: [], flags };
  for (const f of Object.keys(flags)) {
    if (!COMMON.has(f) && !(spec.flags ?? []).includes(f)) throw new CliError(`gitring ${command} does not take --${f}. Use: ${spec.usage}`, 2);
  }
  if (args.length < spec.min) throw new CliError(`${spec.missing}. Use: ${spec.usage}`, 2);
  if (args.length > spec.max) throw new CliError(`Too many arguments. Use: ${spec.usage}`, 2);
  if (args.some((x) => !x.trim())) throw new CliError(`An argument is empty. Use: ${spec.usage}`, 2);
  return { command, args, flags };
}
