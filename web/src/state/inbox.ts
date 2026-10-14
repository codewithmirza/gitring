/**
 * The inbox of the signed-in person: what waits for them in every project where they may act.
 * It reads GET /api/me/inbox, the preference "where do you answer merge questions" (/api/me/prefs), the answers to
 * questions, and push notifications for this device (/api/me/push and the service worker /sw.js).
 *
 * The inbox has no live socket of its own. It loads again every 20 seconds while the page shows, when the page shows again,
 * and soon after the open project changes (its socket brings that news).
 */
import { useSyncExternalStore } from "react";
import type { InboxItem } from "../../../src/core/inbox";
import type { ApprovalsIn, PersonPrefs } from "../../../src/core/accounts";
import type { QuestionResult } from "../../../src/core/types";
import { getJson, HttpError, send } from "./http";
import { store } from "./store";

export type { InboxItem };

/** How often the inbox loads again while the page shows. */
export const INBOX_POLL_MS = 20_000;

interface InboxState {
  items: InboxItem[] | null;
  error: string | null;
  loading: boolean;
}

let snap: InboxState = { items: null, error: null, loading: false };
const listeners = new Set<() => void>();

function set(patch: Partial<InboxState>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The inbox as the page shows it. `items` is null until the first answer. */
export function useInbox(): InboxState {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}

/** How many things wait for the person (0 before the first answer). */
export function useInboxCount(): number {
  return useSyncExternalStore(subscribe, () => snap.items?.length ?? 0, () => 0);
}

let inflight: Promise<void> | null = null;

/** Load the inbox now. Calls that come while a load runs share it. */
export function refreshInbox(): Promise<void> {
  if (inflight) return inflight;
  if (!store.get().me?.user) {
    set({ items: null, error: null, loading: false });
    return Promise.resolve();
  }
  set({ loading: true });
  inflight = getJson<{ items: InboxItem[] }>("/api/me/inbox", { maxAge: 0 })
    .then((res) => set({ items: Array.isArray(res?.items) ? res.items : [], error: null, loading: false }))
    .catch((e: Error) => set({ error: e.message || "gitring did not answer. Try again.", loading: false }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Take an item out at once after an answer (the next load confirms it). */
export function dropInboxItem(key: string) {
  if (snap.items?.some((x) => x.key === key)) set({ items: snap.items.filter((x) => x.key !== key) });
}

let started = false;

/**
 * Keep the inbox fresh while a person is signed in: every 20 s while the page shows, at once when the page
 * shows again, and one second after the open project changes. Call once (App).
 */
export function startInbox(): () => void {
  if (started) return () => undefined;
  started = true;
  let timer = 0;
  let soon = 0;
  let signedIn = Boolean(store.get().me?.user);
  let lastState = store.get().state;
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const tick = () => {
    window.clearTimeout(timer);
    if (signedIn && visible()) void refreshInbox();
    timer = window.setTimeout(tick, INBOX_POLL_MS);
  };
  const onVisible = () => {
    if (visible()) tick();
  };
  const unsubscribe = store.subscribe(() => {
    const s = store.get();
    const nowSignedIn = Boolean(s.me?.user);
    if (nowSignedIn !== signedIn) {
      signedIn = nowSignedIn;
      tick();
      return;
    }
    // The open project changed (an approval, a question, a merge): its socket brings it. Load the inbox soon.
    if (s.state !== lastState) {
      const before = lastState;
      lastState = s.state;
      if (before && s.state && (before.attempts !== s.state.attempts || before.questions !== s.state.questions || before.intents !== s.state.intents)) {
        window.clearTimeout(soon);
        soon = window.setTimeout(() => signedIn && void refreshInbox(), 1000);
      }
    }
  });
  document.addEventListener("visibilitychange", onVisible);
  tick();
  return () => {
    started = false;
    window.clearTimeout(timer);
    window.clearTimeout(soon);
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/* ───────────── words ───────────── */

/** "3 things wait for you." and the like, for the page and the badge. */
export function inboxLede(n: number): string {
  if (n === 0) return "Nothing waits for you.";
  return `${n} ${n === 1 ? "thing waits" : "things wait"} for you.`;
}

/** The badge in the top bar: a number, "99+" for very many. */
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** The project and the age of an item: "shop · 5 min". */
export function itemMeta(item: Pick<InboxItem, "projectName" | "project">, age: string): string {
  return `${item.projectName ?? item.project} · ${age}`;
}

/* ───────────── answers to questions ───────────── */

/**
 * Answer a question (an escalated conflict check, or work that did not merge). A refusal comes back as a
 * result with the reason, not as an error.
 */
export async function answerQuestion(projectId: string, questionId: string, option: string, note?: string): Promise<QuestionResult> {
  const path = `/api/projects/${encodeURIComponent(projectId)}/questions/${encodeURIComponent(questionId)}/answer`;
  try {
    return await send<QuestionResult>("POST", path, { option, ...(note?.trim() ? { note: note.trim() } : {}) });
  } catch (e) {
    if (e instanceof HttpError && e.status === 403 && e.data.outcome === "refused" && typeof e.data.message === "string") return e.data as unknown as QuestionResult;
    throw e;
  }
}

/** A person asks the agent to change some lines of its work (a line comment on a diff). */
export function requestChange(projectId: string, attemptId: string, input: { path: string; from: number; to: number; text: string }): Promise<{ id: string }> {
  return send<{ id: string }>("POST", `/api/projects/${encodeURIComponent(projectId)}/attempts/${encodeURIComponent(attemptId)}/requests`, input);
}

/* ───────────── where the person answers merge questions ───────────── */

export const APPROVALS_IN_TEXT: Record<ApprovalsIn, { label: string; help: string }> = {
  agent: { label: "In the agent's chat", help: "gitring asks you in the chat of the agent, when the agent can show a question. If not, you get a link. You get no push notification for merge questions." },
  app: { label: "In the gitring app", help: "gitring never asks in the chat of an agent. You answer here, in the inbox. No agent can answer for you." },
  both: { label: "In both", help: "gitring asks in the chat of the agent when it can, and the question is also in your inbox here." },
};

export function loadPrefs(): Promise<PersonPrefs> {
  return getJson<PersonPrefs>("/api/me/prefs", { maxAge: 0 });
}

export function savePrefs(patch: Partial<PersonPrefs>): Promise<PersonPrefs> {
  return send<PersonPrefs>("PUT", "/api/me/prefs", patch);
}

/* ───────────── push notifications for this device ───────────── */

export interface PushStatus {
  /** The deployment has push keys. Without them the switch does not show. */
  available: boolean;
  publicKey?: string;
  devices: number;
}

/** The public key (base64url) as the browser wants it. */
export function keyBytes(b64url: string): Uint8Array {
  const pad = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Can this browser get push notifications at all? */
export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function loadPushStatus(): Promise<PushStatus> {
  return getJson<PushStatus>("/api/me/push", { maxAge: 0 });
}

/** The push subscription of this browser, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Turn on push for this device: the browser asks the person, gitring registers the service worker and keeps
 * the push address. Answers a plain sentence when it cannot.
 */
export async function enablePush(publicKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!pushSupported()) return { ok: false, error: "This browser cannot show push notifications." };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, error: "The browser did not allow notifications. Allow them in the settings of the site." };
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
    await send("POST", "/api/me/push", { endpoint: sub.endpoint });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "gitring could not turn on push notifications." };
  }
}

/** Turn off push for this device. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await send("DELETE", "/api/me/push", { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe().catch(() => false);
}
