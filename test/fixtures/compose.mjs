// Test fixture: compose the reference solutions of the sample intents the way Gitring lands attempts
// (a line-based 3-way merge for each file). Tests use it to prove that every sample intent can pass
// its checks and that the solutions compose. Pure, except loadSample(), which reads disk (Node only).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diff3Merge } from "node-diff3";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The sample project: seed repo, intents, checks. */
export const SAMPLE_DIR = path.resolve(HERE, "../../sample");
/** Reference solutions of the sample intents (test fixtures only). */
export const SOLUTIONS_DIR = path.resolve(HERE, "sample-solutions");

/** The landing order that the tests validate (slug or slug:variant). */
export const LANDING_ORDER = ["currency", "api-item", "dark-mode", "search:adapted", "staff-picks:adapted"];

/** Solutions in adapted/ are based on the seed plus this landed intent. */
export const ADAPTED_AFTER = "currency";

/**
 * 3-way merge of one text file (ours = main, theirs = the attempt). null means "the file is absent".
 * Changes on both sides need at least one unchanged line between them, as in git.
 */
export function mergeText(base, ours, theirs) {
  if (ours === theirs) return { clean: true, content: ours };
  if (base === ours) return { clean: true, content: theirs };
  if (base === theirs) return { clean: true, content: ours };
  if (base === null || ours === null || theirs === null) return { clean: false, content: ours };
  const regions = diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"), { excludeFalseConflicts: true });
  if (regions.some((region) => region.conflict)) return { clean: false, content: ours };
  return { clean: true, content: regions.flatMap((region) => region.ok).join("\n") };
}

/** Land a change (path → full new content, null = delete) that was made on `base` onto `main`. */
export function applyChange(main, base, change) {
  const tree = { ...main };
  const conflicts = [];
  for (const [file, theirs] of Object.entries(change)) {
    const result = mergeText(base[file] ?? null, main[file] ?? null, theirs);
    if (!result.clean) conflicts.push(file);
    else if (result.content === null) delete tree[file];
    else tree[file] = result.content;
  }
  return { tree, conflicts };
}

/** "search:adapted" → { slug: "search", variant: "adapted" }. */
export function parseStep(step) {
  const [slug, variant = "files"] = step.split(":");
  if (variant !== "files" && variant !== "adapted") throw new Error(`Unknown variant "${variant}" in "${step}"`);
  return { slug, variant };
}

export function intentOf(demo, slug) {
  const intent = demo.intents.find((i) => i.slug === slug);
  if (!intent) throw new Error(`Unknown intent "${slug}"`);
  return intent;
}

/** The check files of an intent, as a change (Gitring writes them into each attempt). */
export function checkFiles(demo, slug) {
  return Object.fromEntries(intentOf(demo, slug).checks.map((check) => [check.path, check.content]));
}

/** The tree on which a solution variant was written. */
export function baseFor(demo, variant) {
  if (variant === "files") return demo.seed;
  return { ...demo.seed, ...demo.solutions[ADAPTED_AFTER].files, ...checkFiles(demo, ADAPTED_AFTER) };
}

/** The change of one solution variant: its files plus the check files of its intent. */
export function changeFor(demo, slug, variant = "files") {
  const files = demo.solutions[slug]?.[variant];
  if (!files) throw new Error(`No ${variant}/ solution for "${slug}"`);
  return { base: baseFor(demo, variant), change: { ...files, ...checkFiles(demo, slug) } };
}

/** One intent alone on its base: the tree of a fresh attempt that applied the solution. */
export function treeAlone(demo, slug, variant = "files") {
  const { base, change } = changeFor(demo, slug, variant);
  return { ...base, ...change };
}

/** Land the steps in order on the seed. Stops at the first conflict. */
export function land(demo, steps = LANDING_ORDER) {
  let tree = { ...demo.seed };
  const log = [];
  for (const step of steps) {
    const { slug, variant } = parseStep(step);
    const { base, change } = changeFor(demo, slug, variant);
    const result = applyChange(tree, base, change);
    log.push({ step, conflicts: result.conflicts });
    if (result.conflicts.length > 0) return { tree, log, ok: false };
    tree = result.tree;
  }
  return { tree, log, ok: true };
}

/** Test paths of a tree: tests/*.test.js, sorted. */
export function testPathsOf(tree) {
  return Object.keys(tree).filter((file) => /^tests\/[^/]+\.test\.js$/.test(file)).sort();
}

export async function readTree(dir) {
  const tree = {};
  async function walk(rel) {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else tree[child] = await readFile(path.join(dir, child), "utf8");
    }
  }
  await walk("");
  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Read sample/repo, sample/intents.json (unless `intents` is given) and the reference solutions. */
export async function loadSample(dir = SAMPLE_DIR, intents = undefined, solutionsDir = SOLUTIONS_DIR) {
  const seed = await readTree(path.join(dir, "repo"));
  intents ??= JSON.parse(await readFile(path.join(dir, "intents.json"), "utf8"));
  const solutions = {};
  for (const intent of intents) {
    const root = path.join(solutionsDir, intent.slug);
    solutions[intent.slug] = { files: await readTree(path.join(root, "files")) };
    const adapted = await readTree(path.join(root, "adapted")).catch(() => null);
    if (adapted) solutions[intent.slug].adapted = adapted;
  }
  return { seed, intents, solutions };
}
