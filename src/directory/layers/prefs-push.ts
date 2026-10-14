/**
 * Preferences of a person, and the devices that get push notifications for the inbox.
 *
 * A push has no text: the browser opens the inbox when it arrives.
 * Read next: src/worker/push.ts (how a push is sent).
 */
import type * as A from "../../core/accounts";
import { APPROVALS_IN, atLeast, cleanPrefs } from "../../core/accounts";
import { pushEndpointOk, pushKeys, sendPush } from "../../worker/push";
import { MAX_PUSH_DEVICES, PUSH_GAP_MS } from "../constants";
import { DirectoryProjects } from "./projects";

export abstract class DirectoryPrefsPush extends DirectoryProjects {
  /** The preferences of a person (contract C3). A person who never set one has the defaults. */
  async prefs(userId: string): Promise<A.PersonPrefs> {
    const row = this.sql.exec<{ data: string }>("SELECT data FROM prefs WHERE user_id = ?", userId).toArray()[0];
    return cleanPrefs(row ? JSON.parse(row.data) : undefined);
  }

  /** Change some preferences. A value that is not known is refused: the person must see that nothing changed. */
  async setPrefs(userId: string, patch: Partial<A.PersonPrefs>): Promise<A.PersonPrefs> {
    if (!this.userInfo(userId)) throw new Error("Unknown user.");
    const now = await this.prefs(userId);
    if (patch.approvalsIn !== undefined && !APPROVALS_IN.includes(patch.approvalsIn)) throw new Error('Give approvalsIn: "agent", "app" or "both".');
    const next = cleanPrefs({ ...now, ...patch });
    this.sql.exec("INSERT OR REPLACE INTO prefs (user_id, data) VALUES (?, ?)", userId, JSON.stringify(next));
    return next;
  }

  /** Push for this person: is it on for the deployment, the public key for the browser, and how many devices get it. */
  async pushStatus(userId: string): Promise<{ available: boolean; publicKey?: string; devices: number }> {
    const keys = pushKeys(this.env);
    const devices = this.pushDevices(userId);
    return keys ? { available: true, publicKey: keys.publicKey, devices } : { available: false, devices };
  }

  private pushDevices(userId: string): number {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM push_subs WHERE user_id = ?", userId).one().n;
  }

  /** A device of this person gets push notifications. The address belongs to one person: a new person takes it over. */
  async pushSubscribe(userId: string, endpoint: string): Promise<{ devices: number }> {
    if (!this.userInfo(userId)) throw new Error("Unknown user.");
    if (!pushKeys(this.env)) throw new Error("Push notifications are off on this gitring.");
    if (!pushEndpointOk(endpoint)) throw new Error("This push address is not valid. Use the address that the browser gives.");
    this.sql.exec("INSERT OR REPLACE INTO push_subs (endpoint, user_id, created_at) VALUES (?, ?, ?)", endpoint, userId, Date.now());
    const extra = this.sql.exec<{ endpoint: string }>("SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?", userId, MAX_PUSH_DEVICES).toArray();
    for (const e of extra) this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", e.endpoint);
    return { devices: this.pushDevices(userId) };
  }

  /** The device stops: no more push notifications to it. Without an address, every device of the person stops. */
  async pushUnsubscribe(userId: string, endpoint?: string): Promise<{ devices: number }> {
    if (endpoint) this.sql.exec("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?", endpoint, userId);
    else this.sql.exec("DELETE FROM push_subs WHERE user_id = ?", userId);
    return { devices: this.pushDevices(userId) };
  }

  /** When each person got the last push (in this instance): see PUSH_GAP_MS. */
  private readonly lastPush = new Map<string, number>();

  /**
   * Something new waits in the inbox of people of a project: send an empty push to their devices. `users`: the
   * people who answer (the senders); empty: every person of the project with the role `need` or higher. A person
   * who answers merge questions only in the chat of the agent (approvalsIn "agent") gets no push for a merge
   * question. Answers how many pushes went out.
   */
  async pushInbox(projectId: string, target: { users: string[]; need: "owner" | "member"; kind: "approval" | "question" }): Promise<number> {
    const keys = pushKeys(this.env);
    const row = this.projectRow(projectId);
    if (!keys || !row) return 0;
    const people = target.users.length
      ? target.users.filter((u) => atLeast(this.roleIn(row, u), "member"))
      : this.sql
          .exec<{ user_id: string; role: A.Role }>("SELECT user_id, role FROM members WHERE project_id = ? AND user_id IS NOT NULL", projectId)
          .toArray()
          .filter((m) => atLeast(m.role, target.need))
          .map((m) => m.user_id);
    const now = Date.now();
    let sent = 0;
    for (const userId of new Set(people)) {
      if (target.kind === "approval" && (await this.prefs(userId)).approvalsIn === "agent") continue;
      if (now - (this.lastPush.get(userId) ?? 0) < PUSH_GAP_MS) continue;
      const subs = this.sql.exec<{ endpoint: string }>("SELECT endpoint FROM push_subs WHERE user_id = ?", userId).toArray();
      if (!subs.length) continue;
      this.lastPush.set(userId, now);
      for (const sub of subs) {
        const r = await sendPush(keys, sub.endpoint);
        if (r === "gone") this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", sub.endpoint);
        if (r === "sent") sent += 1;
      }
    }
    if (this.lastPush.size > 5000) this.lastPush.clear();
    return sent;
  }
}
