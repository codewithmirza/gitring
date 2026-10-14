/**
 * Finds the language of a file from its name, and the language of a Markdown code fence from its label.
 */
export type Lang = "js" | "ts" | "json" | "css" | "html" | "md" | "py" | "go";

export interface LangInfo {
  lang: Lang;
  /** JSX in .js, .jsx, .mjs and .tsx files. */
  jsx: boolean;
}

const EXT: Record<string, LangInfo> = {
  js: { lang: "js", jsx: true },
  mjs: { lang: "js", jsx: true },
  cjs: { lang: "js", jsx: false },
  jsx: { lang: "js", jsx: true },
  ts: { lang: "ts", jsx: false },
  mts: { lang: "ts", jsx: false },
  cts: { lang: "ts", jsx: false },
  tsx: { lang: "ts", jsx: true },
  json: { lang: "json", jsx: false },
  jsonc: { lang: "json", jsx: false },
  json5: { lang: "json", jsx: false },
  webmanifest: { lang: "json", jsx: false },
  css: { lang: "css", jsx: false },
  html: { lang: "html", jsx: false },
  htm: { lang: "html", jsx: false },
  svg: { lang: "html", jsx: false },
  xml: { lang: "html", jsx: false },
  md: { lang: "md", jsx: false },
  markdown: { lang: "md", jsx: false },
  mdx: { lang: "md", jsx: false },
  py: { lang: "py", jsx: false },
  pyi: { lang: "py", jsx: false },
  go: { lang: "go", jsx: false },
};

export const FENCE_LANG: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  golang: "go",
  shell: "",
  bash: "",
  sh: "",
};

/** The language of a file, from its name (the server's `lang` is a fallback). null: plain text. */
export function languageOf(path: string, lang?: string): LangInfo | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "tsconfig.json" || base === "jsconfig.json" || base.endsWith(".code-workspace")) return EXT.jsonc;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXT[ext] ?? (lang ? EXT[lang.toLowerCase()] ?? null : null);
}
