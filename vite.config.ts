import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * Security and cache headers for the static app (Workers Static Assets reads `_headers`). The Content
 * Security Policy allows the inline scripts of the built index.html by their SHA-256 hashes, so the
 * policy stays right when index.html changes.
 */
function staticHeaders(): Plugin {
  return {
    name: "gitring-static-headers",
    apply: "build",
    writeBundle(options, bundle) {
      const page = bundle["index.html"];
      if (!page || page.type !== "asset" || !options.dir) return;
      const html = String(page.source);
      const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .filter((code) => code.trim())
        .map((code) => `'sha256-${createHash("sha256").update(code).digest("base64")}'`);
      const csp = [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(" ")}`.trim(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://avatars.githubusercontent.com https://*.googleusercontent.com",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; ");
      const headers = [
        "/*",
        `  Content-Security-Policy: ${csp}`,
        "  X-Content-Type-Options: nosniff",
        "  Referrer-Policy: strict-origin-when-cross-origin",
        "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        "  Cross-Origin-Opener-Policy: same-origin",
        "  X-Frame-Options: DENY",
        "/assets/*",
        "  Cache-Control: public, max-age=31536000, immutable",
        "",
      ].join("\n");
      writeFileSync(join(options.dir, "_headers"), headers);
    },
  };
}

export default defineConfig({
  root: ".",
  plugins: [react(), cloudflare(), staticHeaders()],
  build: { outDir: "dist" },
});
