import type { Metrics, Options } from "./load-lib.mjs";

export function runLoad(args: {
  options: Options;
  endpoint: URL;
  key: string;
  fetchImpl?: (input: any, init?: any) => Promise<Response>;
  pollMs?: number;
  spreadMs?: number;
}): Promise<{ metrics: Metrics; totalMs: number }>;
