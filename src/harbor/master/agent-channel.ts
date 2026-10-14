/**
 * The agent channel: new change requests, the wait tool, and the Claude Code hook.
 * Layer 25 of the chain in master/README.md. Extends HarborSettings (settings.ts).
 * A work copy of another person must not lose its change requests to a read of an owner.
 * Read next: ../harbor.ts.
 */
import type * as T from "../../core/types";
import { ACTIVE, WAITING } from "../views";
import { TERMINAL } from "../support/constants";
import { normDir, normPath } from "../support/helpers";
import type { CallInfo } from "../support/types";
import { WAIT_GATHER_MS, WAIT_SECONDS, requestEvent, statusEvent, waitStatusWord } from "../support/words";
import { HarborSettings } from "./settings";

export abstract class HarborAgentChannel extends HarborSettings {
  // ───── Change requests and waiting ─────

  /**
   * The new change requests of a work copy, for the answer of a tool that does not deliver them itself
   * (MCP gitring_read, gitring_list, gitring_traffic, gitring_check, gitring_update). Only the person who sent
   * the agent gets them. Another member gets null: a read of another person must not take them from the agent.
   */
  async news(attemptId: string, call: CallInfo = {}): Promise<T.Clearance | null> {
    const a = this.attempts.get(attemptId);
    if (!a || !this.sentBy(a, call.viewer)) return null;
    return this.clearanceFor(a.id);
  }

  /**
   * MCP gitring_wait: wait until something new reaches the work copy (a change request, a move of main, the
   * answer of a person, a new status), or until the time runs out (default 25 s, at most 50 s). A change request
   * that waits already, or a work copy that is over, answers at once.
   */
  async wait(attemptId: string, opts: CallInfo & { seconds?: number } = {}): Promise<T.WaitResult> {
    const a = this.mustAttempt(attemptId);
    this.mayChange(a, opts.viewer);
    // An owner who did not send the agent can wait too, but the change requests stay for the agent.
    const mine = this.sentBy(a, opts.viewer);
    if (mine) this.heard(a);
    const asked = Number(opts.seconds ?? WAIT_SECONDS.default);
    const seconds = Number.isFinite(asked) ? Math.max(0, Math.min(WAIT_SECONDS.max, asked)) : WAIT_SECONDS.default;
    const ready = TERMINAL.has(a.status) || (mine && a.corrections.some((id) => this.corrections.get(id)?.status === "pending"));
    const heardOf = ready || !seconds ? [] : await this.waitFor(a, seconds * 1000);
    const now = this.mustAttempt(attemptId);
    const clr = this.clearanceFor(now.id, mine);
    // The change requests of the answer are the news: also those that waited before the call, and not those that changed again.
    const events = mine ? [...heardOf.filter((e) => e.kind !== "change-request"), ...clr.corrections.map((n) => requestEvent(n.id, n.kind))] : heardOf;
    if (ready && TERMINAL.has(now.status)) events.push(statusEvent(now.status));
    return { attemptId, status: now.status, events, clearance: clr, message: this.waitMessage(now, events, clr) };
  }

  protected waitFor(a: T.Attempt, ms: number): Promise<T.WaitEvent[]> {
    return new Promise((resolve) => {
      const events: T.WaitEvent[] = [];
      const set = this.waiters.get(a.id) ?? new Set<(ev: T.WaitEvent) => void>();
      this.waiters.set(a.id, set);
      if (!this.waitSeen.has(a.id)) this.waitSeen.set(a.id, { status: a.status, approval: a.approval?.status });
      let gather: ReturnType<typeof setTimeout> | undefined;
      const end = () => {
        clearTimeout(timer);
        if (gather) clearTimeout(gather);
        set.delete(on);
        if (!set.size) {
          this.waiters.delete(a.id);
          this.waitSeen.delete(a.id);
        }
        resolve(events);
      };
      // The events of one step come together (a send-back is a new status and a change request).
      const on = (ev: T.WaitEvent) => {
        events.push(ev);
        gather ??= setTimeout(end, WAIT_GATHER_MS);
      };
      set.add(on);
      const timer = setTimeout(end, ms);
    });
  }

  /** What an agent that waited does now. */
  protected waitMessage(a: T.Attempt, events: T.WaitEvent[], clr: T.Clearance): string {
    if (a.status === "landed") return "The work merged. The task is done.";
    if (TERMINAL.has(a.status)) return `The work copy is ${waitStatusWord(a.status)}. ${this.overAdvice(a)}`;
    if (clr.corrections.length) return clr.advice;
    if (a.approval?.status === "waiting" && a.status === "ready") return `${this.waitingMessage(a)} Call gitring_wait again to wait for the answer.`;
    if (!events.length) return `No news. The work copy is ${waitStatusWord(a.status)}. Call gitring_wait again, or continue your work.`;
    if (events.some((e) => e.kind === "main-moved") && !WAITING.has(a.status)) return "Main moved. Call gitring_update before you change files that the merge changed. Continue your work.";
    return `The work copy is ${waitStatusWord(a.status)}. ${WAITING.has(a.status) ? "Call gitring_wait again to wait for the merge." : "Continue your work."}`;
  }

  // ───── Claude Code hook ─────

  /**
   * PostToolUse hook from Claude Code. The agent's checkout identifies its attempt by the fork remote
   * (git mode) or by an attempt id the agent wrote into GITRING_ATTEMPT. Returns pending corrections
   * as additional context, so the agent sees them mid-task without a stop. `call.viewer`: the person of the key.
   * The hook of another person (not the sender, not an owner) changes nothing and gets nothing.
   */
  async claudeHook(input: {
    cwd?: string;
    session_id?: string;
    tool_name?: string;
    tool_input?: { file_path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean; edits?: { old_string: string; new_string: string; replace_all?: boolean }[] };
    attemptId?: string;
  }, call: CallInfo = {}): Promise<{ hookSpecificOutput?: { hookEventName: "PostToolUse"; additionalContext: string } }> {
    let attempt: T.Attempt | undefined = input.attemptId ? this.attempts.get(input.attemptId) : undefined;
    const cwd = input.cwd ? normDir(input.cwd) : undefined;
    if (!attempt && cwd) {
      // The agent's working copy (or a parent of it) was registered at declare time.
      let dir = cwd;
      for (let i = 0; i < 6 && dir && !attempt; i++) {
        const id = this.db.hook(`cwd:${dir}`);
        if (id) attempt = this.attempts.get(id);
        dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      }
    }
    if (!attempt && input.session_id) {
      const id = this.db.hook(`session:${input.session_id}`);
      if (id) attempt = this.attempts.get(id);
    }
    if (!attempt || !ACTIVE.has(attempt.status) || !this.mayAct(attempt, call.viewer)) return {};
    if (input.session_id) this.db.setHook(`session:${input.session_id}`, attempt.id);

    const abs = input.tool_input?.file_path;
    if (abs && /^(Write|Edit|MultiEdit)$/.test(input.tool_name ?? "")) {
      // An edit is an answer of the agent: work that came back to it does not go to another agent now.
      this.heard(attempt);
      const rel = normPath(cwd && abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs.replace(/^.*?\/((src|tests|harness)\/)/, "$1"));
      const view = await this.attemptView(attempt);
      let next: string | undefined;
      if (input.tool_name === "Write" && typeof input.tool_input?.content === "string") next = input.tool_input.content;
      else {
        let cur = view.files.get(rel);
        const edits = input.tool_input?.edits ?? (input.tool_input?.old_string !== undefined ? [{ old_string: input.tool_input.old_string, new_string: input.tool_input.new_string ?? "", replace_all: input.tool_input.replace_all }] : []);
        if (cur !== undefined) {
          for (const e of edits) cur = e.replace_all ? cur.split(e.old_string).join(e.new_string) : cur.replace(e.old_string, e.new_string);
          next = cur;
        }
      }
      let refused: string | undefined;
      if (next !== undefined && attempt.mode === "api" && input.tool_name === "Write") {
        // A full-file write from the agent's own copy: guard it like gitring_write (main may have moved).
        const g = this.guardWrite(attempt, rel, next, view.files.get(rel) ?? null);
        if (g.refused) refused = g.refused;
        else this.db.writeWorktree(attempt.id, rel, g.content);
        this.db.setSeen(attempt.id, rel, next);
      } else if (next !== undefined) this.db.writeWorktree(attempt.id, rel, next);
      if (refused) {
        return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `GITRING: ${refused}` } };
      }
      if (!attempt.course.files.includes(rel)) attempt.course.files = [...attempt.course.files, rel];
      if (attempt.status === "declared") attempt.status = "underway";
      await this.refreshFootprint(attempt);
      this.putAttempt(attempt);
      this.addLog({ kind: "write", attemptId: attempt.id, agentId: attempt.agentId, intentId: attempt.intentId, message: `${this.callsign(attempt.id)} edits ${rel} (Claude Code hook).`, files: [rel] });
      await this.courseCheck(attempt.id, "write");
    }
    const clr = this.clearanceFor(attempt.id);
    if (!clr.corrections.length) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: [
          "GITRING CHANGE REQUEST — apply it in your next edits, then call gitring_ack. Continue your work.",
          ...clr.corrections.map((c) => `- [${c.id}] ${c.message}`),
        ].join("\n"),
      },
    };
  }
}
