// Starts a real Chromium for the screenshot tool and gives a person a passkey that works without a device.
// Used by: scripts/shots.mjs. It never stores a passkey on disk: the virtual authenticator lives in memory.
// Copied from the launch logic of the video recorder (that folder is not in git): read it before you change this.
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

// ───── Sizes ─────

/** The two window sizes of a shot. A phone is a touch device with a pixel ratio of 2. */
export const SIZES = {
  desktop: { width: 1440, height: 900, scale: 1, phone: false },
  phone: { width: 390, height: 844, scale: 2, phone: true },
};

// ───── Chromium ─────

const BUILD_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === "win32" ? "AppData/Local/ms-playwright" : ".cache/ms-playwright");

/**
 * Finds a browser. Order: CHROMIUM_PATH, the build that this Playwright version expects, the newest
 * chromium-* build in the Playwright folder (an older build works for shots), then an installed Chrome.
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  if (existsSync(chromium.executablePath())) return {};
  const exe = process.platform === "win32" ? "chrome-win64/chrome.exe" : process.platform === "darwin" ? "chrome-mac/Chromium.app/Contents/MacOS/Chromium" : "chrome-linux/chrome";
  const builds = existsSync(BUILD_DIR) ? readdirSync(BUILD_DIR).filter((name) => /^chromium-\d+$/.test(name)) : [];
  builds.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const build of builds) {
    const executablePath = path.join(BUILD_DIR, build, exe);
    if (existsSync(executablePath)) return { executablePath };
  }
  return { channel: "chrome" };
}

/** One headless browser. The flags make text look the same on every computer. */
export function launchBrowser() {
  return chromium.launch({
    headless: true,
    ...findChromium(),
    args: ["--hide-scrollbars", "--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb"],
  });
}

/**
 * A context of one size. Without `storageState` it has no cookies (a stranger). Reduced motion keeps the shots still,
 * except for a screen that shows motion on purpose (the scroll story of the landing page): it passes `motion: true`.
 */
export function newContext(browser, sizeName, storageState, { motion = false } = {}) {
  const size = SIZES[sizeName];
  return browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.scale,
    isMobile: size.phone,
    hasTouch: size.phone,
    colorScheme: "light",
    reducedMotion: motion ? "no-preference" : "reduce",
    storageState,
    acceptDownloads: false,
  });
}

// ───── Passkey ─────

/**
 * Adds a virtual WebAuthn authenticator (CTAP2, internal, resident keys, user verification) to a page.
 * With it a test account signs up and signs in with a passkey. `credentials` come from an earlier
 * credentials() call, so a second context signs in again with the same passkey.
 */
export async function addPasskey(page, { credentials = [] } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  for (const credential of credentials) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  return {
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
  };
}
