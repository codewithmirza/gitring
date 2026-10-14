/**
 * Decides when a person must say yes before a merge, asks the person, and words the question.
 * Layer 12 of the chain in master/README.md. Extends HarborProtocol (protocol.ts).
 * The answer of a person is in decisions.ts.
 * Read next: reads.ts.
 */
import type * as T from "../../core/types";
import { approvalNeeded, approvalPath, canDecide, riskSigns } from "../../core/approvals";
import { checkFolderRules } from "../../core/coord/folder-rules";
import { newId } from "../ids";
import type { CallInfo } from "../support/types";
import { HarborProtocol } from "./protocol";

export abstract class HarborApprovals extends HarborProtocol {
  /** Does this work need a person before it merges? The project setting, the signs of the change and the rivals decide. */
  protected async approvalFor(a: T.Attempt, f: { untested: boolean; competing: number; picked: boolean }): Promise<{ reason: T.ApprovalReason; why: string[]; ownerOnly?: boolean } | null> {
    const settings = this.requireProject().settings;
    // The rules by folder see every changed file, binary files included.
    const rules = checkFolderRules(settings.folderRules, Object.keys(a.meaning?.files ?? a.footprint.files), a.sender?.id);
    const need = approvalNeeded({ mode: settings.landing, untested: f.untested && !f.picked, competing: f.picked ? 0 : f.competing, signs: riskSigns(a), rules });
    if (!need) return null;
    // The same work that a person said yes to: no second question.
    if (a.approval?.status === "approved" && a.approval.digest && (await this.digestOf(a)) === a.approval.digest) return null;
    return need;
  }

  /** Ask a person to say yes. The work copy stays "ready" and does not merge until the answer comes. */
  protected async askApproval(a: T.Attempt, need: { reason: T.ApprovalReason; why: string[]; ownerOnly?: boolean }): Promise<T.Approval> {
    const approval: T.Approval = {
      id: newId("ap"),
      status: "waiting",
      reason: need.reason,
      why: need.why,
      digest: await this.digestOf(a),
      // A rule by folder asks for an owner: the sender of the agent is not the one who answers.
      ...(need.ownerOnly ? { ownerOnly: true } : a.sender ? { approver: a.sender } : {}),
      askedAt: Date.now(),
    };
    a.approval = approval;
    a.status = "ready";
    this.putAttempt(a);
    this.addLog({
      kind: "decision",
      attemptId: a.id,
      agentId: a.agentId,
      intentId: a.intentId,
      message: `gitring asks ${this.approverWords(approval)} to say yes to the work of ${this.callsign(a.id)}. ${need.why[0] ?? ""}`.trim(),
    });
    return approval;
  }

  protected approverWords(ap: Pick<T.Approval, "approver" | "ownerOnly">): string {
    if (ap.ownerOnly) return "An owner of the project";
    return ap.approver?.name ?? "A person of the project";
  }

  protected waitingMessage(a: T.Attempt): string {
    const ap = a.approval!;
    return `${ap.why[0] ?? "A person must decide."} ${this.approverWords(ap)} must say yes before this merges.`;
  }

  /** May the caller answer the question of this work copy? Only a question that waits has an answer for this. */
  protected mayAnswerOf(a: T.Attempt, viewer: CallInfo["viewer"]): { mayAnswer?: boolean } {
    if (!viewer || a.approval?.status !== "waiting") return {};
    return { mayAnswer: canDecide(a.approval, viewer, this.requireProject().settings.approver) };
  }

  /** The address where a person answers: in the gitring app. The Worker tells the object its own address when it can. */
  protected approvalLink(a: T.Attempt): string {
    const path = approvalPath(this.requireProject().id, a.id);
    const origin = this.db.getMeta<string>("origin");
    return origin ? `${origin}${path}` : path;
  }

  /** The address of this deployment (from a request), for links in webhooks and answers. Only https (or local http) counts. */
  rememberOrigin(origin?: string): void {
    if (!origin || !/^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin)) return;
    if (this.db.getMeta<string>("origin") !== origin) this.db.setMeta("origin", origin);
  }

  /** True when a human picked this attempt or the attempt it was re-derived from. */
  protected pickedLineage(a: T.Attempt): boolean {
    const latest = [...this.decisions].reverse().find((d) => d.kind === "pick" && d.intentId === a.intentId);
    if (!latest) return false;
    let cur: T.Attempt | undefined = a;
    for (let i = 0; cur && i < 6; i++) {
      if (cur.id === latest.attemptIds[0]) return true;
      cur = cur.lineage.rederivedFrom ? this.attempts.get(cur.lineage.rederivedFrom) : undefined;
    }
    return false;
  }
}
