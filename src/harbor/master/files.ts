/**
 * Reads files, trees and the view of main from the repository, with caches that keep a merge small.
 * Layer 3 of the chain in master/README.md. Extends HarborRecords (records.ts).
 * It must never keep a whole repository in memory: the limits in support/constants.ts hold the memory of a merge.
 * Read next: work-views.ts.
 */
import type * as T from "../../core/types";
import { readSnapshot, type Snapshot } from "../../core/git/snapshot";
import { hashObject, utf8 } from "../../core/git/objects";
import { buildImportGraph } from "../../core/analysis/graph";
import { isAnalyzable, pathAliasesOf } from "../../core/analysis/symbols";
import { isProbablyText } from "../../core/text/diff";
import { MAX_CARRY_FILE_BYTES, overSize, type NotCarried } from "../../core/land/carry";
import { MAX_TEXT_BYTES, MAX_TEXT_FILES, textEligible } from "../../core/repo-rules";
import { type PackFile } from "../../drydock/drydock";
import { fileNodes, symbolIndex, type AttemptView, type MainView, type TreeText } from "../views";
import { BOM, MAX_TEST_TREE_BYTES, MAX_TEST_TREE_READS, READER_CACHE_BYTES, SIZE_READS } from "../support/constants";
import type { BlobReader } from "../support/types";
import { HarborRecords } from "./records";

export abstract class HarborFiles extends HarborRecords {
  // ───── Reading blobs and text ─────

  protected async readText(repo: string, sha: string): Promise<string | null> {
    const cached = this.db.getBlobText(sha);
    if (cached) return cached.text;
    const bytes = await this.backend.readBlob(repo, sha);
    if (!bytes) return null;
    // Very large files stay opaque: agents do not edit them through gitring, and SQLite rows stay small.
    const text = bytes.length <= MAX_TEXT_BYTES && isProbablyText(bytes) ? utf8.decode(bytes) : null;
    this.db.putBlobText(sha, text);
    return text;
  }

  /** Blob ids → how the text that gitring holds gives the blob: as it is, with a byte order mark first, or not at all. */
  protected exactBlobs = new Map<string, "same" | "bom" | "no">();
  /** Blob ids → size in bytes, for blobs that gitring read for a merge. */
  protected blobSizes = new Map<string, number>();

  /**
   * The text of the blob `sha` that gives exactly its bytes again as UTF-8, from `text` (the text that gitring
   * holds), or null. The text that gitring reads has no byte order mark: a blob with one gets it back here.
   * Latin-1 text, for example, gives null.
   */
  protected async exactText(sha: string, text: string): Promise<string | null> {
    let how = this.exactBlobs.get(sha);
    if (how === undefined) {
      how = (await hashObject("blob", utf8.encode(text))) === sha ? "same" : (await hashObject("blob", utf8.encode(`${BOM}${text}`))) === sha ? "bom" : "no";
      if (this.exactBlobs.size > 20_000) this.exactBlobs.clear();
      this.exactBlobs.set(sha, how);
    }
    return how === "same" ? text : how === "bom" ? `${BOM}${text}` : null;
  }

  // ───── Blob readers for a merge ─────

  /**
   * Blob reads for a merge, a re-plot or the test container. Text comes from what gitring holds (text that
   * only gitring has, the text trees it read, `known` contents), then from the repositories in order. Text is
   * given only when it is exactly the blob, so gitring never changes the bytes of a file that it carries:
   * any other blob goes as bytes. `knownText` never reads a repository (it reads the blob store of the object).
   */
  protected blobReader(o: { trees: TreeText[]; repos: string[]; textBlobs?: Map<string, string>; known?: Map<string, string | Uint8Array>; texts?: [string, string][] }): BlobReader {
    const index = new Map<string, string>(o.texts ?? []);
    for (const t of o.trees) {
      for (const [path, e] of t.snapshot) {
        const text = t.text.get(path);
        if (text !== undefined && !index.has(e.sha)) index.set(e.sha, text);
      }
    }
    const repos = [...new Set(o.repos)];
    // Bytes that this reader read once (a merge reads a blob for its size, then for the commit).
    const cache = new Map<string, Uint8Array>();
    let cached = 0;
    const knownText = async (sha: string): Promise<string | null | undefined> => {
      const own = o.textBlobs?.get(sha);
      if (own !== undefined) return own;
      const k = o.known?.get(sha);
      if (k !== undefined) return typeof k === "string" ? k : null;
      let text = index.get(sha);
      if (text === undefined) {
        // A blob that gitring read before (in this project object's store): no repository read.
        const stored = this.db.getBlobText(sha);
        if (!stored) return undefined;
        if (stored.text === null) return null;
        text = stored.text;
      }
      return this.exactText(sha, text);
    };
    const readBytes = async (sha: string): Promise<Uint8Array | null> => {
      const own = o.textBlobs?.get(sha);
      if (own !== undefined) return utf8.encode(own);
      const k = o.known?.get(sha);
      if (k !== undefined) return typeof k === "string" ? utf8.encode(k) : k;
      const hit = cache.get(sha);
      if (hit) return hit;
      for (const repo of repos) {
        const bytes = await this.backend.readBlob(repo, sha).catch(() => null);
        if (!bytes) continue;
        // Keep what readText keeps, so that the next merge or test run knows this blob without a read.
        if (!this.db.getBlobText(sha)) this.db.putBlobText(sha, bytes.length <= MAX_TEXT_BYTES && isProbablyText(bytes) ? utf8.decode(bytes) : null);
        this.blobSizes.set(sha, bytes.length);
        if (this.blobSizes.size > 20_000) this.blobSizes.clear();
        if (cached + bytes.length <= READER_CACHE_BYTES) {
          cache.set(sha, bytes);
          cached += bytes.length;
        }
        return bytes;
      }
      return null;
    };
    const readText = async (sha: string): Promise<string | null> => {
      const held = await knownText(sha);
      if (held !== undefined) return held;
      for (const repo of repos) {
        const text = await this.readText(repo, sha);
        if (text !== null) return this.exactText(sha, text);
      }
      return null;
    };
    return { readText, readBytes, knownText };
  }

  /** A blob reader for the tree of a work copy: its own text first, then its base, then the repositories. */
  protected async workReader(a: T.Attempt, view: AttemptView, more: TreeText[] = []): Promise<BlobReader> {
    const p = this.requireProject();
    const base = await this.treeText(p.repo.name, a.baseTree);
    const texts: [string, string][] = [];
    for (const c of view.changed) {
      const e = view.snapshot.get(c.path);
      if (c.head !== null && e) texts.push([e.sha, c.head]);
    }
    return this.blobReader({ trees: [base, ...more], repos: [view.repo, p.repo.name], textBlobs: view.textBlobs, texts });
  }

  /**
   * Changes of the work that are too large to carry (see overSize): the size of each changed file without
   * text. A mode change counts too, because the merge writes the bytes of the file again.
   */
  protected async largeChanges(view: AttemptView, reader: BlobReader): Promise<NotCarried[]> {
    const sized = view.opaque.filter((c) => c.status !== "D" && c.newSha && c.mode !== "160000");
    const sizes: { path: string; bytes: number }[] = [];
    for (let i = 0; i < sized.length; i += SIZE_READS) {
      await Promise.all(
        sized.slice(i, i + SIZE_READS).map(async (c) => {
          sizes.push({ path: c.path, bytes: this.blobSizes.get(c.newSha!) ?? (await reader.readBytes(c.newSha!))?.length ?? 0 });
        }),
      );
    }
    return overSize(sizes);
  }

  // ───── Trees and the view of main ─────

  /**
   * The whole tree for the test container: text files as text, the other files as bytes, with their git modes.
   * A file larger than MAX_CARRY_FILE_BYTES, and files past the limits of the test tree, stay out (`left`).
   */
  protected async fullTree(snapshot: Snapshot, reader: BlobReader): Promise<{ files: Map<string, PackFile>; left: string[] }> {
    const files = new Map<string, PackFile>();
    const left: string[] = [];
    // Text that gitring holds first; the other files are read from the repositories, a few at a time.
    const blobs: [string, { sha: string; mode: string }][] = [];
    const entries = [...snapshot].filter(([, e]) => e.mode !== "160000");
    for (let i = 0; i < entries.length; i += 64) {
      await Promise.all(
        entries.slice(i, i + 64).map(async ([path, e]) => {
          const text = await reader.knownText(e.sha);
          if (typeof text === "string") files.set(path, { content: text, mode: e.mode });
          else blobs.push([path, e]);
        }),
      );
    }
    blobs.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    let bytes = 0;
    for (let i = 0; i < blobs.length; i += SIZE_READS) {
      await Promise.all(
        blobs.slice(i, i + SIZE_READS).map(async ([path, e], j) => {
          const size = this.blobSizes.get(e.sha);
          if (i + j >= MAX_TEST_TREE_READS || (size !== undefined && (size > MAX_CARRY_FILE_BYTES || bytes + size > MAX_TEST_TREE_BYTES))) {
            left.push(path);
            return;
          }
          const content = await reader.readBytes(e.sha);
          if (!content || content.length > MAX_CARRY_FILE_BYTES || bytes + content.length > MAX_TEST_TREE_BYTES) {
            left.push(path);
            return;
          }
          bytes += content.length;
          files.set(path, { content, mode: e.mode });
        }),
      );
    }
    return { files, left: left.sort() };
  }

  /** Snapshot + text of a tree (cached forever: trees are content-addressed). */
  protected treeText(repo: string, tree: string): Promise<TreeText> {
    let p = this.treeTexts.get(tree);
    if (!p) {
      p = (async () => {
        const snapshot = await readSnapshot(this.backend, repo, tree, this.treeCache);
        const text = new Map<string, string>();
        const entries = [...snapshot.entries()].filter(([path]) => textEligible(path)).slice(0, MAX_TEXT_FILES);
        for (let i = 0; i < entries.length; i += 24) {
          await Promise.all(
            entries.slice(i, i + 24).map(async ([path, e]) => {
              const t = await this.readText(repo, e.sha);
              if (t !== null) text.set(path, t);
            }),
          );
        }
        return { tree, snapshot, text };
      })();
      p.catch(() => this.treeTexts.delete(tree));
      this.treeTexts.set(tree, p);
      if (this.treeTexts.size > 64) this.treeTexts.delete(this.treeTexts.keys().next().value!);
    }
    return p;
  }

  protected async loadMain(): Promise<MainView> {
    const p = this.requireProject();
    if (p.importing) throw new Error(p.importing.error ? `The import failed: ${p.importing.error}` : "The repository import is not done. Try again in a minute.");
    if (this.mainView && this.mainView.sha === p.mainSha) return this.mainView;
    if (this.mainLoading) return this.mainLoading;
    this.mainLoading = (async () => {
      const tt = await this.treeText(p.repo.name, p.mainTree);
      const analyzable = new Map([...tt.text].filter(([path]) => isAnalyzable(path)));
      const aliases = pathAliasesOf(tt.text);
      const graph = buildImportGraph(analyzable, aliases);
      const index = symbolIndex(analyzable);
      const view: MainView = {
        ...tt,
        sha: p.mainSha,
        files: fileNodes(tt.snapshot, tt.text),
        graph,
        imports: graph.edges.map(([a, b]) => [a, b] as [string, string]),
        signatures: index.signatures,
        definedIn: index.definedIn,
        ...(aliases ? { aliases } : {}),
      };
      this.mainView = view;
      return view;
    })().finally(() => {
      this.mainLoading = undefined;
    });
    return this.mainLoading;
  }
}
