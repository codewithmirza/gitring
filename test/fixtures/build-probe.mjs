#!/usr/bin/env node
// Write test/fixtures/sample-probe.json for the workerd probe in test/workers/checks: the sample seed,
// the intents, the reference solutions and the landed tree (workerd cannot read the disk).
//
//   node test/fixtures/build-probe.mjs
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_ORDER, land, loadSample } from "./compose.mjs";

const sample = await loadSample();
const landed = land(sample, LANDING_ORDER);
if (!landed.ok) throw new Error("The landing order does not compose: " + JSON.stringify(landed.log));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "sample-probe.json");
await writeFile(out, JSON.stringify({ repo: sample.seed, intents: sample.intents, solutions: sample.solutions, landing: { order: LANDING_ORDER, tree: landed.tree } }) + "\n");
console.log(`wrote ${path.relative(process.cwd(), out)}`);
