/**
 * The self-hosted fonts of the three voices.
 * All use the SIL OFL 1.1 license, through @fontsource.
 *   System voice — Atkinson Hyperlegible Next (400, 500, 600)
 *   Agent voice  — Atkinson Hyperlegible Mono (400, 500)
 *   Human voice  — Source Serif 4, variable, italic with the optical size axis (opsz)
 */
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/500.css";
import "@fontsource/atkinson-hyperlegible-next/600.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "@fontsource/atkinson-hyperlegible-mono/500.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";

export const FONTS = {
  system: { family: "Atkinson Hyperlegible Next", weights: [400, 500, 600], license: "OFL 1.1 · Braille Institute" },
  agent: { family: "Atkinson Hyperlegible Mono", weights: [400, 500], license: "OFL 1.1 · Braille Institute" },
  human: { family: "Source Serif 4", weights: [400], license: "OFL 1.1 · Adobe" },
} as const;
