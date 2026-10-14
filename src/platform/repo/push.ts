/**
 * A small git smart-HTTP client for one job: push a pack of new objects and move refs.
 *
 * Written for Workers (fetch, TextEncoder, no git library). Nothing is cloned first.
 * Its errors are not RepoConflictError: the caller reads the branch and decides what a rejection means.
 * Read next: src/platform/repo/artifacts-backend/writes.ts (the caller).
 */
import { isSha } from "../../core/git/objects";
import { concat } from "./pack";

/*
 * The two calls, and the errors:
 *
 *   advertisedRefs  GET <remote>/info/refs?service=git-receive-pack (Basic auth): every ref of the
 *                   remote with its commit id, plus the capabilities of the server;
 *   pushPack        POST <remote>/git-receive-pack: `<old> <new> <ref>` commands (report-status), a
 *                   flush, then the pack. The server compares every ref with <old> before it moves it
 *                   (compare-and-swap) and answers `unpack ok` and `ok <ref>` or `ng <ref> <reason>`.
 *
 * Errors: GitHttpError (a status that is not 200), GitProtocolError (an answer that is not git's) and
 * PushRejectedError (`ng`, or an unpack that failed). None of them is RepoConflictError: the caller reads
 * the branch and decides what a rejection means.
 */

const ZERO_ID = "0".repeat(40);
const SERVICE = "git-receive-pack";
/** What this client tells the server it is. */
const AGENT = "gitring-changeset/1";

/** One ref to move: `old` null means the ref must not exist yet. */
export interface RefUpdate {
  ref: string;
  old: string | null;
  new: string;
}

export interface GitHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: AsyncIterableIterator<Uint8Array>;
}

export interface GitHttpResponse {
  statusCode: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  body?: AsyncIterableIterator<Uint8Array>;
}

/** The HTTP client this module needs. isomorphic-git's HttpClient has this shape too. */
export interface GitHttp {
  request(req: GitHttpRequest): Promise<GitHttpResponse>;
}

export interface Advertisement {
  /** Full ref name (`refs/heads/main`) → commit id. Empty for an empty repository. */
  refs: Map<string, string>;
  capabilities: Set<string>;
}

export class GitHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHttpError";
  }
}

export class GitProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitProtocolError";
  }
}

/** The server took the pack but did not move a ref, or could not unpack. `reason` is the server's word. */
export class PushRejectedError extends Error {
  constructor(
    message: string,
    readonly ref: string | null,
    readonly reason: string,
  ) {
    super(message);
    this.name = "PushRejectedError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ───────────────────────────── pkt-line ───────────────────────────── */

/** `text` as one pkt-line: 4 hex digits of length (the 4 digits included), then the text. */
export function pktLine(text: string | Uint8Array): Uint8Array {
  const bytes = typeof text === "string" ? encoder.encode(text) : text;
  const length = bytes.byteLength + 4;
  if (length > 65520) throw new Error(`pkt-line too long: ${length} bytes`);
  return concat([encoder.encode(length.toString(16).padStart(4, "0")), bytes]);
}

export const FLUSH_PKT: Uint8Array = encoder.encode("0000");

/** A flush packet is `null`; every other packet is its payload. Stops at `bytes.length`. */
export function readPktLines(bytes: Uint8Array): (Uint8Array | null)[] {
  const out: (Uint8Array | null)[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw new GitProtocolError(`truncated pkt-line length at byte ${at}`);
    const hex = decoder.decode(bytes.subarray(at, at + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GitProtocolError(`bad pkt-line length ${JSON.stringify(hex)} at byte ${at}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      out.push(null);
      at += 4;
      continue;
    }
    if (length < 4 || at + length > bytes.length) throw new GitProtocolError(`pkt-line of ${length} bytes does not fit at byte ${at}`);
    out.push(bytes.subarray(at + 4, at + length));
    at += length;
  }
  return out;
}

/* ───────────────────────────── HTTP ───────────────────────────── */

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function readAll(body: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  if (body) for await (const chunk of body) chunks.push(chunk);
  return concat(chunks);
}

function authHeader(secret: string): string {
  return `Basic ${btoa(`x:${secret}`)}`;
}

async function answerOf(http: GitHttp, req: GitHttpRequest, what: string): Promise<Uint8Array> {
  const res = await http.request(req);
  const body = await readAll(res.body);
  if (res.statusCode !== 200) {
    throw new GitHttpError(`${what}: HTTP ${res.statusCode}${res.statusMessage ? ` ${res.statusMessage}` : ""}`, res.statusCode);
  }
  return body;
}

/** `fetch`-based client (the production default of this module). */
export function fetchHttp(fetchFn: typeof fetch = globalThis.fetch): GitHttp {
  return {
    async request(req) {
      const body = req.body ? await readAll(req.body) : undefined;
      const res = await fetchFn(req.url, { method: req.method, headers: req.headers, ...(body ? { body: body as unknown as ArrayBuffer } : {}) });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return {
        statusCode: res.status,
        statusMessage: res.statusText,
        headers,
        body: res.body ? iterate(res.body) : undefined,
      };
    },
  };
}

async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/* ───────────────────────────── advertisement ───────────────────────────── */

/** The refs of `remote` (a `…/name.git` URL) as git-receive-pack advertises them. */
export async function advertisedRefs(http: GitHttp, remote: string, secret: string): Promise<Advertisement> {
  const body = await answerOf(
    http,
    { url: `${remote}/info/refs?service=${SERVICE}`, method: "GET", headers: { Authorization: authHeader(secret), Accept: "*/*" } },
    "ref advertisement",
  );
  return parseAdvertisement(body);
}

export function parseAdvertisement(body: Uint8Array): Advertisement {
  const lines = readPktLines(body);
  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  let seenService = false;
  let seenRefs = false;
  for (const pkt of lines) {
    if (pkt === null) continue;
    const text = decoder.decode(pkt).replace(/\n$/, "");
    if (!seenService) {
      if (text !== `# service=${SERVICE}`) throw new GitProtocolError(`the ref advertisement starts with ${JSON.stringify(text)}`);
      seenService = true;
      continue;
    }
    const nul = text.indexOf("\0");
    const head = nul < 0 ? text : text.slice(0, nul);
    if (nul >= 0) for (const cap of text.slice(nul + 1).split(" ")) if (cap) capabilities.add(cap);
    const space = head.indexOf(" ");
    const id = head.slice(0, space);
    const name = head.slice(space + 1);
    if (!isSha(id) || !name) throw new GitProtocolError(`bad ref line ${JSON.stringify(head)}`);
    seenRefs = true;
    if (name === "capabilities^{}" && id === ZERO_ID) continue; // an empty repository
    if (name.endsWith("^{}")) continue; // the peeled object of a tag
    refs.set(name, id);
  }
  if (!seenService || !seenRefs) throw new GitProtocolError("the ref advertisement has no refs line");
  return { refs, capabilities };
}

/* ───────────────────────────── push ───────────────────────────── */

export interface PushResult {
  /** Bytes of the request body (commands, flush and pack). */
  sent: number;
}

/** The request body of a push: every command as a pkt-line (report-status on the first), a flush, the pack. */
export function pushBody(updates: readonly RefUpdate[], pack: Uint8Array): Uint8Array {
  if (!updates.length) throw new Error("a push needs at least one ref");
  const parts: Uint8Array[] = [];
  updates.forEach((u, i) => {
    if (!isSha(u.new)) throw new Error(`invalid commit id for ${u.ref}: ${String(u.new)}`);
    if (u.old !== null && !isSha(u.old)) throw new Error(`invalid old commit id for ${u.ref}: ${String(u.old)}`);
    const caps = i === 0 ? `\0report-status agent=${AGENT}` : "";
    parts.push(pktLine(`${u.old ?? ZERO_ID} ${u.new} ${u.ref}${caps}\n`));
  });
  parts.push(FLUSH_PKT);
  parts.push(pack);
  return concat(parts);
}

/**
 * Push `pack` and move `updates` on `remote`. Resolves when the server reports every ref moved. Throws
 * PushRejectedError when the unpack failed or a ref did not move (its `reason` is the server's word, for
 * example "stale ref" or "failed to update ref").
 */
export async function pushPack(http: GitHttp, remote: string, secret: string, updates: readonly RefUpdate[], pack: Uint8Array): Promise<PushResult> {
  const body = pushBody(updates, pack);
  const answer = await answerOf(
    http,
    {
      url: `${remote}/${SERVICE}`,
      method: "POST",
      headers: {
        Authorization: authHeader(secret),
        "Content-Type": `application/x-${SERVICE}-request`,
        Accept: `application/x-${SERVICE}-result`,
      },
      body: once(body),
    },
    "push",
  );
  checkReport(parseReport(answer), updates);
  return { sent: body.byteLength };
}

export interface ReportStatus {
  unpack: string;
  refs: Map<string, { ok: boolean; reason: string }>;
}

/**
 * Parse a report-status answer. This client asks for no side band, so the report comes as plain pkt-lines.
 * A server that sends side-band packets anyway is read too: band 1 holds the report, bands 2 and 3 messages.
 */
export function parseReport(answer: Uint8Array): ReportStatus {
  const report: ReportStatus = { unpack: "", refs: new Map() };
  const take = (pkts: (Uint8Array | null)[]): void => {
    for (const pkt of pkts) {
      if (pkt === null || pkt.length === 0) continue;
      if (pkt[0] === 1) take(readPktLines(pkt.subarray(1)));
      else if (pkt[0] === 2 || pkt[0] === 3) continue;
      else takeLine(report, decoder.decode(pkt));
    }
  };
  take(readPktLines(answer));
  if (!report.unpack) throw new GitProtocolError("the push answer has no unpack status");
  return report;
}

function takeLine(report: ReportStatus, raw: string): void {
  const line = raw.replace(/\n$/, "");
  if (line.startsWith("unpack ")) {
    report.unpack = line.slice(7);
    return;
  }
  const m = /^(ok|ng) (\S+)(?: (.*))?$/.exec(line);
  if (!m) return;
  report.refs.set(m[2], { ok: m[1] === "ok", reason: m[3] ?? "" });
}

function checkReport(report: ReportStatus, updates: readonly RefUpdate[]): void {
  if (report.unpack !== "ok") throw new PushRejectedError(`the server could not unpack the push: ${report.unpack}`, null, report.unpack);
  for (const u of updates) {
    const r = report.refs.get(u.ref);
    if (!r) throw new GitProtocolError(`the push answer says nothing about ${u.ref}`);
    if (!r.ok) throw new PushRejectedError(`the server did not move ${u.ref}: ${r.reason || "no reason given"}`, u.ref, r.reason);
  }
}
