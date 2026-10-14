/**
 * Reads and changes the settings of a project, and keeps the secrets of its webhooks.
 * Layer 24 of the chain in master/README.md. Extends HarborDecisions (decisions.ts).
 * Only an owner changes settings. The Worker checks the role before it calls this layer.
 * Read next: agent-channel.ts.
 */
import type * as T from "../../core/types";
import { withDefaults } from "../../core/types";
import { seal } from "../../directory/crypto";
import { newWebhookSecret, SECRET_SEAL, secretHint } from "../webhooks";
import { sanitizeSettings } from "../support/settings-rules";
import type { MainTests } from "../support/types";
import { HarborDecisions } from "./decisions";

export abstract class HarborSettings extends HarborDecisions {
  async settings(): Promise<T.ProjectSettings> {
    return this.requireProject().settings;
  }

  async updateSettings(raw: Partial<T.ProjectSettings>): Promise<T.SettingsAnswer> {
    const patch = sanitizeSettings(raw, this.allowedModels());
    // Webhook secrets: the new ones go into this answer only (shown once in Settings).
    let webhookSecrets: Record<string, string> | undefined;
    if (patch.webhooks) {
      const made = await this.webhookSecrets(patch.webhooks, raw.webhooks);
      patch.webhooks = made.list;
      if (Object.keys(made.shown).length) webhookSecrets = made.shown;
    }
    // The project after the wait above (from here to the save, nothing waits).
    const p = this.requireProject();
    const oldGithub = p.settings.github;
    // GitHub settings merge: a field that the patch leaves out keeps its value; repo "" unlinks.
    const rawG = raw.github && typeof raw.github === "object" ? (raw.github as unknown as Record<string, unknown>) : undefined;
    if (rawG && patch.github) {
      const pg = patch.github;
      patch.github = {
        mode: "mode" in rawG ? pg.mode : oldGithub.mode,
        branch: "branch" in rawG ? pg.branch : oldGithub.branch,
        ...("repo" in rawG ? (pg.repo ? { repo: pg.repo } : {}) : oldGithub.repo ? { repo: oldGithub.repo } : {}),
        ...("base" in rawG ? (pg.base ? { base: pg.base } : {}) : oldGithub.base ? { base: oldGithub.base } : {}),
      };
    }
    const testsBefore = p.settings.testsWhen;
    p.settings = withDefaults({ ...p.settings, ...patch, thresholds: { ...p.settings.thresholds, ...(patch.thresholds ?? {}) } });
    // Someone chose the tests: a later guess (after an import or a push) does not change them.
    if (patch.checks) this.db.setMeta("checksSet", true);
    // Tests after the merge start here: the main of this moment counts as the last main that passed.
    if (p.settings.testsWhen === "after" && testsBefore !== "after") {
      const st = this.db.getMeta<MainTests>("mainTests") ?? {};
      this.db.setMeta("mainTests", { ...st, lastGreen: p.mainSha, tested: p.mainSha, retryAt: undefined } satisfies MainTests);
    }
    const g = p.settings.github;
    const githubChanged = Boolean(patch.github) && (g.repo !== oldGithub.repo || g.mode !== oldGithub.mode || g.branch !== oldGithub.branch || g.base !== oldGithub.base);
    if (patch.github && g.repo?.toLowerCase() !== oldGithub.repo?.toLowerCase()) {
      // Another repository (or none): its state stays apart (per repository); the old conflict task stops.
      if (oldGithub.repo) this.closeConflictTask(oldGithub.repo, "The project links another GitHub repository now.");
      p.github = undefined;
      this.ctx.waitUntil(this.directory().githubLink(p.id, g.repo ?? null).catch(() => undefined));
    }
    this.db.setMeta("project", p);
    this.addLog({ kind: "system", message: `Settings change: ${Object.keys(patch).join(", ")}.` });
    // The steward turned on: its first sweep comes with the next alarm.
    if (patch.steward) await this.armSteward();
    if (githubChanged) {
      if (g.mode !== "off" && g.repo) this.ctx.waitUntil(this.githubSync().catch((e) => console.warn("github sync failed", String(e))));
      else this.setGithub(await this.githubStatus());
    }
    return webhookSecrets ? { ...p.settings, webhookSecrets } : p.settings;
  }

  /**
   * The signing secrets of a new webhook list. A webhook gets a new secret when it is new, when its URL
   * changes, or when the person asks for one (`newSecret`). The answer holds each new secret once; the
   * project keeps it sealed. Secrets of removed webhooks go.
   */
  protected async webhookSecrets(next: T.WebhookTarget[], raw: unknown): Promise<{ list: T.WebhookTarget[]; shown: Record<string, string> }> {
    const asked = new Set(
      (Array.isArray(raw) ? (raw as T.WebhookInput[]) : []).filter((w) => w && w.newSecret === true && typeof w.id === "string").map((w) => w.id),
    );
    const wants = (w: T.WebhookTarget, old: T.WebhookTarget | undefined) => !old || old.url !== w.url || asked.has(w.id);
    // Seal a candidate secret for each webhook (at most 5) first. These are the only waits: another change of
    // the settings can come in between, so the choice below reads the settings after them.
    const key = this.env.GITRING_SECRET;
    const made = new Map<string, { secret: string; sealed: string }>();
    for (const w of key ? next : []) {
      const secret = newWebhookSecret();
      made.set(w.id, { secret, sealed: await seal(key!, secret, SECRET_SEAL) });
    }
    // No wait from here to the save of the settings: the stored secrets and the list change together.
    const before = new Map(this.requireProject().settings.webhooks.map((w) => [w.id, w]));
    const stored = this.db.getMeta<Record<string, string>>("webhookSecrets") ?? {};
    const shown: Record<string, string> = {};
    const kept: Record<string, string> = {};
    const list: T.WebhookTarget[] = [];
    for (const w of next) {
      const old = before.get(w.id);
      const { secretHint: _hint, ...plain } = w;
      const fresh = wants(w, old) ? made.get(w.id) : undefined;
      if (wants(w, old) && !fresh) throw new Error("gitring cannot make a secret for the webhook: the server has no GITRING_SECRET.");
      if (fresh) {
        shown[w.id] = fresh.secret;
        kept[w.id] = fresh.sealed;
        list.push({ ...plain, secretHint: secretHint(fresh.secret) });
      } else if (stored[w.id]) {
        kept[w.id] = stored[w.id];
        list.push({ ...plain, ...(old?.secretHint ? { secretHint: old.secretHint } : {}) });
      } else {
        list.push(plain);
      }
    }
    this.db.setMeta("webhookSecrets", Object.keys(kept).length ? kept : undefined);
    return { list, shown };
  }
}
