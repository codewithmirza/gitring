export const MEET_USAGE: string[];

export interface MeetOptions {
  approval: boolean;
  waitSec: number;
  keep: boolean;
}

/** `lines` and `code` mean: print the lines and exit with the code. Otherwise `options`, `endpoint` and `key` are set. */
export function prepareMeet(
  argv: string[],
  env: Record<string, string | undefined>,
): { code?: number; lines?: string[]; options?: MeetOptions; endpoint?: URL; key?: string };

export function runMeet(args: {
  endpoint: URL;
  key: string;
  options?: Partial<MeetOptions>;
  say?: (line: string) => void;
  fetchImpl?: (input: any, init?: any) => Promise<Response>;
  pollMs?: number;
}): Promise<{ ok: boolean; project: string; merges: number; changeRequests: number; waiting: boolean }>;
