/**
 * Maps each command word to the function that runs it.
 * Called by main() in cli/gitring.mjs. A command needs a line here and a line in SPEC (lib/args.mjs).
 * Never run a command here. This file only points to the commands.
 */
import { answer } from "./answer.mjs";
import { clone } from "./clone.mjs";
import { inbox } from "./inbox.mjs";
import { login, logout } from "./login.mjs";
import { newProject } from "./new.mjs";
import { projects } from "./projects.mjs";
import { task, tasks } from "./tasks.mjs";
import { watch } from "./watch.mjs";
import { whoami } from "./whoami.mjs";

/** Each command takes ctx and its arguments, and answers the exit code (or nothing, which means 0). */
export const COMMANDS = {
  login,
  logout,
  whoami,
  projects,
  new: newProject,
  clone,
  tasks,
  task,
  inbox,
  yes: (ctx, args) => answer(ctx, args, true),
  back: (ctx, args) => answer(ctx, args, false),
  watch,
};
