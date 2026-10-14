// Opens one screen, checks that it is the right state, and saves its pictures.
// Used by: scripts/shots.mjs. It acts like a person (it loads a page and runs the clicks of the screen). It does not call the API.
import path from "node:path";
import { shownTheme } from "./account.mjs";

// ───── Waiting ─────

/** Waits until the page has its content: some text, no skeleton and no busy marker, fonts loaded. */
export async function waitForContent(page) {
  await page.waitForFunction(
    () => {
      const main = document.querySelector("#main") ?? document.body;
      return main.innerText.trim().length > 0 && !document.querySelector(".b-skel, [aria-busy='true']");
    },
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

// ───── Opening and checking ─────

/**
 * Loads the route of a screen, then runs its clicks. A screen may have a `before` step that changes the network
 * (it returns a function that puts the network back), and may be a `loading` screen: the shot comes while the
 * content is still on its way. Returns the function that puts the network back.
 */
export async function openScreen(page, screen, ids, baseUrl) {
  const release = screen.before ? await screen.before(page, ids) : async () => undefined;
  try {
    await page.goto(`${baseUrl}${screen.route(ids)}`, { waitUntil: screen.loading ? "domcontentloaded" : "load" });
    if (screen.loading) {
      await page.waitForTimeout(1200);
      return release;
    }
    await waitForContent(page);
    if (screen.prepare) {
      await screen.prepare(page, ids);
      await waitForContent(page);
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

/** Throws when the page shows another theme than asked, or is signed out when the screen needs a person. */
export async function checkState(page, { theme, phase }) {
  const shown = await shownTheme(page);
  if (shown !== theme) throw new Error(`The page shows the theme ${shown}, not ${theme}.`);
  const isSignedOut = (await page.locator("[data-signin-anchor]").count()) > 0;
  if (phase !== "out" && isSignedOut) throw new Error("The page is signed out. The sign-up did not hold.");
  return shown;
}

// ───── Pictures ─────

/**
 * The height that shows the whole page. Many screens keep the page still and scroll one pane, so the
 * height comes from the tallest scrolling pane too.
 */
function fullHeight(page) {
  return page.evaluate(() => {
    let extra = document.documentElement.scrollHeight - innerHeight;
    for (const el of document.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
      if (scrolls && el.scrollHeight > el.clientHeight + 4) extra = Math.max(extra, el.scrollHeight - el.clientHeight);
    }
    return innerHeight + Math.max(0, extra);
  });
}

/** A tall picture of the whole page: the window grows to the height of the content, then goes back. Returns the file, or null when the page is not taller. */
async function saveTall(page, file) {
  const view = page.viewportSize();
  const tall = Math.min(5000, await fullHeight(page));
  if (tall <= view.height + 8) return null;
  await page.setViewportSize({ width: view.width, height: tall });
  await page.waitForTimeout(400);
  await page.screenshot({ path: file });
  await page.setViewportSize(view);
  await page.waitForTimeout(200);
  return file;
}

/** Saves the picture of the window, and with `full` the tall picture. Returns the two file names. */
export async function savePictures(page, { out, name, full }) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  const tall = full ? await saveTall(page, path.join(out, `${name}-full.png`)) : null;
  return { file, tall };
}

/** The picture of a page that failed, so that a person sees what was on the screen. Returns null when the page is gone. */
export async function saveErrorPicture(page, { out, name }) {
  const file = path.join(out, `${name}.error.png`);
  try {
    await page.screenshot({ path: file });
    return file;
  } catch {
    return null;
  }
}
