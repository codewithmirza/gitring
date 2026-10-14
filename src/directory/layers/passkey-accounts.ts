/**
 * Passkey accounts: make an account with a passkey, add one, sign in with one, rename and remove.
 *
 * The WebAuthn checks are in src/directory/passkeys.ts. A person may have passkeys only.
 * One way to sign in always stays: the last passkey of a person without other sign-ins cannot go.
 */
import type * as A from "../../core/accounts";
import { rand } from "../../harbor/ids";
import { randomToken, sha256B64url } from "../crypto";
import { credentialIdOf, PASSKEY_ALGS, PasskeyError, signCountOk, userHandleOf, verifyAssertion, verifyRegistration, type NewPasskey, type PasskeyAlg } from "../passkeys";
import { MAX_PASSKEYS_PER_USER, PASSKEY_STATE_MS } from "../constants";
import type { StateData } from "../types";
import { cleanName, transportsOf } from "../helpers";
import { DirectorySignIn } from "./sign-in";

export abstract class DirectoryPasskeyAccounts extends DirectorySignIn {
  /** A one-time passkey state: null when it is unknown, expired, used, or of another kind. */
  private takePasskeyState(state: string): Extract<StateData, { kind: "passkey" }> | null {
    const row = this.sql.exec<{ data: string; expires_at: number }>("SELECT data, expires_at FROM states WHERE state = ?", String(state ?? "")).toArray()[0];
    if (!row) return null;
    this.sql.exec("DELETE FROM states WHERE state = ?", String(state ?? ""));
    const data = JSON.parse(row.data) as StateData;
    return row.expires_at >= Date.now() && data.kind === "passkey" ? data : null;
  }

  private passkeyRows(userId: string) {
    return this.sql
      .exec<{ id: string; name: string; transports: string | null; created_at: number; last_used: number | null }>("SELECT id, name, transports, created_at, last_used FROM passkeys WHERE user_id = ? ORDER BY created_at", userId)
      .toArray();
  }

  /**
   * Options for navigator.credentials.create(). With `userId` (a signed-in person), the passkey joins
   * that person; else it makes a new account with the display name `name`. `origin` and `rpId` come
   * from the request (the RP id is its host name). Returns the one-time state for the browser cookie.
   */
  async passkeyRegisterOptions(input: { origin: string; rpId: string; name?: string; userId?: string }): Promise<{ state: string; options: A.PasskeyCreationOptions }> {
    let mode: "create" | "add";
    let userId: string;
    let name: string;
    let account: string;
    let exclude: A.PasskeyDescriptor[] = [];
    if (input.userId) {
      const user = this.userInfo(input.userId);
      if (!user) throw new Error("Sign in again, then add the passkey.");
      const rows = this.passkeyRows(user.id);
      if (rows.length >= MAX_PASSKEYS_PER_USER) throw new Error(`You have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.`);
      mode = "add";
      userId = user.id;
      name = user.name;
      account = user.email ?? user.name;
      // The browser makes no second passkey for this account on an authenticator that has one.
      exclude = rows.map((r) => ({ type: "public-key", id: r.id, ...transportsOf(r.transports) }));
    } else {
      name = cleanName(input.name);
      if (!name) throw new Error("Give your name. Other people in your projects see it.");
      mode = "create";
      userId = `u_${rand(10)}`;
      while (this.userInfo(userId)) userId = `u_${rand(10)}`;
      account = name;
    }
    const challenge = randomToken(32);
    const state = this.putState({ kind: "passkey", mode, challenge, origin: input.origin, rpId: input.rpId, userId, name }, PASSKEY_STATE_MS);
    return {
      state,
      options: {
        challenge,
        rp: { id: input.rpId, name: "gitring" },
        user: { id: userHandleOf(userId), name: account, displayName: name },
        pubKeyCredParams: PASSKEY_ALGS.map((alg) => ({ type: "public-key" as const, alg })),
        timeout: PASSKEY_STATE_MS,
        attestation: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
        excludeCredentials: exclude,
      },
    };
  }

  /**
   * Check the browser's new passkey and keep it. A new account opens a session (`token`); a passkey that
   * a signed-in person added opens none. `userId` is the person who is signed in now (or none), `label`
   * the name that the browser suggests for the passkey.
   */
  async passkeyRegister(state: string, credential: unknown, opts: { origin: string; userId?: string; label?: string }): Promise<{ token: string | null; user: A.UserInfo; passkey: A.PasskeyInfo }> {
    const st = this.takePasskeyState(state);
    if (!st || st.mode === "login" || !st.userId) throw new Error("The passkey request expired or was used already. Start again.");
    if (st.origin !== opts.origin) throw new Error("The passkey request is for another site. Start again.");
    if (st.mode === "add" && st.userId !== opts.userId) throw new Error("Sign in again, then add the passkey.");
    let pk: NewPasskey;
    try {
      pk = await verifyRegistration(credential, { challenge: st.challenge, origin: st.origin, rpId: st.rpId });
    } catch (e) {
      throw new Error(e instanceof PasskeyError ? e.message : "gitring could not read the passkey. Try again.");
    }
    if (this.sql.exec("SELECT id FROM passkeys WHERE id = ?", pk.id).toArray()[0]) throw new Error("gitring has this passkey already. Sign in with it.");
    const userId = st.userId;
    const now = Date.now();
    if (st.mode === "create") {
      if (this.userInfo(userId)) throw new Error("The passkey request was used already. Start again.");
      this.sql.exec("INSERT INTO users (id, name, email, avatar, created_at, last_seen) VALUES (?, ?, NULL, NULL, ?, ?)", userId, st.name || "gitring user", now, now);
    } else if (!this.userInfo(userId)) {
      throw new Error("Sign in again, then add the passkey.");
    } else if (this.passkeyRows(userId).length >= MAX_PASSKEYS_PER_USER) {
      throw new Error(`You have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.`);
    }
    const name = cleanName(opts.label) || "Passkey";
    const lastUsed = st.mode === "create" ? now : null;
    this.sql.exec(
      "INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, transports, name, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      pk.id,
      userId,
      JSON.stringify(pk.jwk),
      pk.alg,
      pk.signCount,
      pk.transports.length ? JSON.stringify(pk.transports) : null,
      name,
      now,
      lastUsed,
    );
    const token = st.mode === "create" ? await this.openSession(userId) : null;
    return { token, user: this.userInfo(userId)!, passkey: { id: pk.id, name, createdAt: now, ...(lastUsed ? { lastUsed } : {}) } };
  }

  /**
   * Options for navigator.credentials.get(). allowCredentials stays empty: every gitring passkey is a
   * discoverable credential, so the browser offers the passkeys that it has for this site. (A typed
   * name would also tell anyone which names have an account.)
   */
  async passkeyLoginOptions(input: { origin: string; rpId: string }): Promise<{ state: string; options: A.PasskeyRequestOptions }> {
    const challenge = randomToken(32);
    const state = this.putState({ kind: "passkey", mode: "login", challenge, origin: input.origin, rpId: input.rpId }, PASSKEY_STATE_MS);
    return { state, options: { challenge, rpId: input.rpId, timeout: PASSKEY_STATE_MS, userVerification: "preferred", allowCredentials: [] } };
  }

  /** Check a passkey sign-in and open the same session as other sign-ins. */
  async passkeyLogin(state: string, credential: unknown, opts: { origin: string }): Promise<{ token: string; user: A.UserInfo }> {
    const st = this.takePasskeyState(state);
    if (!st || st.mode !== "login") throw new Error("The passkey sign-in expired or was used already. Start again.");
    if (st.origin !== opts.origin) throw new Error("The passkey sign-in is for another site. Start again.");
    let id: string;
    try {
      id = credentialIdOf(credential);
    } catch (e) {
      throw new Error((e as Error).message);
    }
    const unknown = "gitring does not know this passkey. Use another passkey, or create an account.";
    const row = this.sql
      .exec<{ user_id: string; public_key: string; alg: number; sign_count: number }>("SELECT user_id, public_key, alg, sign_count FROM passkeys WHERE id = ?", id)
      .toArray()[0];
    if (!row) throw new Error(unknown);
    let res: { signCount: number; userHandle: string | null };
    try {
      res = await verifyAssertion(credential, { challenge: st.challenge, origin: st.origin, rpId: st.rpId }, { jwk: JSON.parse(row.public_key) as JsonWebKey, alg: row.alg as PasskeyAlg, signCount: row.sign_count });
    } catch (e) {
      throw new Error(e instanceof PasskeyError ? e.message : "gitring could not read the passkey. Try again.");
    }
    if (res.userHandle && res.userHandle !== userHandleOf(row.user_id)) throw new Error("The passkey does not belong to this account. gitring did not sign you in.");
    // Another sign-in with this passkey can finish during the check, and the person can remove the
    // passkey: read the row again (no await from here to the update, so the two steps are one).
    const current = this.sql.exec<{ user_id: string; public_key: string; sign_count: number }>("SELECT user_id, public_key, sign_count FROM passkeys WHERE id = ?", id).toArray()[0];
    if (!current || current.user_id !== row.user_id || current.public_key !== row.public_key) throw new Error(unknown);
    if (!signCountOk(current.sign_count, res.signCount)) throw new Error("The passkey counter went back. This can mean a copy of the passkey. gitring did not sign you in.");
    const now = Date.now();
    this.sql.exec("UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?", res.signCount, now, id);
    this.sql.exec("UPDATE users SET last_seen = ? WHERE id = ?", now, row.user_id);
    const user = this.userInfo(row.user_id);
    if (!user) throw new Error(unknown);
    return { token: await this.openSession(row.user_id), user };
  }

  async listPasskeys(userId: string): Promise<A.PasskeyInfo[]> {
    return this.passkeyRows(userId).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, ...(r.last_used ? { lastUsed: r.last_used } : {}) }));
  }

  async renamePasskey(userId: string, id: string, name: string): Promise<A.PasskeyInfo> {
    const clean = cleanName(name);
    if (!clean) throw new Error("Give the passkey a name.");
    this.sql.exec("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?", clean, id, userId);
    const found = (await this.listPasskeys(userId)).find((p) => p.id === id);
    if (!found) throw new Error("You have no passkey with this id.");
    return found;
  }

  /** Remove a passkey. One way to sign in always stays: a person without identities keeps one passkey. */
  async removePasskey(userId: string, id: string, keepToken?: string): Promise<void> {
    const rows = this.passkeyRows(userId);
    if (!rows.some((r) => r.id === id)) throw new Error("You have no passkey with this id.");
    const identities = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM identities WHERE user_id = ?", userId).one().n;
    if (rows.length === 1 && identities === 0) throw new Error("This passkey is your only way to sign in. Add another passkey or sign-in first.");
    this.sql.exec("DELETE FROM passkeys WHERE id = ? AND user_id = ?", id, userId);
    // A lost or stolen device may hold a session: end the sessions of this person, except the one that removes the passkey.
    if (keepToken) this.sql.exec("DELETE FROM sessions WHERE user_id = ? AND hash <> ?", userId, await sha256B64url(keepToken));
    else this.sql.exec("DELETE FROM sessions WHERE user_id = ?", userId);
  }
}
