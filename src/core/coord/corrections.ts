/**
 * Writes the change request for one pair from the facts, in short imperative sentences.
 *
 * Called by the project coordinator. Never blame an agent. Every message ends with the sentence in `CONTINUE`.
 * Read `rules.ts` for who gives way.
 */

/*
 * Correction text: a template from facts, in ASD-STE100 style.
 *
 * Rules for every message: imperative instructions, one instruction per sentence, ≤ 20 words per
 * sentence, active voice, simple tenses, no "-ing" forms (identifiers and quoted titles excepted).
 * Concrete: callsigns, files, line ranges, exact signatures when known. Every message ends with
 * "Continue your work." Constraints carry the same content in machine form.
 */

import type { Amendment, Correction, CorrectionKind, LineRange, PairFacts, RuleOfTheRoad, SymbolKey } from "../types";
import { callForm, intersectSymbols, isCodePath, mergeRanges, symbolName, symbolPath, usedChanges, type SignatureInfo } from "../analysis/range";
import type { VesselView } from "./facts";

export interface DraftedCorrection {
  kind: CorrectionKind;
  message: string;
  constraints: Correction["constraints"];
}

type Side = "incoming" | "other";
type Constraints = Correction["constraints"];

export const CONTINUE = "Continue your work.";
const MAX_LIST = 3;

/* ───────────────────────────── text helpers ───────────────────────────── */

function joinWith(xs: string[], word: "and" | "or"): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} ${word} ${xs[xs.length - 1]}`;
}

/** "src/a.js", "src/a.js and src/b.js", "src/a.js, src/b.js and 2 other files". */
export function listFiles(files: readonly string[]): string {
  const uniq = [...new Set(files)];
  if (uniq.length <= MAX_LIST) return joinWith(uniq, "and");
  const rest = uniq.length - (MAX_LIST - 1);
  return `${uniq.slice(0, MAX_LIST - 1).join(", ")} and ${rest} other files`;
}

/** "line 12", "lines 12–30", "lines 8–20 and 41–44" (at most 4 ranges). */
export function formatLines(ranges: readonly LineRange[]): string {
  const rs = mergeRanges(ranges.map(([a, b]): LineRange => [Math.max(1, a), Math.max(1, b)])).slice(0, 4);
  if (rs.length === 1 && rs[0][0] === rs[0][1]) return `line ${rs[0][0]}`;
  return `lines ${joinWith(rs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)), "and")}`;
}

/** A human title in quotes, at most 8 words. */
function quoteTitle(title: string): string {
  const words = (title ?? "").replace(/["\s]+/g, " ").trim().split(" ").filter(Boolean);
  const t = words.length > 8 ? `${words.slice(0, 8).join(" ")}…` : words.join(" ");
  return `"${t || "untitled"}"`;
}

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);
const build = (parts: string[]): string => [...parts.filter(Boolean).map(sentence), CONTINUE].join(" ");

function pushRegion(c: Constraints, path: string, lines: LineRange): void {
  const list = (c.avoidRegions ??= []);
  if (!list.some((r) => r.path === path && r.lines[0] === lines[0] && r.lines[1] === lines[1])) list.push({ path, lines: [lines[0], lines[1]] });
}
function pushSignature(c: Constraints, symbol: SymbolKey, signature: string | undefined): void {
  if (!signature) return;
  const list = (c.useSignatures ??= []);
  if (!list.some((s) => s.symbol === symbol)) list.push({ symbol, signature });
}
function pushNote(c: Constraints, note: string): void {
  const list = (c.notes ??= []);
  const n = sentence(note);
  if (!list.includes(n)) list.push(n);
}
function finish(kind: CorrectionKind, parts: string[], c: Constraints): DraftedCorrection {
  const constraints: Constraints = {};
  if (c.avoidRegions?.length) constraints.avoidRegions = c.avoidRegions;
  if (c.useSignatures?.length) constraints.useSignatures = c.useSignatures;
  if (c.notes?.length) constraints.notes = c.notes;
  return { kind, message: build(parts), constraints };
}

const flip = (s: Side): Side => (s === "incoming" ? "other" : "incoming");

/** Known signatures of `key` on a vessel (exact key, else the same name in the same or an unknown file). */
function signatureOf(v: VesselView, key: SymbolKey): SignatureInfo | undefined {
  const sigs = v.shape.signatures;
  if (!sigs) return undefined;
  if (sigs[key]) return sigs[key];
  const name = symbolName(key);
  const path = symbolPath(key);
  for (const [k, info] of Object.entries(sigs)) {
    if (symbolName(k) === name && (!symbolPath(k) || !path || symbolPath(k) === path)) return info;
  }
  return undefined;
}

/* ───────────────────────────── parts ───────────────────────────── */

/** The receiver uses `symbol`; the stand-on vessel changes its signature. */
function consumerParts(standOn: VesselView, hit: PairFacts["interfaceHits"][number], c: Constraints): string[] {
  const X = standOn.agent.callsign;
  const name = symbolName(hit.symbol);
  const file = symbolPath(hit.symbol) || "its module";
  const sig = signatureOf(standOn, hit.symbol);
  const landed = standOn.state === "landed";
  const verb = landed ? "changed" : "changes";
  const where = hit.usedAt.length ? listFiles(hit.usedAt) : "your files";
  const parts: string[] = [];
  if (sig?.before && sig.after) parts.push(`${X} ${verb} ${sig.before} to ${sig.after} in ${file}`);
  else if (sig?.after) parts.push(`${X} ${verb} the signature of ${name} in ${file} to ${sig.after}`);
  else parts.push(`${X} ${verb} the signature of ${name} in ${file}`);
  if (sig?.after) {
    parts.push(`Call ${callForm(sig.after)} in ${where}`);
    pushSignature(c, hit.symbol, sig.after);
    pushNote(c, `Call ${callForm(sig.after)} in ${where}`);
  } else {
    parts.push(`Read the new signature of ${name} in ${file}`, `Use the new signature in ${where}`);
    pushNote(c, `Use the new signature of ${name} from ${file} in ${where}`);
  }
  parts.push(`Do not edit ${name} in ${file}`);
  pushNote(c, `Do not edit ${name} in ${file}`);
  return parts;
}

/** The receiver changes the signature of `symbol`; the stand-on vessel uses it. */
function producerParts(receiver: VesselView, standOn: VesselView, hit: PairFacts["interfaceHits"][number], c: Constraints): string[] {
  const X = standOn.agent.callsign;
  const name = symbolName(hit.symbol);
  const sig = signatureOf(receiver, hit.symbol);
  const where = hit.usedAt.length ? listFiles(hit.usedAt) : "its files";
  const parts: string[] = [];
  if (standOn.state === "landed") {
    parts.push(`${X} added calls to ${name} in ${where} on main`);
    parts.push(sig?.after ? `Update each call to ${name} in ${where} to ${callForm(sig.after)}` : `Update each call to ${name} in ${where}`);
    pushNote(c, `Update each call to ${name} in ${where}`);
    pushSignature(c, hit.symbol, sig?.after);
  } else {
    parts.push(`${X} calls ${name} in ${where}`);
    parts.push(sig?.before ? `Keep ${sig.before} valid for these calls` : `Keep the old signature of ${name} valid for these calls`);
    parts.push(`Give each new parameter a default value`, `Do not edit the calls in ${where}`);
    pushSignature(c, hit.symbol, sig?.before);
    pushNote(c, sig?.before ? `Keep ${sig.before} valid for the calls in ${where}` : `Keep the old signature of ${name} valid for the calls in ${where}`);
  }
  return parts;
}

/** Shared file `path`: tell the receiver where the stand-on vessel works. */
function regionParts(receiver: VesselView, standOn: VesselView, facts: PairFacts, path: string, c: Constraints): string[] {
  const X = standOn.agent.callsign;
  const landed = standOn.state === "landed";
  const theirHunks = mergeRanges(standOn.shape.hunks[path] ?? []);
  const overlapsHere = facts.hunkOverlaps.filter((o) => o.path === path);
  const mine = receiver.shape.hunks[path] ?? [];
  const parts: string[] = [];
  if (theirHunks.length) {
    const lines = formatLines(theirHunks);
    const last = Math.max(1, ...theirHunks.map((h) => h[1]));
    for (const h of theirHunks) pushRegion(c, path, h);
    const these = lines.startsWith("line ") ? "this line" : "these lines";
    if (landed) {
      parts.push(`${X} changed ${lines} of ${path} on main`);
      if (overlapsHere.length) parts.push(`Your edits overlap ${these}`);
      parts.push(`Read ${path} again before your next edit`);
      pushNote(c, `Keep the changes of ${X} in ${lines} of ${path}`);
    } else {
      parts.push(`${X} edits ${lines} of ${path}`);
      if (overlapsHere.length) parts.push(`Your edits overlap ${these}`);
      parts.push(`Do not edit ${these}`);
      // Say where to work only when the receiver overlaps, or has no edits in this file yet.
      if (overlapsHere.length || !mine.length) parts.push(`Put your change in a new block below line ${last}`);
      pushNote(c, `Do not edit ${lines} of ${path} (${X})`);
    }
    return parts;
  }
  const shared = facts.sharedSymbols.filter((k) => symbolPath(k) === path);
  const theirs = (shared.length ? shared : standOn.shape.changed.filter((k) => symbolPath(k) === path)).slice(0, MAX_LIST);
  if (theirs.length) {
    const names = theirs.map(symbolName);
    // Both change the same function, at lines we do not know yet. Do not forbid the function: the
    // receiver's intent can need it. Ask for a small, separate block and a look at the traffic.
    parts.push(`${X} also ${landed ? "changed" : "changes"} ${joinWith(names, "and")} in ${path}`);
    parts.push(`Do not rewrite ${joinWith(names, "or")}`);
    parts.push(`Keep your change to ${names.length > 1 ? "them" : names[0]} small and in a separate block`);
    parts.push(`Read gitring_traffic before you edit ${path}`);
    pushNote(c, `Do not rewrite ${joinWith(names, "or")} in ${path}; keep a separate block (${X})`);
    return parts;
  }
  parts.push(`${X} also ${landed ? "changed" : "edits"} ${path}`, `Keep your edits to ${path} small and separate`);
  pushNote(c, `Keep edits to ${path} small and separate (${X})`);
  return parts;
}

/* ───────────────────────────── corrections ───────────────────────────── */

/**
 * Draft the correction for the give-way vessel.
 * `perspective` names the side of `facts` that the give-way vessel is on: "incoming" when the
 * incoming vessel gives way; "other" when the traffic vessel gives way (the incoming vessel
 * stands on and the correction goes to the other vessel).
 */
export function draftCorrection(
  giveWay: VesselView,
  standOn: VesselView,
  facts: PairFacts,
  rule: RuleOfTheRoad,
  perspective: Side,
): DraftedCorrection {
  void rule; // the rule is recorded on the Correction; the text follows the facts
  const me: Side = perspective;
  const them: Side = flip(perspective);
  const c: Constraints = {};
  const parts: string[] = [];
  let kind: CorrectionKind | undefined;

  // 1. Interface hits: the stand-on vessel changes a signature that the receiver uses, or the reverse.
  const consumerHits = facts.interfaceHits.filter((h) => h.changedBy === them).slice(0, MAX_LIST);
  const producerHits = facts.interfaceHits.filter((h) => h.changedBy === me).slice(0, MAX_LIST);
  for (const hit of consumerHits) parts.push(...consumerParts(standOn, hit, c));
  for (const hit of producerHits) parts.push(...producerParts(giveWay, standOn, hit, c));
  if (parts.length) kind = "interface";

  // 2. Shared files: keep out of the lines (or symbols) of the stand-on vessel. Skip the files where
  //    the receiver must update calls that landed on main (no contradictory instructions).
  const mustEdit = new Set(standOn.state === "landed" ? producerHits.flatMap((h) => h.usedAt) : []);
  const regionFiles = [
    ...new Set([...facts.hunkOverlaps.map((o) => o.path), ...facts.sharedSymbols.map(symbolPath).filter(Boolean), ...facts.sharedFiles]),
  ]
    .filter((p) => !mustEdit.has(p))
    .slice(0, MAX_LIST);
  for (const path of regionFiles) parts.push(...regionParts(giveWay, standOn, facts, path, c));
  if (!kind && regionFiles.length) kind = "region";

  // 3. Range 1 without a signature change: a changed body that the other side uses.
  if (!kind) {
    const theyChange = usedChanges(standOn.shape, giveWay.shape).slice(0, MAX_LIST);
    const iChange = usedChanges(giveWay.shape, standOn.shape).slice(0, MAX_LIST);
    const X = standOn.agent.callsign;
    for (const s of theyChange) {
      const name = symbolName(s);
      const file = symbolPath(s) || "its module";
      parts.push(`${X} ${standOn.state === "landed" ? "changed" : "changes"} ${name} in ${file}`);
      parts.push(`Read ${file} again before you call ${name}`, `Do not edit ${name}`);
      pushNote(c, `Do not edit ${name} in ${file} (${X})`);
    }
    for (const s of iChange) {
      const name = symbolName(s);
      const users = standOn.shape.files.filter((f) => f !== symbolPath(s) && isCodePath(f));
      parts.push(`${X} calls ${name} in ${users.length ? listFiles(users) : "its files"}`);
      parts.push(`Keep the behavior of ${name} the same for these calls`);
      pushNote(c, `Keep the behavior of ${name} the same for ${X}`);
    }
    if (parts.length) kind = "interface";
  }

  // 4. Near, but no shared file or symbol (import neighbors, or closing): keep off their files.
  if (!kind) {
    const X = standOn.agent.callsign;
    const files = standOn.shape.files.length ? standOn.shape.files : standOn.attempt.course?.files ?? [];
    if (files.length) {
      parts.push(`${X} ${standOn.state === "landed" ? "changed" : "edits"} ${listFiles(files)}`);
      parts.push(`Do not edit ${files.length > 1 ? "these files" : files[0]}`);
      parts.push(`Read ${listFiles(files)} again before you call ${files.length > 1 ? "their" : "its"} exports`);
      pushNote(c, `Do not edit ${listFiles(files)} (${X})`);
    } else {
      parts.push(`${X} works near your files`, `Keep your change small`);
    }
    kind = "region";
  }
  return finish(kind, parts, c);
}

/**
 * What a vessel does about a landed signature change: call the new form where it uses the symbol
 * (the files where its changed code really calls it, when known), or keep the new parameter list
 * when it only changes the function body.
 */
function signatureAdvice(v: VesselView, symbol: SymbolKey, signature: string, myCode: string[]): string {
  const name = symbolName(symbol);
  const file = symbolPath(symbol);
  const calls = intersectSymbols([symbol], v.shape.referenced).length > 0;
  if (!calls) return `Keep the parameter list ${callForm(signature)} when you change ${name}`;
  const seen = v.shape.referencedIn?.[symbol] ?? Object.entries(v.shape.referencedIn ?? {}).find(([k]) => symbolName(k) === name && (!file || !symbolPath(k) || symbolPath(k) === file))?.[1];
  const users = seen?.length ? seen : myCode.filter((f) => f !== file);
  return `Call ${callForm(signature)} in ${users.length ? listFiles(users) : "your code"}`;
}

/** Main moved under `v`: name the landed intent, its files and any signature changes. */
export function draftUpstreamCorrection(
  v: VesselView,
  landed: { intentTitle: string; files: string[]; signatureChanges: { symbol: SymbolKey; signature: string }[] },
): DraftedCorrection {
  const c: Constraints = {};
  const parts: string[] = [`The task ${quoteTitle(landed.intentTitle)} merged into main`];
  if (landed.files.length) parts.push(`It changed ${listFiles(landed.files)}`);
  const myCode = v.shape.files.filter(isCodePath);
  const mine = [...v.shape.referenced, ...v.shape.changed];
  for (const s of landed.signatureChanges.slice(0, MAX_LIST)) {
    const name = symbolName(s.symbol);
    const file = symbolPath(s.symbol) || "its module";
    parts.push(`${name} in ${file} is now ${s.signature}`);
    pushSignature(c, s.symbol, s.signature);
    // Tell the vessel what to do only when its work uses or changes the symbol.
    if (intersectSymbols([s.symbol], mine).length) parts.push(signatureAdvice(v, s.symbol, s.signature, myCode));
  }
  const overlap = landed.files.filter((f) => v.shape.files.includes(f));
  const reread = overlap.length ? overlap : landed.files;
  if (reread.length) {
    parts.push(`Read ${listFiles(reread)} again before your next edit`);
    pushNote(c, `Read ${listFiles(reread)} again before the next edit`);
  }
  return finish("upstream", parts, c);
}

/**
 * Main moved under `v`, and gitring moved the work of `v` onto the new main (a re-plot).
 * `merged`: files where gitring merged the landed change into the agent's copy.
 * `reapply`: files where the two changes overlap; gitring kept the main version and the agent
 * makes its change again (the diff shows the earlier change). The diffs follow the sentences.
 */
export function draftReplotCorrection(
  v: VesselView,
  landed: { intentTitle: string; files: string[]; signatureChanges: { symbol: SymbolKey; signature: string }[] },
  moved: { mainSha: string; merged: string[]; reapply: { path: string; diff: string }[] },
): DraftedCorrection {
  const c: Constraints = {};
  const parts: string[] = [`The task ${quoteTitle(landed.intentTitle)} merged into main`];
  parts.push(`gitring moved your work onto the new main (${moved.mainSha.slice(0, 7)})`);
  if (moved.merged.length) parts.push(`Your copies of ${listFiles(moved.merged)} now include the merged change`);
  const myCode = v.shape.files.filter(isCodePath);
  const mine = [...v.shape.referenced, ...v.shape.changed];
  for (const s of landed.signatureChanges.slice(0, MAX_LIST)) {
    if (!intersectSymbols([s.symbol], mine).length) continue;
    const name = symbolName(s.symbol);
    const file = symbolPath(s.symbol) || "its module";
    parts.push(`${name} in ${file} is now ${s.signature}`);
    parts.push(signatureAdvice(v, s.symbol, s.signature, myCode));
    pushSignature(c, s.symbol, s.signature);
  }
  const again = moved.reapply.map((r) => r.path);
  if (again.length) {
    parts.push(`Your change to ${listFiles(again)} overlaps the merged change`);
    parts.push(`gitring kept the main version of ${again.length > 1 ? "these files" : again[0]}`);
    parts.push(`Make your change again on the new text`);
    pushNote(c, `Make the change to ${listFiles(again)} again on the new main`);
  }
  const reread = [...new Set([...moved.merged, ...again])];
  if (reread.length) {
    parts.push(`Read ${listFiles(reread)} again before your next edit`);
    pushNote(c, `Read ${listFiles(reread)} again before the next edit`);
  }
  const out = finish("upstream", parts, c);
  out.constraints.replot = { mainSha: moved.mainSha };
  if (moved.reapply.length) {
    out.constraints.reapply = moved.reapply.map((r) => ({ path: r.path, diff: r.diff }));
    out.message += moved.reapply.map((r) => `\n\nYour earlier change to ${r.path}:\n\`\`\`diff\n${r.diff.trimEnd()}\n\`\`\``).join("");
  }
  return out;
}

/** Another vessel does the same work. */
export function draftDuplicateCorrection(v: VesselView, other: VesselView): DraftedCorrection {
  void v;
  const O = other.agent.callsign;
  const c: Constraints = {};
  const title = quoteTitle(other.intent.title);
  const parts = [
    `${O} does the same work in the task ${title}`,
    `Do not do this work twice`,
    `Change your plan to the parts that are different`,
    `A person decides how to join the two tasks`,
  ];
  pushNote(c, `Do not duplicate the work of ${O} in the task ${title}`);
  return finish("duplicate", parts, c);
}

/** A human (or gitring) amended the intent of `v` (addition: kind "intent-amended"). */
export function draftIntentAmendedCorrection(v: VesselView, amendment: Amendment): DraftedCorrection {
  const c: Constraints = {};
  const who = amendment.by?.kind === "human" ? "A person" : amendment.by?.kind === "agent" ? `Agent ${amendment.by.name || amendment.by.id}` : "The system";
  const parts = [`${who} changed the task ${quoteTitle(v.intent.title)} to version ${amendment.version}`];
  const words = (amendment.text ?? "").replace(/["\s]+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length) {
    parts.push(`Read the new text: "${words.length > 12 ? `${words.slice(0, 12).join(" ")}…` : words.join(" ")}"`);
    pushNote(c, amendment.text.trim());
  }
  parts.push(`Follow the new goal and constraints`);
  return finish("intent-amended", parts, c);
}
