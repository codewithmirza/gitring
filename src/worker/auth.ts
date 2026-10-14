/**
 * The front door of sign-in: it re-exports the caller lookup and the page helpers, and mounts the auth routes.
 *
 * The files behind it: principal.ts (the caller), pages.ts and sign-in-page.ts (server pages), auth-kit.ts (cookies).
 * The routes are in passkey-routes.ts, setup-routes.ts and sign-in-routes.ts. Other files import from here.
 * The ORDER of the three route calls is the order of the routes.
 */
import type { Hono } from "hono";
import type { HonoEnv } from "./http";
import { passkeyRoutes } from "./passkey-routes";
import { setupRoutes } from "./setup-routes";
import { signInRoutes } from "./sign-in-routes";

export { SESSION_COOKIE, readCookie } from "./auth-kit";
export { actorOf, closeUserSockets, directory, forgetPrincipal, resolvePrincipal, type Principal } from "./principal";
export { esc, page, type PageOptions } from "./pages";
export { lastProvider, providerButtons, signInChoices } from "./sign-in-page";

export function authRoutes(app: Hono<HonoEnv>): void {
  passkeyRoutes(app);
  setupRoutes(app);
  signInRoutes(app);
}
