/**
 * Builds the view of one work copy (its files and real changes) and keeps the approval hash of its changes.
 * Layer 4 of the chain in master/README.md. Extends HarborFiles (files.ts).
 * A view is cached by the version of the work copy. Call bump when a work copy changes its files.
 * Read next: live.ts.
 */
import type * as T from "../../core/types";
import { sha256Hex } from "../../directory/crypto";
import { changeMeaning } from "../../core/analysis/meaning";
import { diffSnapshots } from "../../core/git/snapshot";
import { hashObjectSync, utf8 } from "../../core/git/objects";
import type { FootprintOptions } from "../../core/analysis/footprint";
import { planCarry, type NotCarried } from "../../core/land/carry";
import { changedVersions, footprintOf, knownMemberOf, opaqueChanges, overlayFiles, overlaySnapshot, contributionRows, type AttemptView } from "../views";
import { TERMINAL, TEXT_ID_CHARS } from "../support/constants";
import { DIGEST_V2, legacyDigest } from "../support/digest";
import { HarborFiles } from "./files";

export abstract class HarborWorkViews extends HarborFiles {
  // ───── Views of work copies ─────

  /**
   * Files, changes and signatures of an attempt (cached per content version, base and head). Calls that come
   * while the view is made wait for the same view: they do not make it again.
   */
  protected attemptView(a: T.Attempt): Promise<AttemptView> {
    const version = this.attemptVersion.get(a.id) ?? 0;
    const key = `${version}:${a.baseTree}:${a.headSha ?? ""}`;
    const cached = this.attemptViews.get(a.id);
    if (cached && cached.key === key) return Promise.resolve(cached.view);
    const loading = this.attemptViewLoads.get(a.id);
    if (loading && loading.key === key) return loading.view;
    const view = this.makeAttemptView(a, version, key).finally(() => {
      if (this.attemptViewLoads.get(a.id)?.view === view) this.attemptViewLoads.delete(a.id);
    });
    this.attemptViewLoads.set(a.id, { key, view });
    return view;
  }

  /**
   * Blob id of a text, at once: a view of a work copy must not wait for WebCrypto, or many calls wait for the
   * same view. A view hashes the same written files again and again, so the ids stay cached.
   */
  protected textBlobId(text: string): string {
    const hit = this.textIds.get(text);
    if (hit) return hit;
    const sha = hashObjectSync("blob", utf8.encode(text));
    if (this.textIdChars + text.length > TEXT_ID_CHARS) {
      this.textIds.clear();
      this.textIdChars = 0;
    }
    this.textIds.set(text, sha);
    this.textIdChars += text.length;
    return sha;
  }

  protected async makeAttemptView(a: T.Attempt, version: number, key: string): Promise<AttemptView> {
    const p = this.requireProject();
    const headSha = a.headSha;
    const base = await this.treeText(p.repo.name, a.baseTree);
    // The tree that the work starts from: the last push in git mode, else the base.
    let tt = base;
    let repo = p.repo.name;
    if (a.mode === "git") {
      const head = headSha ? await this.backend.readCommit(a.fork.repo, headSha) : null;
      if (head) {
        tt = await this.treeText(a.fork.repo, head.treeHash);
        repo = a.fork.repo;
      }
    }
    // Text on top: shadow edits (from the Claude Code hook) on the last push, or the written files of api mode.
    const overlay = this.db.worktree(a.id);
    const files = overlayFiles(tt.text, overlay);
    const { snapshot: real, textBlobs } = await overlaySnapshot(tt.snapshot, overlay, (text) => this.textBlobId(text));
    // What merges: every real change, with a few parts left out (and named to the agent).
    const plan = planCarry(base.snapshot, real, new Set(overlay.keys()));
    const paths = diffSnapshots(base.snapshot, plan.work).map((c) => c.path);
    const changed = changedVersions(base.text, files, paths, { base: base.snapshot, head: plan.work });
    const opaque = opaqueChanges(base.snapshot, plan.work, changed);
    const { signatures, imports } = footprintOf(changed, new Set(files.keys()), this.footprintOptions());
    const view: AttemptView = { version, files, changed, signatures, imports, snapshot: plan.work, repo, textBlobs, opaque, notCarried: plan.notCarried };
    this.attemptViews.set(a.id, { key, view });
    return view;
  }

  /** The parts of the work of a work copy that do not merge, and why. */
  protected async leftOut(a: T.Attempt): Promise<NotCarried[]> {
    const view = await this.attemptView(a);
    if (!view.opaque.length) return view.notCarried;
    return [...view.notCarried, ...(await this.largeChanges(view, await this.workReader(a, view)))];
  }

  /** What a footprint knows from main: the path aliases, and the members of classes and objects. */
  protected footprintOptions(): FootprintOptions {
    const main = this.mainView;
    return main ? { aliases: main.aliases, knownMember: knownMemberOf(main.definedIn) } : {};
  }

  /** Check files are written by gitring, not by agents: they never count as a collision. */
  protected checkPaths(): Set<string> {
    return new Set([...this.intents.values()].flatMap((i) => i.checks.map((c) => c.path)));
  }

  // ───── Real changes ─────

  protected async refreshFootprint(a: T.Attempt): Promise<AttemptView> {
    this.bump(a.id);
    // The footprint reads the aliases and the members of main (see footprintOptions).
    if (!this.mainView) await this.loadMain().catch(() => undefined);
    const view = await this.attemptView(a);
    const managed = this.checkPaths();
    const own = view.changed.filter((c) => !managed.has(c.path));
    const { footprint } = footprintOf(own, new Set(view.files.keys()), this.footprintOptions());
    a.footprint = footprint;
    a.meaning = changeMeaning(own, view.opaque.map((c) => c.path));
    let additions = 0;
    let deletions = 0;
    for (const t of Object.values(footprint.files)) {
      additions += t.additions;
      deletions += t.deletions;
    }
    a.stats = { ...a.stats, filesChanged: Object.keys(footprint.files).length + view.opaque.length, additions, deletions };
    await this.withdrawIfChanged(a, view);
    return view;
  }

  // ───── The approval hash ─────

  /**
   * A hash of what a person approves: the agent's own contribution (the removed and added lines of each change
   * block, whole files that it adds or deletes, binary files and modes), without the base and without line
   * numbers. When main moves, or gitring merges main into the work, and the agent changes nothing, the answer
   * still counts. Any change by the agent changes the hash.
   */
  protected async digestOf(a: T.Attempt, view?: AttemptView): Promise<string> {
    const v = view ?? (await this.attemptView(a));
    const digest = `${DIGEST_V2}${await sha256Hex(contributionRows(v.changed, v.opaque).join("\n"))}`;
    // A question from an older version holds the hash of whole files. When it still names this work, it takes the new hash.
    const ap = a.approval;
    if (ap?.digest && !ap.digest.startsWith(DIGEST_V2) && ap.digest === (await legacyDigest(v))) {
      ap.digest = digest;
      this.db.putAttempt(a);
    }
    return digest;
  }

  /** The agent changed the work after a person was asked, or after the yes: that answer does not count for the new work. */
  protected async withdrawIfChanged(a: T.Attempt, view: AttemptView): Promise<void> {
    const ap = a.approval;
    if (!ap || !ap.digest || (ap.status !== "waiting" && ap.status !== "approved") || TERMINAL.has(a.status)) return;
    if ((await this.digestOf(a, view)) === ap.digest) return;
    if (ap.status === "approved") a.approval = { ...ap, status: "withdrawn", closed: "The agent changed the work after the yes." };
    if (a.status === "ready") a.status = "underway";
    // A question that waits closes in putAttempt, because the work copy is not "ready" any more.
    this.putAttempt(a);
  }

  // ───── Test settings ─────

  protected testPaths(files: Map<string, string>): string[] {
    return [...files.keys()].filter((p) => /^tests\/.+\.test\.(js|mjs)$/.test(p)).sort();
  }

  /** The project's check runner (absent settings: the gitring harness in a Dynamic Worker). */
  protected checkSettings(): T.CheckSettings {
    return this.requireProject().settings.checks ?? { runner: "worker" };
  }
}
