#!/usr/bin/env node
/**
 * Makes the secrets of your own gitring. It writes `.dev.vars` (ignored by git) with new random values.
 * It does not touch wrangler.jsonc and it does not call Cloudflare.
 *
 *   npm run setup -- --owner google:you@example.com
 *   npm run setup -- --owner github:your-login --force
 *
 * Then:  npx wrangler login
 *        npx wrangler secret bulk .dev.vars     (sends the secrets to your Worker)
 *        npm run deploy
 * See docs/SELF-HOST.md for every step.
 */
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SETUP_USAGE = [
  "Usage: npm run setup -- --owner <who> [--force]",
  "  --owner <who>  an owner of your gitring: github:<login>, google:<email> or user:<id>. Repeat the option for more owners.",
  "  --force        replace an existing .dev.vars",
  "It writes .dev.vars with new random values for GITRING_SECRET, GITRING_SETUP_TOKEN and GITRING_KEY.",
];

export function makeVars(owners, rand = (n) => randomBytes(n)) {
  return [
    "# Written by `npm run setup`. Never commit this file. It is for your own gitring.",
    "# `npx wrangler secret bulk .dev.vars` sends these values to your Worker as secrets.",
    "# Seals the sign-in credentials and signs chat questions.",
    `GITRING_SECRET=${rand(32).toString("base64")}`,
    "# Opens /setup before an owner signs in.",
    `GITRING_SETUP_TOKEN=${rand(16).toString("hex")}`,
    "# The owners of this gitring.",
    `GITRING_OWNERS=${owners.join(",")}`,
    "# Key for scripts and the smoke test. It acts as an owner on every project.",
    `GITRING_KEY=${rand(24).toString("hex")}`,
    "",
  ].join("\n");
}

export function parseSetup(argv) {
  const owners = [];
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { code: 0, lines: SETUP_USAGE };
    if (a === "--force") force = true;
    else if (a === "--owner") owners.push(String(argv[++i] ?? ""));
    else if (a.startsWith("--owner=")) owners.push(a.slice(8));
    else return { code: 2, lines: [`Unknown option ${a}.`, ...SETUP_USAGE] };
  }
  const bad = owners.filter((o) => !/^(github|google|user):\S+$/.test(o));
  if (!owners.length || bad.length) return { code: 2, lines: [bad.length ? `This owner is not valid: ${bad[0]}` : "Give at least one owner.", ...SETUP_USAGE] };
  return { owners, force };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const p = parseSetup(process.argv.slice(2));
  if (!p.owners) {
    for (const l of p.lines) console.log(l);
    process.exit(p.code);
  }
  if (existsSync(".dev.vars") && !p.force) {
    console.log(".dev.vars exists already. Use --force to replace it.");
    process.exit(1);
  }
  writeFileSync(".dev.vars", makeVars(p.owners), { mode: 0o600 });
  console.log("Wrote .dev.vars with new secrets. Keep it private: git ignores it.");
  console.log("Next:  npx wrangler login");
  console.log("       npx wrangler secret bulk .dev.vars");
  console.log("       npm run deploy");
  console.log("The key for the smoke test is the GITRING_KEY line of .dev.vars.");
}
