/**
 * The entry of the web app: it loads the styles, starts the theme and the boot, and draws App.
 * Nothing imports this file. Read next: app/App.tsx (the shell) and state/api/boot.ts (the first load).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design/fonts";
import "./design/tokens.css";
import "./design/base.css";
import "./design/components";
import "./app/app.css";
import { initTheme } from "./design/theme";
import { boot } from "./state/api";
import { store } from "./state/store";
import { App } from "./app/App";

initTheme();
void boot();

// Development aid: read the store from the console (window.__gitring.store.get()).
if (import.meta.env.DEV) (window as unknown as { __gitring: unknown }).__gitring = { store };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
