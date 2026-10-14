#!/usr/bin/env node
// Gives the design agent eyes: it shoots every screen of gitring in every theme and size, with real activity in the project.
// Run it: node scripts/shots.mjs   (flags: --only, --themes, --sizes, --out, --full, --no-start; see --help)
//
// What it does, in order:
//   1. builds the app when dist/client is old, and starts the local gitring on free ports (npm run dev:local);
//   2. signs up a test person with a virtual passkey in a real Chromium;
//   3. makes a project with real agents (scripts/meet.mjs, plus three agents with work in progress);
//   4. saves one PNG for each screen, theme and size in tmp/shots/, and tmp/shots/index.json with the facts.
// It stops everything that it started. It never prints or saves the key of the run.
// Read next: scripts/shots/README.md (the modules), docs/design/README.md (how the design agent uses the shots).
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { presetTheme, signUp } from "./shots/account.mjs";
import { parseArgs } from "./shots/args.mjs";
import { launchBrowser, newContext, addPasskey } from "./shots/browser.mjs";
import { checkState, openScreen, saveErrorPicture, savePictures } from "./shots/capture.mjs";
import { inspectPage, tabStops } from "./shots/inspect.mjs";
import { SCREENS, SCREEN_IDS, idsFrom } from "./shots/screens.mjs";
import { seedProject } from "./shots/seed.mjs";
import { buildApp, isBuildStale, startLocal } from "./shots/server.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const say = (line) => console.log(line);
const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");

// ───── The output folder ─────

/** Empties the pictures and the index of an earlier run. It removes only what this tool writes, never other files. */
async function clearOutput(out) {
  await mkdir(path.join(out, "details"), { recursive: true });
  for (const name of await readdir(out)) {
    if (/\.png$/.test(name) || name === "index.json" || name === "details") await rm(path.join(out, name), { recursive: true, force: true });
  }
  await mkdir(path.join(out, "details"), { recursive: true });
}

// ───── One shot ─────

/** Measures the page and its tab order. Saves the details, and returns the short summary for index.json. */
async function measure(page, { out, name }, problems) {
  const facts = await inspectPage(page);
  const stops = await tabStops(page);
  const file = path.join(out, "details", `${name}.json`);
  await writeFile(file, JSON.stringify({ ...facts, tabStops: stops, consoleProblems: problems }, null, 2));
  return {
    heading: facts.heading,
    details: relative(file),
    checks: {
      lowContrast: facts.contrast.failing,
      smallTargets: facts.targets.under24,
      sidewaysScroll: facts.sidewaysScroll,
      typeSizes: facts.sizes.length,
      stopsWithoutRing: stops.filter((stop) => stop.ring === false).length,
      consoleProblems: problems.length,
    },
  };
}

/** Opens one screen, shoots it, and measures it. Returns the record for index.json. A failure is a record, not a throw. */
async function shoot(page, screen, ids, run) {
  const { baseUrl, theme, size, out, full, phase } = run;
  const name = `${screen.id}-${theme}-${size}`;
  const record = { screen: screen.id, path: null, route: screen.route(ids), theme, size, ok: false };
  const problems = [];
  const onProblem = (text) => problems.push(String(text).slice(0, 160));
  const onConsole = (message) => message.type() === "error" && onProblem(message.text());
  page.on("console", onConsole);
  page.on("pageerror", onProblem);
  let release = async () => undefined;
  try {
    release = await openScreen(page, screen, ids, baseUrl);
    const final = new URL(page.url());
    record.finalRoute = final.pathname + final.search;
    record.shownTheme = await checkState(page, { theme, phase });
    const pictures = await savePictures(page, { out, name, full });
    record.path = relative(pictures.file);
    if (pictures.tall) record.full = relative(pictures.tall);
    Object.assign(record, await measure(page, { out, name }, problems));
    record.ok = true;
  } catch (error) {
    record.error = String(error?.message ?? error).split("\n")[0].slice(0, 300);
    const shot = await saveErrorPicture(page, { out, name });
    if (shot) record.errorShot = relative(shot);
  } finally {
    await release().catch(() => undefined);
    page.off("console", onConsole);
    page.off("pageerror", onProblem);
  }
  return record;
}

// ───── One phase ─────

/** Every selected screen of one phase, in every size and theme. Each size and theme gets its own context. */
async function shootPhase(browser, phase, screens, ids, run) {
  const records = [];
  for (const size of run.sizes) {
    for (const theme of run.themes) {
      const context = await newContext(browser, size, phase === "out" ? undefined : run.storageState);
      await presetTheme(context, theme);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      for (const screen of screens) {
        const record = await shoot(page, screen, ids, { ...run, theme, size, phase });
        say(`${record.ok ? "ok   " : "FAIL "} ${screen.id}-${theme}-${size}${record.ok ? "" : `  ${record.error}`}`);
        records.push(record);
      }
      await context.close();
    }
  }
  return records;
}

// ───── The run ─────

/** Signs up the test person, shoots the screens of a new person, then seeds the project. Returns the records and the ids. */
async function setUpPerson(browser, run, chosen, key) {
  const context = await newContext(browser, "desktop");
  const page = await context.newPage();
  await addPasskey(page);
  await signUp(page, run.baseUrl, "Mirza Baig");
  run.storageState = await context.storageState();
  say("A test person signed up with a virtual passkey.");
  // The screens of a new person come first: the seed gives the person a project.
  const records = await shootPhase(browser, "empty", chosen.filter((screen) => screen.phase === "empty"), {}, run);
  const needsSeed = chosen.some((screen) => screen.phase === "project" || screen.id === "approve-signed-out");
  const ids = needsSeed ? idsFrom(await seedProject({ baseUrl: run.baseUrl, key, page, say })) : {};
  await context.close();
  return { records, ids };
}

/** The whole run: server, browser, person, seed, shots. Returns the records. It stops what it started, also after an error. */
async function runShots(options, chosen) {
  const out = path.resolve(ROOT, options.out);
  const needsAccount = chosen.some((screen) => screen.phase !== "out" || screen.id === "approve-signed-out");
  await clearOutput(out);
  let server = null;
  let browser = null;
  try {
    if (options.start) {
      if (isBuildStale(ROOT)) buildApp(ROOT, say);
      server = await startLocal(ROOT, say);
    }
    const run = { baseUrl: server?.url ?? options.url, out, full: options.full, sizes: options.sizes, themes: options.themes, storageState: undefined };
    browser = await launchBrowser();
    const records = [];
    let ids = {};
    if (needsAccount) {
      const setup = await setUpPerson(browser, run, chosen, server?.key ?? options.key);
      records.push(...setup.records);
      ids = setup.ids;
    }
    for (const phase of ["out", "project"]) {
      records.push(...(await shootPhase(browser, phase, chosen.filter((screen) => screen.phase === phase), ids, run)));
    }
    return records;
  } finally {
    await browser?.close().catch(() => undefined);
    server?.stop();
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2), process.env, SCREEN_IDS);
  if (!parsed.options) {
    for (const line of parsed.lines) say(line);
    return parsed.code ?? 2;
  }
  const { options } = parsed;
  const chosen = SCREENS.filter((screen) => options.only.includes(screen.id));
  const records = await runShots(options, chosen);

  const order = (record) => SCREEN_IDS.indexOf(record.screen) * 100 + options.sizes.indexOf(record.size) * 10 + options.themes.indexOf(record.theme);
  records.sort((a, b) => order(a) - order(b));
  const out = path.resolve(ROOT, options.out);
  await writeFile(path.join(out, "index.json"), JSON.stringify(records, null, 2));
  const failed = records.filter((record) => !record.ok);
  say(`\n${records.length - failed.length} of ${records.length} shots saved in ${relative(out)}. Read ${relative(path.join(out, "index.json"))}.`);
  for (const record of failed) say(`  failed: ${record.screen} ${record.theme} ${record.size}: ${record.error}`);
  return failed.length === records.length && records.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  },
);
