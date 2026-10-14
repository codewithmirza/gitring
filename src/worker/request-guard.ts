/**
 * The first middleware of the app: it limits requests, finds the caller and sets safe default headers.
 *
 * Called once by app.ts, before any route. It runs for every path that the app answers.
 * Never answer a route here. Never skip the credential limit: keys that are not valid are not cached.
 * Read next: src/worker/principal.ts (who is calling), src/worker/limits.ts and src/worker/gate.ts.
 */
import type { Hono } from "hono";
import { resolvePrincipal } from "./auth";
import { gateBlock } from "./gate";
import { isCrossSiteWrite } from "./csrf";
import { clientAddress, hasCredential, hookLimitKey, hookUrlKey, limitFor, overLimit, tooMany } from "./limits";
import type { HonoEnv } from "./http";

export function useRequestGuard(app: Hono<HonoEnv>): void {
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const kind = limitFor(c.req.method, path);
    // Sign-in and OAuth endpoints, and live previews, are limited per address before any lookup.
    if ((kind === "auth" || kind === "token" || kind === "preview") && (await overLimit(c.env, kind, clientAddress(c.req.raw)))) return tooMany(60, kind === "token");
    // Credential lookups are limited per address before the lookup, on every route: keys and cookies that are
    // not valid are never cached, so a flood of them must stop here and not at the account store. The key in
    // a hook URL is a credential too (gitring compares it with the project's key).
    if ((hasCredential(c.req.raw) || (kind === "hook" && hookUrlKey(c.req.raw))) && (await overLimit(c.env, "cred", clientAddress(c.req.raw)))) return tooMany();
    const p = await resolvePrincipal(c.env, c.req.raw);
    if (p.badKey) return c.json({ error: "The API key is not valid. Create a new key in gitring (Account → API keys)." }, 401);
    c.set("principal", p);
    // The waitlist gate: a person who is not allowed reaches the waitlist pages only (src/worker/gate.ts).
    const stopped = gateBlock(c.env, p, path);
    if (stopped) return stopped;
    const who = p.user?.id ?? (p.via === "operator" ? "operator" : null);
    if (kind === "api" && (await overLimit(c.env, "api", who ?? clientAddress(c.req.raw)))) return tooMany();
    if (kind === "hook" && (await overLimit(c.env, "hook", await hookLimitKey(c.req.raw, who)))) return tooMany();
    // A browser session may only change state from gitring's own pages (no cross-site requests).
    if (p.via === "session" && isCrossSiteWrite(c.req.method, c.req.header("origin"), c.req.header("sec-fetch-site"), new URL(c.req.url).origin)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    await next();
    // Defaults for every Worker answer (pages set stricter ones themselves). Answers that came from
    // another object (WebSocket upgrades, previews) have fixed headers: leave them.
    if (c.res.status === 101) return;
    try {
      const h = c.res.headers;
      if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
      if (!h.has("referrer-policy")) h.set("referrer-policy", "strict-origin-when-cross-origin");
      if (path.startsWith("/api/") && !h.has("cache-control")) h.set("cache-control", "private, no-store");
    } catch {
      /* immutable headers */
    }
  });
}
