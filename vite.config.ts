import { createHash } from "node:crypto";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * Security and cache headers for the static app (Workers Static Assets reads `_headers`). The Content
 * Security Policy allows the inline scripts of the built index.html by their SHA-256 hashes, so the
 * policy stays right when index.html changes.
 */
export function staticHeaders(): Plugin {
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
        // The service worker (/sw.js, push notifications) and the web app manifest come from this site only.
        "worker-src 'self' blob:",
        "manifest-src 'self'",
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
        // The browser checks the service worker for a new version on each visit.
        "/sw.js",
        "  Cache-Control: no-cache",
        "",
      ].join("\n");
      writeFileSync(join(options.dir, "_headers"), headers);
    },
  };
}

/**
 * The product video and its poster live in web/public/media (the landing page of the waitlist reads
 * /media/gitring-product.mp4). The build copies the folder into the static assets, next to public/.
 */
export function copyMedia(): Plugin {
  return {
    name: "gitring-copy-media",
    apply: "build",
    writeBundle(options, bundle) {
      if (!bundle["index.html"] || !options.dir || !existsSync("web/public/media")) return;
      cpSync("web/public/media", join(options.dir, "media"), { recursive: true });
    },
  };
}

export default defineConfig({
  root: ".",
  plugins: [react(), cloudflare(), staticHeaders(), copyMedia()],
  build: { outDir: "dist" },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            // React changes far less often than the app: in a chunk of its own, the browser keeps it across deploys.
            // Views are lazy chunks; the overview map (with d3-hierarchy) is a lazy chunk of the overview.
            codeSplitting: {
              groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 10 }],
            },
          },
        },
      },
    },
  },
});
