// Types for compose.mjs (TypeScript callers: test/checks/*.test.ts).

export type Tree = Record<string, string>;
export type Change = Record<string, string | null>;
export type Variant = "files" | "adapted";

export interface DemoCheck {
  path: string;
  description: string;
  content: string;
}

export interface DemoIntent {
  slug: string;
  title: string;
  goal: string;
  checks: DemoCheck[];
  expect: { files: string[]; symbols: string[] };
  fanout?: number;
}

export interface Demo {
  seed: Tree;
  intents: DemoIntent[];
  solutions: Record<string, { files: Tree; adapted?: Tree }>;
}

export const SAMPLE_DIR: string;
export const SOLUTIONS_DIR: string;
export const LANDING_ORDER: string[];
export const ADAPTED_AFTER: string;

export function mergeText(base: string | null, ours: string | null, theirs: string | null): { clean: boolean; content: string | null };
export function applyChange(main: Tree, base: Tree, change: Change): { tree: Tree; conflicts: string[] };
export function parseStep(step: string): { slug: string; variant: Variant };
export function intentOf(demo: Demo, slug: string): DemoIntent;
export function checkFiles(demo: Demo, slug: string): Tree;
export function baseFor(demo: Demo, variant: Variant): Tree;
export function changeFor(demo: Demo, slug: string, variant?: Variant): { base: Tree; change: Tree };
export function treeAlone(demo: Demo, slug: string, variant?: Variant): Tree;
export function land(demo: Demo, steps?: string[]): { tree: Tree; log: { step: string; conflicts: string[] }[]; ok: boolean };
export function testPathsOf(tree: Tree): string[];
export function loadSample(dir?: string, intents?: DemoIntent[], solutionsDir?: string): Promise<Demo>;
export function readTree(dir: string): Promise<Tree>;
