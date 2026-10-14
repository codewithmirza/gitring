// SCRATCH (not committed): a richer real history for the visual check of the replay view.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { nodeLoader, type NodeLoader } from "../checks/node-loader";
import { World } from "../github/harness";
import { callTool, makeProject } from "../mcp/support";

const OUT = "C:/Users/mirza/AppData/Local/Temp/claude/C--Users-mirza-Development-bearing/15f50ab3-d9df-4afd-af55-7d21430c090e/scratchpad/ws-replay/story.json";
const H = 'import { test, expect } from "../harness/test.js";\n';
const FILES: Record<string, string> = {
  "package.json": '{ "name": "shop", "type": "module" }\n',
  "README.md": "# Shop\n\nA small shop.\n",
  "src/price.js": 'export function formatPrice(cents) {\n  return "$" + (cents / 100).toFixed(2);\n}\n\nexport function parsePrice(text) {\n  return Math.round(Number(String(text).replace(/[^0-9.]/g, "")) * 100);\n}\n',
  "src/cart.js": 'import { formatPrice } from "./price.js";\n\nexport function cartTotal(items) {\n  return items.reduce((s, i) => s + i.cents * i.qty, 0);\n}\n\nexport function cartLine(item) {\n  return item.name + " " + formatPrice(item.cents);\n}\n',
  "src/tax.js": 'export function taxRate(region) {\n  return region === "eu" ? 0.2 : 0.1;\n}\n',
  "src/search.js": "export function search(items, q) {\n  return items.filter((i) => i.name.includes(q));\n}\n",
  "web/index.html": "<!doctype html><title>Shop</title><link rel=stylesheet href=style.css><script type=module src=app.js></script>\n",
  "web/app.js": 'import { cartLine } from "../src/cart.js";\nexport function render(items) {\n  return items.map(cartLine).join("\\n");\n}\n',
  "web/style.css": "body { font: 16px system-ui; color: #222; background: #fff; }\n",
  "docs/guide.md": "# Guide\n\nHow to use the shop.\n",
  "tests/price.test.js": H + 'import { formatPrice } from "../src/price.js";\ntest("formats", () => expect(formatPrice(150)).toBe("$1.50"));\n',
  "tests/cart.test.js": H + 'import { cartTotal } from "../src/cart.js";\ntest("totals", () => expect(cartTotal([{ cents: 100, qty: 2 }])).toBe(200));\n',
};

let world: World;
let loader: NodeLoader;
let key: string;
let session: string;
let project: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gr = async (name: string, args: Record<string, unknown>) => {
  const r = await callTool(world, key, name, { project, ...args });
  await sleep(140);
  return r;
};
const idOf = (t: string) => /work copy (a_\w+)/.exec(t)?.[1] ?? "";
const corrIds = (t: string) => [...new Set(t.match(/\bcr_\w+/g) ?? [])];

beforeEach(async () => {
  world = new World();
  loader = nodeLoader();
  vi.stubGlobal("fetch", world.fetch);
  await world.init({ LOADER: loader });
  world.person("alice", 1);
  ({ key, session } = await world.signIn("alice"));
  project = await makeProject(world, key, "shop", { checks: { runner: "worker" } });
  for (const [p, c] of Object.entries(FILES)) await world.land(project, p, c);
  const set = await world.call("PUT", `/api/projects/${project}/settings`, { headers: { cookie: `__Host-gitring=${session}` }, body: { landing: "automatic" } });
  expect(set.status, set.text).toBe(200);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await world.settle();
  await loader.cleanup();
});

it("story", async () => {
  const a = idOf((await gr("gitring_declare", { agent: { id: "robin-a", client: "claude-code", model: "claude-sonnet-5" }, newIntent: { title: "Show prices in euros", goal: "formatPrice takes a currency." }, plan: ["Add a currency parameter to formatPrice", "Update the price test"], files: ["src/price.js", "tests/price.test.js"], symbols: ["src/price.js#formatPrice(cents, currency)"], approach: "Change the signature of formatPrice." })).text);
  const c = idOf((await gr("gitring_declare", { agent: { id: "robin-c", client: "codex", model: "gpt-5.5-codex" }, newIntent: { title: "Dark mode", goal: "The page follows the dark system setting." }, plan: ["Add dark colors", "Add a toggle"], files: ["web/style.css", "web/app.js"], symbols: [], approach: "CSS variables and a media query." })).text);
  const b = idOf((await gr("gitring_declare", { agent: { id: "robin-b", client: "cursor", model: "glm-5.3-flash" }, newIntent: { title: "Add tax to the cart total", goal: "cartTotal adds the tax of the region." }, plan: ["Read the tax rate", "Add tax in cartTotal", "Test it"], files: ["src/cart.js", "src/tax.js", "tests/tax.test.js"], symbols: ["src/cart.js#cartTotal"], approach: "Multiply the total by the tax rate." })).text);
  await gr("gitring_write", {
    attemptId: a,
    message: "formatPrice(cents, currency)",
    files: [
      { path: "src/price.js", content: 'export function formatPrice(cents, currency = "USD") {\n  const sign = currency === "EUR" ? "EUR " : "$";\n  return sign + (cents / 100).toFixed(2);\n}\n\nexport function parsePrice(text) {\n  return Math.round(Number(String(text).replace(/[^0-9.]/g, "")) * 100);\n}\n' },
      { path: "tests/price.test.js", content: H + 'import { formatPrice } from "../src/price.js";\ntest("formats", () => expect(formatPrice(150)).toBe("$1.50"));\ntest("euros", () => expect(formatPrice(150, "EUR")).toBe("EUR 1.50"));\n' },
    ],
  });
  const d = idOf((await gr("gitring_declare", { agent: { id: "robin-d", client: "claude-code", model: "claude-haiku-5" }, newIntent: { title: "Cart lines show the quantity", goal: "cartLine shows the quantity." }, plan: ["Change cartLine"], files: ["src/cart.js"], symbols: ["src/cart.js#cartLine"], approach: "Prefix the quantity." })).text);
  await gr("gitring_write", { attemptId: c, message: "dark colors", files: [{ path: "web/style.css", content: "body { font: 16px system-ui; color: #222; background: #fff; }\n@media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } }\n" }] });
  await gr("gitring_log", { attemptId: c, message: "Dark colors in place. Next: the toggle in app.js.", files: ["web/style.css"] });
  const wb = await gr("gitring_write", {
    attemptId: b,
    message: "tax in cartTotal",
    files: [
      { path: "src/cart.js", content: 'import { formatPrice } from "./price.js";\nimport { taxRate } from "./tax.js";\n\nexport function cartTotal(items, region = "none") {\n  const net = items.reduce((s, i) => s + i.cents * i.qty, 0);\n  return Math.round(net * (1 + (region === "none" ? 0 : taxRate(region))));\n}\n\nexport function cartLine(item) {\n  return item.name + " " + formatPrice(item.cents);\n}\n' },
      { path: "tests/tax.test.js", content: H + 'import { cartTotal } from "../src/cart.js";\ntest("adds tax", () => expect(cartTotal([{ cents: 100, qty: 1 }], "eu")).toBe(120));\n' },
    ],
  });
  for (const id of corrIds(wb.text)) await gr("gitring_ack", { attemptId: b, correctionId: id, note: "I keep cartLine as it is." });
  const wd = await gr("gitring_write", { attemptId: d, message: "quantity in cartLine", files: [{ path: "src/cart.js", content: 'import { formatPrice } from "./price.js";\n\nexport function cartTotal(items) {\n  return items.reduce((s, i) => s + i.cents * i.qty, 0);\n}\n\nexport function cartLine(item) {\n  return item.qty + " x " + item.name + " " + formatPrice(item.cents);\n}\n' }] });
  for (const id of corrIds(wd.text)) await gr("gitring_ack", { attemptId: d, correctionId: id, note: "I change only cartLine." });
  await gr("gitring_check", { attemptId: a });
  await gr("gitring_submit", { attemptId: a, summary: "formatPrice takes a currency." });
  await world.settle();
  await gr("gitring_write", { attemptId: c, message: "toggle", files: [{ path: "web/app.js", content: 'import { cartLine } from "../src/cart.js";\nexport function render(items) {\n  return items.map(cartLine).join("\\n");\n}\nexport function toggleDark() {\n  document.body.classList.toggle("dark");\n}\n' }] });
  const st = await gr("gitring_status", { attemptId: b });
  for (const id of corrIds(st.text)) await gr("gitring_ack", { attemptId: b, correctionId: id, note: "Read the new price.js." });
  await gr("gitring_submit", { attemptId: c, summary: "Dark mode." });
  await world.settle();
  await gr("gitring_submit", { attemptId: b, summary: "Tax in cartTotal." });
  await world.settle();
  const sd = await gr("gitring_status", { attemptId: d });
  for (const id of corrIds(sd.text)) await gr("gitring_ack", { attemptId: d, correctionId: id });
  await gr("gitring_update", { attemptId: d });
  await gr("gitring_submit", { attemptId: d, summary: "Quantity in cart lines." });
  await world.settle();
  const records: unknown[] = [];
  let after: string | null = null;
  let agents: unknown[] = [];
  for (;;) {
    const r = await world.call("GET", `/api/projects/${project}/events?limit=2000${after ? `&after=${after}` : ""}`, { key });
    records.push(...r.json.records);
    agents = r.json.agents;
    if (r.json.done) break;
    after = r.json.next;
  }
  const state = (await world.call("GET", `/api/projects/${project}/state`, { key })).json;
  writeFileSync(OUT, JSON.stringify({ project, state, records, agents }));
  console.log("records", records.length);
});
