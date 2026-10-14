// Measures a rendered page, so a review can point at numbers and not only at a picture.
// Used by: scripts/shots.mjs, once for each shot. It only reads the page. It never changes it, except that
// `tabStops` presses the Tab key (call it after the shot is taken).
// The functions in "Runs inside the page" are sent to the browser as text. They must not use anything outside them.

// ───── Runs inside the page: small helpers ─────

function shorten(text, max = 60) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function labelOf(el) {
  const own = [...el.classList].slice(0, 2).join(".");
  return `${el.tagName.toLowerCase()}${own ? `.${own}` : ""}`;
}

/** True when the element has a size and is not hidden (it may be below the fold). */
function isRendered(el) {
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return false;
  const style = getComputedStyle(el);
  return style.visibility === "visible" && style.display !== "none";
}

/** True when the element is rendered and is inside the window: it is in the picture. */
function isShown(el) {
  const box = el.getBoundingClientRect();
  return isRendered(el) && box.bottom >= 0 && box.top <= innerHeight && box.right >= 0 && box.left <= innerWidth;
}

function opacityOf(el) {
  let value = 1;
  for (let node = el; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
  return value;
}

// ───── Runs inside the page: color ─────

/** Color tools. The canvas turns any CSS color (oklch too) into sRGB, so no color maths for each space is needed. */
function makeColor() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "#000";
    paint.fillStyle = css;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, under) => {
    const alpha = top[3] + under[3] * (1 - top[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / alpha).concat(alpha);
  };
  const luminance = ([r, g, b]) => {
    const linear = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const ratioOf = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  return { rgba, over, ratioOf };
}

/** The color behind an element. It is null when an image or a gradient is behind it: a number would lie. */
function backgroundOf(el, color) {
  let behind = [0, 0, 0, 0];
  for (let node = el; node && behind[3] < 1; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.backgroundImage !== "none") return null;
    behind = color.over(behind, color.rgba(style.backgroundColor));
  }
  return behind[3] < 1 ? color.over(behind, [255, 255, 255, 1]) : behind;
}

// ───── Runs inside the page: text ─────

/** The elements that own rendered text, each with its text. The words are read on the whole page, the rest only in the window. */
function collectText() {
  const owners = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, " ").trim();
    const el = node.parentElement;
    if (!text || !el || el.closest("script, style, noscript, svg, [aria-hidden='true']") || !isRendered(el)) continue;
    owners.set(el, `${owners.get(el) ?? ""} ${text}`.trim());
  }
  return owners;
}

/** Contrast of one piece of text on its background. Returns null when the background is unknown. */
function contrastOf(el, style, size, color) {
  const bg = backgroundOf(el, color);
  if (!bg) return null;
  const fg = color.rgba(style.color);
  const mixed = color.over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], bg);
  const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
  return { ratio: color.ratioOf(mixed, bg), needed: large ? 3 : 4.5 };
}

/** Words that the voice rules of gitring forbid, found in one piece of text. */
function voiceFindings(el, style, text, found) {
  const CODE_NAMES = /\b(intents?|attempts?|vessels?|harbou?rs?|landings?|logbook|courses?|corrections?|callsigns?|clearance|replot|rederive|footprint)\b/i;
  const name = CODE_NAMES.exec(text);
  const where = labelOf(el);
  if (name && !el.closest("code, pre, [data-code]")) found.codeNames.push({ word: name[1].toLowerCase(), text: shorten(text, 80), where });
  if (/github/i.test(text)) found.github.push({ text: shorten(text, 80), where });
  const letters = text.replace(/[^A-Za-z]/g, "");
  const isMono = /mono/i.test(style.fontFamily) || el.closest("code, pre");
  if (style.textTransform === "uppercase" || (letters.length >= 4 && letters === letters.toUpperCase() && !isMono)) found.allCaps.push({ text: shorten(text, 40), where });
  if (text.length <= 100) return;
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/).length;
    if (words > 20) found.longSentences.push({ words, text: shorten(sentence, 90), where });
  }
}

/** Reads every piece of rendered text: the words on the whole page; type sizes, fonts and contrast in the window. */
function readText(color) {
  const sizes = new Set();
  const families = new Set();
  const low = [];
  const found = { codeNames: [], github: [], allCaps: [], longSentences: [] };
  let checked = 0;
  for (const [el, text] of collectText()) {
    const style = getComputedStyle(el);
    voiceFindings(el, style, text, found);
    if (!isShown(el)) continue;
    const size = Math.round(parseFloat(style.fontSize) * 2) / 2;
    sizes.add(size);
    families.add(style.fontFamily.split(",")[0].replace(/["']/g, "").trim());
    const contrast = contrastOf(el, style, size, color);
    if (contrast) {
      checked += 1;
      if (contrast.ratio < contrast.needed) low.push({ text: shorten(text, 40), ratio: Math.round(contrast.ratio * 100) / 100, size, where: labelOf(el) });
    }
  }
  low.sort((a, b) => a.ratio - b.ratio);
  return { sizes: [...sizes].sort((a, b) => a - b), families: [...families], contrast: { checked, failing: low.length, worst: low.slice(0, 8) }, found };
}

// ───── Runs inside the page: controls ─────

/** Every control that is shown, and the ones that are smaller than 24 by 24 pixels. */
function readTargets() {
  const selector = "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=option]";
  const small = [];
  let controls = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (!isShown(el) || el.closest(".vh, .skip-link")) continue;
    controls += 1;
    const box = el.getBoundingClientRect();
    if (box.width >= 24 && box.height >= 24) continue;
    const name = el.getAttribute("aria-label") || el.textContent.trim() || labelOf(el);
    small.push({ text: shorten(name, 30), width: Math.round(box.width), height: Math.round(box.height), where: labelOf(el) });
  }
  return { controls, under24: small.length, samples: small.slice(0, 6) };
}

/** The elements that reach past the right edge of the window: they make the page scroll sideways. */
function readOverflow() {
  const wide = [...document.querySelectorAll("body *")].filter((el) => isShown(el) && el.getBoundingClientRect().right > innerWidth + 1);
  return { sidewaysScroll: document.documentElement.scrollWidth > innerWidth + 1, sidewaysCulprits: wide.slice(0, 3).map(labelOf) };
}

// ───── Runs inside the page: the whole measurement ─────

function measurePage() {
  const text = readText(makeColor());
  const heading = document.querySelector("#main h1, main h1, h1");
  return {
    heading: heading ? shorten(heading.textContent.trim(), 80) : null,
    sizes: text.sizes,
    families: text.families,
    contrast: text.contrast,
    targets: readTargets(),
    ...readOverflow(),
    words: Object.fromEntries(Object.entries(text.found).map(([kind, list]) => [kind, list.slice(0, kind === "longSentences" ? 6 : 8)])),
  };
}

const IN_PAGE = [shorten, labelOf, isRendered, isShown, opacityOf, makeColor, backgroundOf, collectText, contrastOf, voiceFindings, readText, readTargets, readOverflow, measurePage]
  .map((fn) => fn.toString())
  .join("\n");

// ───── Public ─────

/** Measures the page in its current state. */
export function inspectPage(page) {
  return page.evaluate(`(() => {\n${IN_PAGE}\nreturn measurePage();\n})()`);
}

// ───── Keyboard ─────

/** What has the focus now: its name and the box to look at for a ring (the row that holds it, when it is in a row). Runs inside the page. */
function readFocus() {
  const el = document.activeElement;
  if (!el || el === document.body) return { text: "(nothing)", none: true };
  const box = (el.closest("li, tr, [role=row], [role=listitem], [role=option]") ?? el).getBoundingClientRect();
  const text = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.tagName).trim().replace(/s+/g, " ");
  const inView = box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
  window.__shotsFocused = el;
  return { text: text.slice(0, 40), inView, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
}

/**
 * True when the look of the area around the focused element changes with the focus. A ring can be an
 * outline, a shadow, a stroke in a drawing, or an outline on a parent row, so the test compares two
 * pictures of the area (with and without the focus) and does not read one style.
 */
async function showsRing(page, box) {
  const view = page.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 8));
  const y = Math.max(0, Math.floor(box.y - 8));
  const width = Math.min(view.width - x, Math.ceil(box.width + 16));
  const height = Math.min(view.height - y, Math.ceil(box.height + 16));
  if (width < 1 || height < 1) return null;
  const clip = { x, y, width, height };
  const focused = await page.screenshot({ clip });
  await page.evaluate(() => window.__shotsFocused?.blur());
  const blurred = await page.screenshot({ clip });
  await page.evaluate(() => window.__shotsFocused?.focus({ preventScroll: true }));
  return !focused.equals(blurred);
}

/**
 * Presses Tab `count` times and says, for each stop, what has the focus and whether a ring shows.
 * A stop without a ring is a finding. The order of the stops is the order of a person who uses the keyboard.
 */
export async function tabStops(page, count = 12) {
  const stops = [];
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
    const { box, ...stop } = await page.evaluate(readFocus);
    stops.push(stop.none || !stop.inView ? stop : { ...stop, ring: await showsRing(page, box) });
  }
  return stops;
}
