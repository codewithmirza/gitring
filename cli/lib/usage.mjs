/**
 * Holds the help text that `gitring --help` prints, one line for each item of the array.
 * main() in cli/gitring.mjs prints it. test/docs/readme.test.ts checks it against the README.
 * When you add a command, add its line here, its rules in args.mjs and its function in commands/.
 */

export const USAGE = [
  "gitring: the command line for people who work with agents on gitring.",
  "",
  "Usage: gitring <command> [options]",
  "",
  "Commands:",
  "  login [--server URL] [--open]     Sign in. You type a code in your browser.",
  "  logout                            Sign out on this computer.",
  "  whoami                            Show your name and your server.",
  "  projects                          List your projects.",
  "  new <name> [--template NAME] [--describe TEXT] [--public]",
  "                                    Make a project. With --describe, gitring also makes the first task and starts an agent.",
  "  clone <project> [folder]          Clone a project with git. gitring does not save the read token in the folder.",
  "  tasks <project>                   List the open tasks of a project.",
  '  task <project> "title" "goal"     Make a task. Agents can take it.',
  "  inbox                             List the items that wait for you in all your projects.",
  '  yes <item> ["note"]               Say yes to a merge question from your inbox.',
  '  back <item> "note"                Send the work back to the agent. The note tells the agent what to change.',
  "  watch <project>                   Show the log of a project live. Press Ctrl+C to stop.",
  "",
  "Options:",
  "  --server URL    The address of your gitring. The default is the server of your last sign-in.",
  "  --json          Show the answer as JSON.",
  "  -h, --help      Show this help.",
  "  --version       Show the version.",
  "",
  "Environment:",
  "  GITRING_URL     The address of your gitring, as with --server.",
  "  GITRING_TOKEN   A personal API key for scripts. Then you need no sign-in.",
  "",
  "Answers to merge questions:",
  "  An answer from the command line counts as your answer only when you allow answers outside the gitring app.",
  '  You set this in the gitring app: Account, "Where do you answer merge questions?".',
  '  With "In the gitring app", answer in the app. The command line shows the link.',
];
