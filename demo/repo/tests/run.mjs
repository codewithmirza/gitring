// Run the tests in Node: node tests/run.mjs [files...]
// With no arguments, it runs every tests/*.test.js file. It exits with code 1 if a test fails.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { __run, __setFile } from "../harness/test.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function testFiles(args) {
  if (args.length > 0) return args.map((file) => toRepoPath(path.resolve(file)));
  const names = await readdir(path.join(root, "tests"));
  return names.filter((name) => name.endsWith(".test.js")).sort().map((name) => "tests/" + name);
}

function toRepoPath(absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

const files = await testFiles(process.argv.slice(2));
for (const file of files) {
  __setFile(file);
  await import(pathToFileURL(path.join(root, file)).href);
}

const results = await __run();
for (const r of results) {
  console.log((r.ok ? "PASS  " : "FAIL  ") + r.file + " > " + r.name);
  if (!r.ok) console.log("      " + r.error);
}
const failed = results.filter((r) => !r.ok).length;
console.log("\n" + (results.length - failed) + " passed, " + failed + " failed, " + files.length + " files");
if (results.length === 0) console.log("No tests found.");
process.exitCode = failed > 0 || results.length === 0 ? 1 : 0;
