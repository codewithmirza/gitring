/**
 * Live preview of an attempt: the attempt's app runs in a Dynamic Worker (Worker Loader).
 *
 * The page is served under a path prefix (basePath), for example /preview/my-project/a_123/. servePreview
 * strips the prefix, keeps the query, forwards the request to the app's default export, and marks
 * the response with "x-gitring-preview: <key>". The app has no network (globalOutbound: null).
 * Apps must use relative links, so that they work under the prefix.
 */
import { isModulePath, toLoaderModules } from "./runner";

export interface PreviewOptions {
  /** Time budget for one request to the app. Default 10000 ms. */
  timeoutMs?: number;
  /**
   * Serve the app with "Content-Security-Policy: sandbox …", so that its scripts run in an opaque
   * origin and cannot use the cookies or storage of the gitring origin. Default false: in a sandbox,
   * localStorage throws and the parent page cannot read the frame location.
   */
  sandbox?: boolean;
}

export const PREVIEW_COMPATIBILITY_DATE = "2026-10-01";
export const PREVIEW_MAIN_MODULE = "src/index.js";
export const PREVIEW_HEADER = "x-gitring-preview";

const DEFAULT_TIMEOUT_MS = 10_000;
const PREVIEW_CPU_MS = 5_000;
/** Credentials of the gitring origin never go to agent code. */
const STRIPPED_REQUEST_HEADERS = ["cookie", "authorization"];
const SANDBOX_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** Modules of the app: every .js/.mjs file, main module src/index.js. null if there is no src/index.js. */
export function previewModules(files: Map<string, string>): { mainModule: string; modules: Record<string, string> } | null {
  if (!files.has(PREVIEW_MAIN_MODULE)) return null;
  const modules: Record<string, string> = {};
  for (const [path, content] of files) {
    if (isModulePath(path)) modules[path] = content;
  }
  return { mainModule: PREVIEW_MAIN_MODULE, modules };
}

/**
 * Serve one request of a preview. `key` must identify the content of `files` (the loader caches the
 * app as `app:<key>`). `basePath` is the prefix to strip, with or without a trailing slash.
 */
export async function servePreview(
  loader: WorkerLoader,
  key: string,
  files: Map<string, string>,
  request: Request,
  basePath: string,
  opts: PreviewOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const base = normalizeBase(basePath);
  // Relative links need the trailing slash: /preview/p/a → /preview/p/a/
  if (base && url.pathname === base) return redirect(`${base}/${url.search}`, key);

  const code = previewModules(files);
  if (!code) {
    return errorPage(404, key, {
      title: "This attempt has no app to preview.",
      hint: `Add a fetch handler in ${PREVIEW_MAIN_MODULE}. Then reload the preview.`,
    });
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const forwarded = await forwardRequest(request, url, base);
    const stub = loader.get(`app:${key}`, () => ({
      compatibilityDate: PREVIEW_COMPATIBILITY_DATE,
      mainModule: code.mainModule,
      modules: toLoaderModules(code.modules),
      globalOutbound: null,
      limits: { cpuMs: PREVIEW_CPU_MS },
    }));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PreviewTimeout(timeoutMs)), timeoutMs);
    });
    const res = await Promise.race([stub.getEntrypoint().fetch(forwarded), timeout]);
    return decorate(res, key, base, opts.sandbox === true);
  } catch (err) {
    if (err instanceof PreviewTimeout) {
      return errorPage(504, key, {
        title: "The preview did not answer in time.",
        detail: err.message,
        hint: "Look for a request that never ends in the app. Then reload the preview.",
      });
    }
    return errorPage(500, key, {
      title: "The preview did not start.",
      detail: errorText(err),
      hint: "The code of this attempt threw an error. Fix the error. Then reload the preview.",
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────────────────── internals ───────────────────────────── */

class PreviewTimeout extends Error {
  constructor(ms: number) {
    super(`No response in ${ms} ms.`);
    this.name = "PreviewTimeout";
  }
}

function normalizeBase(basePath: string): string {
  let base = basePath.trim();
  if (!base || base === "/") return "";
  if (!base.startsWith("/")) base = `/${base}`;
  return base.replace(/\/+$/, "");
}

function stripBase(pathname: string, base: string): string {
  if (base && pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return pathname || "/";
}

async function forwardRequest(request: Request, url: URL, base: string): Promise<Request> {
  const target = new URL(stripBase(url.pathname, base) + url.search, url.origin);
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
  return new Request(target.toString(), init);
}

/**
 * Response headers that agent code may set. Previews share the gitring origin, so every other header
 * goes: Set-Cookie could replace a person's session, Clear-Site-Data could sign them out, Refresh and
 * outside redirects could send them elsewhere.
 */
const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-language",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "vary",
  "location",
  "x-content-type-options",
]);

function decorate(res: Response, key: string, base: string, sandbox: boolean): Response {
  if (res.status === 101) return res; // WebSocket upgrade: pass through untouched.
  const headers = new Headers();
  for (const [name, value] of res.headers) if (ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  out.headers.set(PREVIEW_HEADER, key);
  const location = out.headers.get("location");
  if (location) {
    // Only same-site paths: a preview cannot send people to other sites from the gitring origin.
    if (location.startsWith("/") && !location.startsWith("//") && !location.startsWith("/\\")) out.headers.set("location", base + location);
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(location) && !location.startsWith("//")) out.headers.set("location", location);
    else out.headers.delete("location");
  }
  if (sandbox) out.headers.append("content-security-policy", SANDBOX_POLICY);
  return out;
}

function redirect(location: string, key: string): Response {
  return new Response(null, { status: 302, headers: { location, [PREVIEW_HEADER]: key, "cache-control": "no-store" } });
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? `${err.message}` : String(err);
  const text = raw.replace(/^Failed to start Worker:\s*/i, "").trim() || "Unknown error.";
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function errorPage(status: number, key: string, msg: { title: string; detail?: string; hint: string }): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview: ${escapeHtml(msg.title)}</title>
<style>
:root { color-scheme: light dark; --bg: oklch(98.6% .004 230); --surface: oklch(96.6% .006 232); --line: oklch(86% .012 236); --ink: oklch(24% .026 256); --ink-2: oklch(39% .022 252); --danger: oklch(53% .19 29); }
@media (prefers-color-scheme: dark) { :root { --bg: oklch(16.5% .018 252); --surface: oklch(20% .02 252); --line: oklch(31% .022 252); --ink: oklch(92% .008 236); --ink-2: oklch(80% .014 240); --danger: oklch(70% .15 29); } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.5 "Atkinson Hyperlegible Next", system-ui, sans-serif; }
main { box-sizing: border-box; width: min(640px, calc(100% - 32px)); padding: 20px 24px; border: 1px solid var(--line); border-left: 3px solid var(--danger); border-radius: 6px; background: var(--surface); }
h1 { margin: 0 0 8px; font-size: 20px; font-weight: 500; }
h1 span { color: var(--danger); }
p { margin: 0 0 12px; color: var(--ink-2); }
pre { margin: 0 0 12px; padding: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--ink); font: 13px/1.5 "Atkinson Hyperlegible Mono", ui-monospace, monospace; }
.meta { margin: 0; font: 12px/1.4 "Atkinson Hyperlegible Mono", ui-monospace, monospace; }
</style>
</head>
<body>
<main>
<h1><span aria-hidden="true">✕</span> ${escapeHtml(msg.title)}</h1>
<p>${escapeHtml(msg.hint)}</p>
${msg.detail ? `<pre>${escapeHtml(msg.detail)}</pre>` : ""}
<p class="meta">Status ${status} · preview ${escapeHtml(key)}</p>
</main>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      [PREVIEW_HEADER]: key,
    },
  });
}
