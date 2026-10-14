/**
 * The live connection of one project: reconnects with backoff, pings an idle link and closes in a hidden tab.
 * Started by boot.ts. It dispatches every event it hears into the store. Never poll from here.
 */
import { store } from "../store";
import { fetchState } from "./fetch-state";

/* ───────────── timing ───────────── */

/** After this long in a hidden tab the socket closes; it opens again (with a fresh snapshot) when the tab shows. */
const HIDDEN_CLOSE_MS = 5 * 60_000;
/** A visible tab that heard nothing for this long sends a ping; no answer in PONG_WAIT_MS → reconnect. */
const IDLE_PING_MS = 60_000;
const PONG_WAIT_MS = 10_000;
/** After a reconnect the server sends a snapshot. Without one in this time, one state request resyncs. */
const SNAPSHOT_WAIT_MS = 5_000;

/* ───────────── the socket ───────────── */

/**
 * The live connection of one project. It reconnects with backoff (and at once when the network or the
 * tab comes back), checks an idle connection with a ping, and closes while the tab stays hidden.
 */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private tries = 0;
  private opened = false;
  private stopped = false;
  private paused = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private idle: ReturnType<typeof setInterval> | null = null;
  private pong: ReturnType<typeof setTimeout> | null = null;
  private snapWait: ReturnType<typeof setTimeout> | null = null;
  private hide: ReturnType<typeof setTimeout> | null = null;
  private lastHeard = 0;
  private hiddenAt = 0;

  constructor(readonly projectId: string) {}

  start() {
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    this.open();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    this.close();
  }

  private clearTimers() {
    for (const t of [this.retry, this.pong, this.snapWait, this.hide]) if (t) clearTimeout(t);
    if (this.idle) clearInterval(this.idle);
    this.retry = this.pong = this.snapWait = this.hide = null;
    this.idle = null;
  }

  private close() {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000, "closed by the page");
      } catch {
        /* already closing */
      }
    }
  }

  private open() {
    if (this.stopped || this.paused) return;
    this.clearTimers();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      store.setConn("offline", "This device is offline. gitring reconnects when the network is back.");
      return;
    }
    store.setConn(this.opened ? "reconnecting" : "connecting", store.get().error);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(this.projectId)}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    const reconnect = this.opened;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.tries = 0;
      this.opened = true;
      this.lastHeard = Date.now();
      store.setConn("open", null);
      this.idle = setInterval(() => this.checkIdle(), IDLE_PING_MS / 2);
      // The server sends a snapshot on each connect. If none comes after a reconnect, load the state once.
      if (reconnect) this.snapWait = setTimeout(() => void this.resync(), SNAPSHOT_WAIT_MS);
    });
    ws.addEventListener("message", (m: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      if (this.pong) {
        clearTimeout(this.pong);
        this.pong = null;
      }
      const raw = String(m.data);
      if (raw === "pong") return;
      try {
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : [data];
        for (const ev of list) {
          if (!ev || typeof ev.type !== "string") continue;
          if (ev.type === "snapshot" && this.snapWait) {
            clearTimeout(this.snapWait);
            this.snapWait = null;
          }
          store.dispatch(ev);
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped || this.paused) return;
      // The server closed it on purpose: the access changed (4403) or the sign-in ended (4401). A new
      // connection would get the same answer; a full load shows the right page instead.
      if (e.code === 4401 || e.code === 4403) {
        this.stopped = true;
        store.setConn("offline", e.code === 4401 ? "Your sign-in ended. The page loads again." : "Your access to this project changed. The page loads again.");
        setTimeout(() => location.reload(), 1200);
        return;
      }
      this.scheduleRetry();
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* closed */
      }
    });
  }

  private scheduleRetry(now = false) {
    if (this.stopped || this.paused) return;
    this.tries++;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      store.setConn("offline", "This device is offline. gitring reconnects when the network is back.");
      return;
    }
    const delay = now ? 0 : Math.min(15_000, 500 * 2 ** Math.min(this.tries, 5)) * (0.8 + Math.random() * 0.4);
    store.setConn("reconnecting", `The live connection dropped. gitring reconnects in ${Math.max(1, Math.round(delay / 1000))} s.`);
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.open(), delay);
  }

  /** One state request after a gap without a snapshot (an older server, or a lost first frame). */
  private async resync() {
    this.snapWait = null;
    try {
      const { state, access } = await fetchState(this.projectId);
      store.setAccess(access);
      store.dispatch({ type: "snapshot", state });
    } catch {
      /* the socket brings the next change; the connection badge shows problems */
    }
  }

  /** A quiet connection may be dead (sleep, network change): ask the server, and reconnect without an answer. */
  private ping() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.pong) return;
    try {
      ws.send("ping");
    } catch {
      return;
    }
    this.pong = setTimeout(() => {
      this.pong = null;
      if (this.ws !== ws) return;
      this.ws = null;
      try {
        ws.close(4000, "no answer to ping");
      } catch {
        /* closed */
      }
      this.scheduleRetry(true);
    }, PONG_WAIT_MS);
  }

  private checkIdle() {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - this.lastHeard >= IDLE_PING_MS) this.ping();
  }

  private onOnline = () => {
    if (this.ws?.readyState === WebSocket.OPEN) this.ping();
    else {
      this.tries = 0;
      this.scheduleRetry(true);
    }
  };

  private onOffline = () => {
    store.setConn("offline", "This device is offline. gitring reconnects when the network is back.");
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt = Date.now();
      if (this.hide) clearTimeout(this.hide);
      this.hide = setTimeout(() => {
        this.hide = null;
        if (document.visibilityState !== "hidden") return;
        // A hidden tab does not need live events: close, and catch up with one snapshot when it shows again.
        this.paused = true;
        this.close();
      }, HIDDEN_CLOSE_MS);
      return;
    }
    if (this.hide) {
      clearTimeout(this.hide);
      this.hide = null;
    }
    if (this.paused) {
      this.paused = false;
      this.tries = 0;
      this.open();
      return;
    }
    if (!this.ws) {
      this.tries = 0;
      this.scheduleRetry(true);
    } else if (Date.now() - this.hiddenAt > 30_000) this.ping();
  };

  /** Leaving the page: close, so the browser can keep the page in its back/forward cache. */
  private onPageHide = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    this.paused = true;
    this.close();
  };

  private onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted || !this.paused) return;
    this.paused = false;
    this.tries = 0;
    this.open();
  };
}
