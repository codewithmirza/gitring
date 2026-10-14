/**
 * Types of the front door cli/gitring.mjs, for the tests and for TypeScript callers.
 * Keep it in line with the export list of gitring.mjs. Each name lives in cli/lib or cli/commands.
 */
export const VERSION: string;
export const CLIENT_ID: string;
export const DEVICE_GRANT: string;
export const MCP_VERSION: string;
export const TOO_OLD: string;
export const CREDENTIALS_FILE: string;
export const USAGE: string[];

export class CliError extends Error {
  code: number;
  constructor(message: string, code?: number);
}

export interface ParsedArgs {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs;
export function serverOrigin(raw: unknown): string;
export function configDir(env: Record<string, string | undefined>, platform: string, home: string): string;

export interface StoredSignIn {
  clientId?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  user?: string;
}
export interface Credentials {
  version: 1;
  current: string | null;
  servers: Record<string, StoredSignIn>;
}
export function readCredentials(dir: string): Credentials;
export function writeCredentials(dir: string, creds: Credentials): void;

export function lastJson(text: string): any;
export function rpcMessage(text: string, contentType?: string): any;
export function isMissingTool(name: string, message: unknown): boolean;
export function toolCallBody(name: string, args: Record<string, unknown>, id?: number): any;
export function age(ms: number): string;
export function titleFrom(text: string): string;
export function gitAuthHeader(token: string): string;
export function plainText(text: unknown): string;
export function safePage(url: string, origin: string): boolean;

export function wsFrame(opcode: number, payload: Buffer | string): Buffer;
export function wsReadFrames(buf: Buffer): { frames: { fin: boolean; opcode: number; payload: Buffer }[]; rest: Buffer };

export interface SocketEvents {
  open?(): void;
  text(message: string): void;
  close(code: number, reason: string): void;
}
export function openSocket(url: string, headers: Record<string, string>, on: SocketEvents): { send(text: string): void; close(): void };

export interface CliIo {
  env?: Record<string, string | undefined>;
  processEnv?: Record<string, string | undefined>;
  fetch?: (input: any, init?: any) => Promise<Response>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  configDir?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  run?: (cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => Promise<number>;
  openUrl?: (url: string) => void;
  connect?: (url: string, headers: Record<string, string>, on: SocketEvents) => { send(text: string): void; close(): void };
  watchRetries?: number;
}

/** Run the command line. Answers the exit code: 0 done, 1 the command did not finish, 2 a wrong command line. */
export function main(argv: string[], io?: CliIo): Promise<number>;
