// Account steps for the screenshot tool: sign up with a passkey, and set the theme of a page.
// Used by: scripts/shots.mjs and scripts/shots/screens.mjs. It never sends a real credential: the passkey is virtual.

// ───── Sign up ─────

/**
 * Opens the app signed out, chooses "Create an account with a passkey" and makes the account.
 * The page needs a virtual authenticator first (see browser.mjs). The app reloads when the account exists.
 */
export async function signUp(page, baseUrl, name) {
  await page.goto(`${baseUrl}/`, { waitUntil: "load" });
  await page.locator("[data-signin-anchor]").first().click();
  await page.getByRole("button", { name: "Create an account with a passkey" }).click();
  await page.getByLabel("Your name").fill(name);
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.getByRole("button", { name: "Create the account" }).click()]);
  await page.waitForFunction(() => document.querySelector("#main h1"), null, { timeout: 30_000 });
}

// ───── Theme ─────

/** The app keeps the theme in localStorage ("gitring.theme"). A script before the page loads sets it on every load. */
export function presetTheme(context, theme) {
  return context.addInitScript((value) => {
    try {
      localStorage.setItem("gitring.theme", value);
    } catch {
      /* storage is blocked: the app then follows the system theme */
    }
  }, theme);
}

/** The theme that the page really shows (the data-theme attribute), to check a shot. */
export function shownTheme(page) {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}
