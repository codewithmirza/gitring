/**
 * People: who is an owner of the deployment, the profile of a person, the waitlist gate and the allow list.
 *
 * A login in GITRING_OWNERS stays with the account that used it first (ownerPinOk).
 * Read next: src/core/waitlist.ts (when the gate is on).
 */
import type * as A from "../../core/accounts";
import { rand } from "../../harbor/ids";
import { cleanAllowEntry, cleanNote, gateOn, listed, parseAllowlist, waitlistReport, type WaitlistEntry, type WaitlistReport, type WaitlistState } from "../../core/waitlist";
import { isPlanId, type PlanId } from "../../core/plans";
import type { UserRow, WaitlistRow } from "../types";
import { DirectoryMeters } from "./meters";

export abstract class DirectoryPeople extends DirectoryMeters {
  // ───── Owners and the profile of a person ─────

  private owners(): string[] {
    return (this.env.GITRING_OWNERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * An owner of the deployment (GITRING_OWNERS): "user:<account id>" (any person, also one with
   * passkeys only), "github:<login>", "github-id:<number>", "google:<email>" or a bare email. A login
   * matches only the account that matched it first: when an owner renames their GitHub account, GitHub
   * releases the old login, and whoever registers it later does not become an owner.
   */
  protected isAdmin(userId: string): boolean {
    const owners = this.owners();
    if (!owners.length) return false;
    // Account ids never change hands: no pin needed.
    if (owners.includes(`user:${userId.toLowerCase()}`)) return true;
    for (const i of this.sql.exec<{ provider: string; subject: string; login: string | null; email: string | null }>("SELECT provider, subject, login, email FROM identities WHERE user_id = ?", userId).toArray()) {
      if (owners.includes(`${i.provider}-id:${String(i.subject).toLowerCase()}`)) return true;
      const handle = i.login ? `${i.provider}:${i.login.toLowerCase()}` : null;
      if (handle && owners.includes(handle) && this.ownerPinOk(handle, i.provider, i.subject)) return true;
      if (i.email && (owners.includes(`${i.provider}:${i.email.toLowerCase()}`) || owners.includes(i.email.toLowerCase()))) return true;
    }
    return false;
  }

  private ownerPinOk(handle: string, provider: string, subject: string): boolean {
    const pin = this.sql.exec<{ provider: string; subject: string }>("SELECT provider, subject FROM owner_pins WHERE handle = ?", handle).toArray()[0];
    if (!pin) {
      this.sql.exec("INSERT OR IGNORE INTO owner_pins (handle, provider, subject, pinned_at) VALUES (?, ?, ?, ?)", handle, provider, String(subject), Date.now());
      return true;
    }
    return pin.provider === provider && pin.subject === String(subject);
  }

  protected userInfo(userId: string): A.UserInfo | null {
    const u = this.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", userId).toArray()[0];
    if (!u) return null;
    const identities = this.sql
      .exec<{ provider: A.Provider; login: string | null; email: string | null }>("SELECT provider, login, email FROM identities WHERE user_id = ?", userId)
      .toArray()
      .map((i) => ({ provider: i.provider, login: i.login ?? undefined, email: i.email ?? undefined }));
    const passkeys = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", userId).one().n;
    const admin = this.isAdmin(u.id);
    return { id: u.id, name: u.name, email: u.email ?? undefined, avatar: u.avatar ?? undefined, identities, passkeys, admin, allowed: this.allowedFor(u.id, admin) };
  }

  // ───── The waitlist gate ─────

  /** The emails of a person (the account and every sign-in), lowercase. Providers send verified emails only. */
  private emailsOf(userId: string): string[] {
    const own = this.sql.exec<{ email: string | null }>("SELECT email FROM users WHERE id = ?", userId).toArray()[0]?.email;
    const rest = this.sql.exec<{ email: string | null }>("SELECT email FROM identities WHERE user_id = ?", userId).toArray().map((r) => r.email);
    return [...new Set([own, ...rest].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))];
  }

  /**
   * May this person use gitring? Always, when the deployment has no gate. With a gate: owners, people with
   * a verified email in ALLOWLIST_EMAILS, and people that an owner let in (an email or "user:<account id>").
   */
  private allowedFor(userId: string, admin = this.isAdmin(userId)): boolean {
    if (!gateOn(this.env)) return true;
    if (admin) return true;
    const entries = [...this.emailsOf(userId), `user:${userId.toLowerCase()}`];
    if (listed(parseAllowlist(this.env.ALLOWLIST_EMAILS), entries)) return true;
    return entries.some((e) => this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM allowed WHERE entry = ?", e).one().n > 0);
  }

  private entryRow(r: WaitlistRow): WaitlistEntry {
    return { id: r.id, userId: r.user_id, email: r.email, name: r.name, provider: r.provider, pack: (isPlanId(r.pack) ? r.pack : "explorer") as PlanId, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  /** The gate for the web app: absent without a gate. A visitor (no person) is not allowed. */
  waitlistState(userId: string | null): WaitlistState | undefined {
    if (!gateOn(this.env)) return undefined;
    const row = userId ? this.sql.exec<WaitlistRow>("SELECT * FROM waitlist WHERE user_id = ?", userId).toArray()[0] : undefined;
    return { gate: true, allowed: userId ? this.allowedFor(userId) : false, entry: row ? this.entryRow(row) : null };
  }

  /** Keep the choice of a person (a new record, or a change of the old one). */
  waitlistSet(userId: string, pack: unknown, note: unknown): WaitlistEntry {
    if (!isPlanId(pack)) throw new Error("Pick one of the packs.");
    const u = this.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", userId).toArray()[0];
    if (!u) throw new Error("Unknown user.");
    const email = this.emailsOf(userId)[0] ?? null;
    const provider = this.sql.exec<{ provider: string }>("SELECT provider FROM identities WHERE user_id = ? ORDER BY rowid DESC LIMIT 1", userId).toArray()[0]?.provider ?? "passkey";
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO waitlist (id, user_id, email, name, provider, pack, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, name = excluded.name, provider = excluded.provider, pack = excluded.pack, note = excluded.note, updated_at = excluded.updated_at",
      `w_${rand(10)}`,
      userId,
      email,
      u.name,
      provider,
      pack,
      cleanNote(note),
      now,
      now,
    );
    return this.entryRow(this.sql.exec<WaitlistRow>("SELECT * FROM waitlist WHERE user_id = ?", userId).one());
  }

  /** A person takes their interest back: the record goes. */
  waitlistRemove(userId: string): boolean {
    const had = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM waitlist WHERE user_id = ?", userId).one().n > 0;
    this.sql.exec("DELETE FROM waitlist WHERE user_id = ?", userId);
    return had;
  }

  /** Every record, counts for each pack and the monthly value of the choices (for the owner). */
  waitlistAdmin(): WaitlistReport {
    const rows = this.sql.exec<WaitlistRow>("SELECT * FROM waitlist ORDER BY created_at ASC").toArray();
    return waitlistReport(rows.map((r) => ({ ...this.entryRow(r), allowed: this.allowedFor(r.user_id) })));
  }

  // ───── The allow list ─────

  /** The people that an owner let in (the secret ALLOWLIST_EMAILS is separate and not listed here). */
  allowedList(): { entry: string; addedBy: string | null; addedAt: number }[] {
    return this.sql
      .exec<{ entry: string; added_by: string | null; added_at: number }>("SELECT entry, added_by, added_at FROM allowed ORDER BY added_at ASC")
      .toArray()
      .map((r) => ({ entry: r.entry, addedBy: r.added_by, addedAt: r.added_at }));
  }

  allowedAdd(raw: unknown, by: string | null): string {
    const entry = cleanAllowEntry(raw);
    if (!entry) throw new Error("Give an email address, or an account id like user:u_0123456789.");
    const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM allowed").one().n;
    if (n >= 2000) throw new Error("The list has 2,000 people. Remove some first.");
    this.sql.exec("INSERT OR IGNORE INTO allowed (entry, added_by, added_at) VALUES (?, ?, ?)", entry, by, Date.now());
    return entry;
  }

  allowedRemove(raw: unknown): boolean {
    const entry = cleanAllowEntry(raw);
    if (!entry) return false;
    const had = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM allowed WHERE entry = ?", entry).one().n > 0;
    this.sql.exec("DELETE FROM allowed WHERE entry = ?", entry);
    return had;
  }
}
