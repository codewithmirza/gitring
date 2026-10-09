/**
 * Compact, facts-first Clef request.
 *
 * Decision models answer best when the state is short and the facts are explicit. This builder
 * writes the state as a few plain English lines per vessel (ASD-STE100 style) and keeps the same
 * question ids as `buildClefRequest`, so `parseClefResponse` reads the answers unchanged.
 */
import type { PairFacts } from "../types";
import { INTERFERENCE_LEVELS } from "../types";
import type { VesselView } from "./facts";
import { CLEF_MAX_CANDIDATES, CLEF_MAX_QUESTIONS, clefQuestionIds, type ClefQuestion, type ClefRequest } from "./clef";

const MAX_GOAL = 220;

function cut(s: string | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function name(sym: string): string {
  return sym.includes("#") ? sym.slice(sym.indexOf("#") + 1) : sym;
}

function list(xs: readonly string[], n = 6): string {
  const items = xs.slice(0, n);
  const more = xs.length > n ? ` and ${xs.length - n} more` : "";
  return items.join(", ") + more;
}

function workLine(v: VesselView): string {
  const files = v.shape.files.filter((f) => !f.startsWith("tests/"));
  const changed = [...new Set(v.shape.changed.map(name))];
  const parts = [`files ${files.length ? list(files) : "none yet"}`];
  if (changed.length) parts.push(`changes ${list(changed)}`);
  if (v.shape.signatureChanged.length) {
    const sigs = v.shape.signatureChanged.map((s) => {
      const info = v.shape.signatures?.[s];
      return info?.before && info?.after ? `${info.before} → ${info.after}` : `${name(s)} (new signature)`;
    });
    parts.push(`changes the interface ${list(sigs, 3)}`);
  }
  if (v.shape.referenced.length) parts.push(`uses ${list([...new Set(v.shape.referenced.map(name))], 6)}`);
  return parts.join("; ");
}

/** Plain English facts for one pair, strongest evidence first. */
export function factsLines(f: PairFacts, otherId: string): string[] {
  const out: string[] = [];
  for (const h of f.hunkOverlaps.slice(0, 3)) {
    out.push(`Both edit ${h.path}: the incoming agent lines ${h.incoming[0]}–${h.incoming[1]}, ${otherId} lines ${h.other[0]}–${h.other[1]}. The lines overlap.`);
  }
  for (const hit of f.interfaceHits.slice(0, 3)) {
    const who = hit.changedBy === "incoming" ? "The incoming agent" : otherId;
    const user = hit.changedBy === "incoming" ? otherId : "the incoming agent";
    out.push(`${who} changes the interface of ${name(hit.symbol)}; ${user} uses it in ${list(hit.usedAt, 3)}.`);
  }
  if (f.sharedSymbols.length) out.push(`Both change ${list(f.sharedSymbols.map(name), 4)}.`);
  if (f.sharedFiles.length && !f.hunkOverlaps.length) out.push(`Both edit ${list(f.sharedFiles, 4)}, in different lines.`);
  if (!f.sharedFiles.length) out.push(f.range <= 4 ? `They edit different files that are ${f.range === 3 ? "one import" : "two imports"} apart.` : "They edit unrelated files.");
  out.push(`Range ${f.range} (0 = same lines, 5 = unrelated)${f.closing && f.previousRange !== undefined ? `, closing from ${f.previousRange}` : ""}.`);
  if (f.intentSimilarity >= 0.25) out.push(`The two intents are ${f.intentSimilarity >= 0.6 ? "very" : "somewhat"} similar (${Math.round(f.intentSimilarity * 100)}%).`);
  return out;
}

export function buildBriefClefRequest(
  model: "clef" | "clef-flash",
  incoming: VesselView,
  cands: { view: VesselView; facts: PairFacts }[],
): ClefRequest {
  const listCands = cands.slice(0, CLEF_MAX_CANDIDATES);
  const lines: string[] = [
    "gitring course check. Many coding agents change one repository at the same time.",
    "Decide for each traffic vessel: will its work and the incoming work collide if both continue unchanged? A collision is a text conflict or a broken interface.",
    `Incoming agent ${incoming.agent.callsign} (${incoming.state}), intent "${cut(incoming.intent.title, 120)}": ${cut(incoming.intent.goal, MAX_GOAL)}`,
    `Incoming work: ${workLine(incoming)}. Size ${incoming.footprintSize}. Declared at ${new Date(incoming.attempt.course.declaredAt).toISOString()}.`,
  ];
  listCands.forEach((c, i) => {
    const id = `v${i}`;
    lines.push("");
    lines.push(`${id}: agent ${c.view.agent.callsign} (${c.view.state}), intent "${cut(c.view.intent.title, 120)}": ${cut(c.view.intent.goal, 160)}`);
    lines.push(`${id} work: ${workLine(c.view)}. Size ${c.view.footprintSize}. Declared at ${new Date(c.view.attempt.course.declaredAt).toISOString()}.`);
    for (const l of factsLines(c.facts, id)) lines.push(`Fact: ${l}`);
  });
  lines.push("");
  lines.push(
    "Rules of the road, in order: R1 landed work has the right of way. R2 work that waits to land stands on. " +
      "R3 the agent that changes an interface stands on; agents that use it adapt. R5 high priority stands on. " +
      "R4 the earlier course stands on. R6 the smaller change gives way.",
  );

  const questions: Record<string, ClefQuestion> = {};
  listCands.forEach((_c, i) => {
    const id = clefQuestionIds(i);
    const v = `v${i}`;
    questions[id.collide] = {
      type: "noul",
      instructions: `Will the incoming work and ${v} collide if both continue unchanged? Use the facts.`,
      criteria: {
        true: "They edit overlapping lines, or one changes an interface that the other uses.",
        false: "They edit different lines or files, and no interface that one changes is used by the other.",
      },
    };
    questions[id.interfere] = {
      type: "score",
      instructions: `How strong is the interference between the incoming work and ${v}?`,
      criteria: [...INTERFERENCE_LEVELS],
    };
    questions[id.giveway] = {
      type: "choice",
      instructions: `Which agent must adapt its plan, by the rules of the road? Compare the incoming agent and ${v}.`,
      criteria: { incoming: "The incoming agent adapts", other: `${v} adapts` },
    };
  });
  questions.duplicate = {
    type: "noul",
    instructions: "Does the incoming intent ask for the same outcome as a traffic intent?",
    criteria: { true: "Yes. Two agents do the same work.", false: "No. The goals are different, even when the code overlaps." },
  };
  if (listCands.length >= 2) {
    const criteria: Record<string, string> = { none: "No traffic intent is a duplicate" };
    listCands.forEach((c, i) => (criteria[`v${i}`] = `v${i}: "${cut(c.view.intent.title, 70)}"`));
    questions["duplicate.of"] = { type: "choice", instructions: "Which traffic intent is a duplicate of the incoming intent?", criteria };
  }
  if (Object.keys(questions).length > CLEF_MAX_QUESTIONS) throw new Error("Clef request has too many questions.");
  return { model, state: lines.join("\n"), questions };
}
