export const LIMITS: { agents: number; tasks: number };
export const USAGE: string[];
export function mulberry32(seed: number): () => number;
export function streamFor(seed: number, name: string): () => number;
export function seededShuffle<T>(items: readonly T[], rng: () => number): T[];
export function startDelays(seed: number, agents: number, spreadMs: number): number[];
export function percentile(sorted: readonly number[], p: number): number;
export function summarize(values: readonly number[]): { count: number; p50: number; p95: number; max: number };

export interface Counts {
  landed: number;
  handed: number;
  failed: number;
  changeRequests: number;
  toolErrors: number;
  protocolErrors: number;
  rateLimited: number;
}

export class Metrics {
  calls: { tool: string; ms: number }[];
  counts: Counts;
  notes: string[];
  record(tool: string, ms: number): void;
  count(name: keyof Counts, n?: number): void;
  note(text: string): void;
  perTool(): { tool: string; count: number; p50: number; p95: number; max: number }[];
}

export function exitCode(counts: Counts): number;
export function formatReport(metrics: Metrics, info: { totalMs: number; project: string; agents: number; tasks: number; seed: number }): string[];
export function costWarning(options: { agents: number; tasks: number; project: string }): string[];
export function endpointOf(raw: string | undefined): URL;

export interface Options {
  project: string;
  agents: number;
  tasks: number;
  seed: number;
}

export function prepare(
  argv: string[],
  env: Record<string, string | undefined>,
): { code: number; lines: string[]; options?: undefined; endpoint?: undefined; key?: undefined } | { code: 0; lines: string[]; options: Options; endpoint: URL; key: string };
export function changeRequestsIn(text: string): { id: string; kind: string }[];
export function lastJson(text: string): any;
