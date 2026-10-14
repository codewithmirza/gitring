/**
 * The sections of the settings page, and the one that the address names (`?section=github` or `#st-github`).
 * One section shows at a time. Old addresses keep working: each old anchor (`st-checks`, `st-repo`, `st-danger`) maps to a section.
 * Read next: ../SettingsView.tsx (the tabs and the panels).
 */
import { setSearchParam, useSearchParam } from "../../app/router";

export type SectionId = "general" | "members" | "merging" | "checks" | "github" | "webhooks" | "danger";

export const SECTIONS: { id: SectionId; label: string; owner?: boolean }[] = [
  { id: "general", label: "General" },
  { id: "members", label: "Members" },
  { id: "merging", label: "Merging" },
  { id: "checks", label: "Tests" },
  { id: "github", label: "GitHub" },
  { id: "webhooks", label: "Webhooks" },
  { id: "danger", label: "Archive", owner: true },
];

/** Other names that an address may use for a section. */
const ALIASES: Record<string, SectionId> = { tests: "checks", repo: "general", repository: "general", archive: "danger" };

/** The section that a name stands for, or "general". Only an owner sees "danger" (the Archive tab). */
export function sectionOf(raw: string | null | undefined, owner: boolean): SectionId {
  const name = (raw ?? "").replace(/^st-/, "");
  const id = ALIASES[name] ?? SECTIONS.find((s) => s.id === name)?.id;
  if (!id || (id === "danger" && !owner)) return "general";
  return id;
}

/** The shown section (from `?section=`, else from the `#st-…` anchor) and a function that changes it without a new history entry. */
export function useSection(owner: boolean): [SectionId, (id: SectionId) => void] {
  const param = useSearchParam("section");
  const raw = param ?? (location.hash.startsWith("#st-") ? location.hash.slice(1) : null);
  return [sectionOf(raw, owner), (id) => setSearchParam("section", id)];
}
