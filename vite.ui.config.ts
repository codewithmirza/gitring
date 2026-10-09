/**
 * UI-only dev config for the Bearing web app (owner: web UI).
 *
 *   npx vite --config vite.ui.config.ts --port 5182 --host 127.0.0.1
 *
 * The UI talks to a running Bearing Worker. Set BEARING_API to its origin (local or deployed):
 *
 *   BEARING_API=http://127.0.0.1:8787 npx vite --config vite.ui.config.ts
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.BEARING_API;

export default defineConfig({
  root: ".",
  plugins: [react()],
  // web/public holds the favicon; index.html references it by path, so it builds with any config.
  publicDir: false,
  cacheDir: "node_modules/.vite-ui",
  server: {
    port: 5182,
    strictPort: true,
    host: "127.0.0.1",
    proxy: api
      ? {
          "/api": api,
          "/preview": api,
          "/mcp": api,
          "/hooks": api,
          "/ws": { target: api.replace(/^http/, "ws"), ws: true },
        }
      : undefined,
  },
  preview: { port: 5183, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "tmp/ui-build", emptyOutDir: true },
});
