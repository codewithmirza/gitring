/**
 * Turns the files of an uploaded folder into commit changes: clean paths, no .git, size limits.
 * Called by the project start in ../master/import.ts and by the Worker. Never accept a path outside the project.
 */

/** A file of an uploaded folder: text, or bytes in base64. */
export interface SeedFile {
  path: string;
  text?: string;
  base64?: string;
  executable?: boolean;
}

export const MAX_UPLOAD_FILES = 5000;
export const MAX_UPLOAD_BYTES = 20_000_000;

/** Uploaded files as commit changes: clean paths, no .git, size limits. */
export function seedChanges(files: SeedFile[]): { path: string; content: string | Uint8Array; mode?: string }[] {
  const out = new Map<string, { path: string; content: string | Uint8Array; mode?: string }>();
  let bytes = 0;
  for (const f of files.slice(0, MAX_UPLOAD_FILES + 1)) {
    const path = String(f.path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || seg === ".git")) continue;
    let content: string | Uint8Array;
    if (typeof f.text === "string") content = f.text;
    else if (typeof f.base64 === "string") content = Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0));
    else continue;
    bytes += typeof content === "string" ? new TextEncoder().encode(content).length : content.length;
    if (bytes > MAX_UPLOAD_BYTES) throw new Error(`The folder is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB. Leave out build output and dependencies, or push it with git.`);
    out.set(path, { path, content, ...(f.executable ? { mode: "100755" } : {}) });
  }
  if (out.size > MAX_UPLOAD_FILES) throw new Error(`The folder has more than ${MAX_UPLOAD_FILES} files. Push it with git instead.`);
  return [...out.values()];
}
