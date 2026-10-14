/**
 * The waitlist gate: who may use this gitring, and the record of interest that each waiting person leaves.
 *
 * The gate is off unless ALLOWLIST_EMAILS or WAITLIST_ENABLED="true" is set, so a self-hosted gitring and local development are not gated.
 * No runtime dependencies.
 */

import { monthlyValue, PLAN_IDS, type PlanId } from "./plans";

/** The settings of the gate (a part of the Worker environment). */
export interface GateEnv {
  /** Variable: "true" turns the gate on, "false" turns it off even when an allowlist exists. */
  WAITLIST_ENABLED?: string;
  /** Secret: emails that may use gitring, separated by commas. */
  ALLOWLIST_EMAILS?: string;
}

/** The emails of the secret, in lowercase. A bare "user:<account id>" entry names an account without an email. */
export function parseAllowlist(raw: string | undefined): string[] {
  return [...new Set(String(raw ?? "").split(/[,\n;]/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** Is the gate on? On with WAITLIST_ENABLED="true", or with a non-empty ALLOWLIST_EMAILS (unless WAITLIST_ENABLED="false"). */
export function gateOn(env: GateEnv): boolean {
  const flag = String(env.WAITLIST_ENABLED ?? "").trim().toLowerCase();
  if (flag === "false") return false;
  return flag === "true" || parseAllowlist(env.ALLOWLIST_EMAILS).length > 0;
}

/** Is this email (or "user:<id>") in the list? Lists hold lowercase entries. */
export function listed(list: readonly string[], candidates: readonly string[]): boolean {
  const set = new Set(list);
  return candidates.some((c) => set.has(c.trim().toLowerCase()));
}

/** A valid entry for the allowlist: an email, or "user:<account id>". Returns the lowercase entry or null. */
export function cleanAllowEntry(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(s) && s.length <= 254) return s;
  if (/^user:u_[a-z0-9]{4,40}$/.test(s)) return s;
  return null;
}

export const NOTE_MAX = 500;

/** The note of a person: plain text, one block, at most NOTE_MAX characters. */
export function cleanNote(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, NOTE_MAX);
}

/** What a waiting person chose. One record for each person. */
export interface WaitlistEntry {
  id: string;
  userId: string;
  email: string | null;
  name: string;
  /** How the person signed in: "google", "github" or "passkey". */
  provider: string;
  /** The chosen pack. */
  pack: PlanId;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** What the web app needs to know about the gate. Only present when the gate is on. */
export interface WaitlistState {
  gate: true;
  /** The person may use gitring. */
  allowed: boolean;
  /** The choice of the signed-in person. */
  entry: WaitlistEntry | null;
}

export interface WaitlistReport {
  total: number;
  /** Count of choices for each pack. */
  byPack: Record<PlanId, number>;
  /** The sum of the monthly prices of all choices in dollars (planned prices; an Enterprise choice counts its start price). */
  monthlyValueUsd: number;
  /** Every record, with a flag for the people that gitring lets in already. */
  people: (WaitlistEntry & { allowed: boolean })[];
}

export function waitlistReport(entries: readonly (WaitlistEntry & { allowed: boolean })[]): WaitlistReport {
  const byPack = Object.fromEntries(PLAN_IDS.map((id) => [id, 0])) as Record<PlanId, number>;
  let value = 0;
  for (const e of entries) {
    byPack[e.pack] = (byPack[e.pack] ?? 0) + 1;
    value += monthlyValue(e.pack);
  }
  return { total: entries.length, byPack, monthlyValueUsd: value, people: [...entries] };
}

function csvCell(v: string | number | null): string {
  let s = v === null ? "" : String(v);
  // A cell that starts with = + - @ can run as a formula in a spreadsheet: a quote stops that.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The people of the waitlist as CSV (one line each, newest last). */
export function waitlistCsv(entries: readonly (WaitlistEntry & { allowed?: boolean })[]): string {
  const head = ["id", "email", "name", "provider", "pack", "monthly_usd", "note", "allowed", "created", "updated"];
  const rows = entries.map((e) => [
    e.id,
    e.email,
    e.name,
    e.provider,
    e.pack,
    monthlyValue(e.pack),
    e.note,
    e.allowed ? "yes" : "no",
    new Date(e.createdAt).toISOString(),
    new Date(e.updatedAt).toISOString(),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
