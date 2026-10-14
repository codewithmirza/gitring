/**
 * The security and cache headers of the static app (vite.config.ts writes `_headers` at build time): the Content
 * Security Policy lets the app register its service worker and read its web app manifest, and the browser looks
 * for a new service worker on each visit.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { staticHeaders } from "../../vite.config";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** Run the plugin on a small built page; answers the `_headers` file. */
function build(html: string): string {
  dir = mkdtempSync(join(tmpdir(), "gitring-headers-"));
  const plugin = staticHeaders() as unknown as { writeBundle: (o: { dir: string }, b: Record<string, unknown>) => void };
  plugin.writeBundle({ dir }, { "index.html": { type: "asset", source: html } });
  return readFileSync(join(dir, "_headers"), "utf8");
}

describe("the headers of the static app", () => {
  it("let the app use its own service worker and manifest, and nothing from other sites", () => {
    const headers = build("<html><head><script>/* theme */</script></head></html>");
    const csp = /Content-Security-Policy: (.*)/.exec(headers)?.[1] ?? "";
    const rules = new Map(csp.split("; ").map((r) => [r.split(" ")[0], r.split(" ").slice(1)]));
    expect(rules.get("worker-src")).toEqual(["'self'", "blob:"]);
    expect(rules.get("manifest-src")).toEqual(["'self'"]);
    expect(rules.get("script-src")?.[0]).toBe("'self'");
    expect(rules.get("script-src")?.[1]).toMatch(/^'sha256-/);
  });

  it("make the browser look for a new service worker on each visit", () => {
    const headers = build("<html></html>");
    expect(headers).toMatch(/^\/sw\.js\n {2}Cache-Control: no-cache$/m);
  });
});
