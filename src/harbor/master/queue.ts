/**
 * The merge queue: puts work copies in line, picks the next one, and starts a merge or a train.
 * Layer 21 of the chain in master/README.md. Extends HarborTrains (trains.ts).
 * A merge that no run finished starts again after the lease ends (see LANDING_LEASE_MS).
 * Read next: submit.ts.
 */
import type * as T from "../../core/types";
import { LANDING_LEASE_MS, MAX_LANDING_STARTS, TERMINAL } from "../support/constants";
import { errorLine, round } from "../support/helpers";
import type { LandingRun, MainTests } from "../support/types";
import { HarborTrains } from "./trains";

export abstract class HarborQueue extends HarborTrains {
  // ───── The queue ─────

  protected enqueueLanding(a: T.Attempt): void {
    // New work, or a yes of a person: the stops of an earlier merge do not count any more.
    if (a.mergeStops) {
      a.mergeStops = undefined;
      this.putAttempt(a);
    }
    this.db.enqueue(a.id, Date.now());
    void this.driveQueue();
  }

  /** Run the queue after the merge that runs now. One merge runs at a time. */
  protected driveQueue(): Promise<unknown> {
    const job = this.landingChain.then(() => this.processQueue());
    this.landingChain = job.catch((e) => console.error("landing failed", errorLine(e), e));
    this.ctx.waitUntil(this.landingChain);
    return this.landingChain;
  }

  /**
   * The queue and the marker of the merge in progress are in storage. An object that starts again after
   * an eviction or a crash runs what they hold, so a queued work copy does not wait for a request.
   */
  protected wakeQueue(): void {
    if (!this.project || this.project.importing) return;
    if (this.mainTestsDue()) this.scheduleMainTests();
    const stuck = [...this.attempts.values()].some((a) => a.status === "landing");
    if (!stuck && !this.db.queue().length && !this.db.getMeta<LandingRun>("landing")) return;
    void this.driveQueue();
  }

  /**
   * Merge the queued work copies: a train of independent work copies in one go when several are ready
   * (see core/land/train.ts), else one after the other. A work copy leaves the queue only when its merge
   * ends. A merge that a stopped object began (its marker is older than the lease) starts again.
   */
  protected async processQueue(): Promise<void> {
    if (!this.project || this.project.importing) return;
    // An older version of gitring dropped the queue entry when a merge began: a "landing" work copy without one is stuck.
    const queued = new Set(this.db.queue());
    for (const a of this.attempts.values()) {
      if (a.status === "landing" && !queued.has(a.id)) this.db.enqueue(a.id, Date.now());
    }
    for (let round = 0; round < 100; round++) {
      const next = this.pickLanding();
      if (!next) break;
      // A merge that starts again (a stopped run) goes alone: the record of what main holds comes first.
      const train = next.tries === 1 && next.attempt.status === "ready" ? await this.trainFor(next.attempt) : [next.attempt];
      if (train.length > 1) await this.runTrain(train, next.tries);
      else await this.runLanding(next.attempt, next.tries);
    }
    // The lease alarm of a merge that ended is not needed any more: the alarm goes to the next real wake time.
    const wakeAt = this.nextWake();
    if (wakeAt !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, wakeAt));
  }

  /** The earliest time that gitring must wake by itself: agents that wait for the AI budget, work given back, the merge queue. */
  protected nextWake(): number | undefined {
    const times = [
      ...[...this.attempts.values()].filter((a) => a.waitsForBudget && !TERMINAL.has(a.status)).map((a) => a.waitsForBudget!),
      ...[...this.attempts.values()].filter((a) => a.returned && !TERMINAL.has(a.status)).map((a) => a.returned!.until),
    ];
    const queueAt = this.queueWakeAt();
    if (queueAt !== undefined) times.push(queueAt);
    const stewardAt = this.stewardWakeAt();
    if (stewardAt !== undefined) times.push(stewardAt);
    const mainAt = this.db.getMeta<MainTests>("mainTests")?.retryAt;
    if (mainAt && mainAt > Date.now()) times.push(mainAt);
    return times.length ? Math.min(...times) : undefined;
  }

  /** The next queued merge that may start now, with the number of times it starts. */
  protected pickLanding(): { attempt: T.Attempt; tries: number } | undefined {
    const now = Date.now();
    const marker = this.db.getMeta<LandingRun>("landing");
    for (const id of this.db.queue()) {
      const a = this.attempts.get(id);
      if (!a || (a.status !== "ready" && a.status !== "landing")) {
        this.db.dequeue(id);
        if (marker?.id === id) this.db.setMeta("landing", undefined);
        continue;
      }
      if (!this.mayStartNow(a, marker, now)) continue;
      const held = marker && (marker.id === id || marker.train?.includes(id)) ? marker : undefined;
      return { attempt: a, tries: (held?.tries ?? 0) + 1 };
    }
    return undefined;
  }

  /** The next time a queued merge may start later than now: the end of a lease or of a wait for the test budget. */
  protected queueWakeAt(): number | undefined {
    const now = Date.now();
    const marker = this.db.getMeta<LandingRun>("landing");
    const queue = this.db.queue();
    const times: number[] = [];
    if (marker && queue.includes(marker.id)) times.push(marker.startedAt + LANDING_LEASE_MS);
    for (const id of queue) {
      const wait = this.attempts.get(id)?.mergeWait;
      if (wait) times.push(wait.until);
    }
    const later = times.filter((t) => t > now);
    return later.length ? Math.min(...later) : undefined;
  }

  // ───── Run one merge ─────

  /** Write the marker, merge, then clear the marker and the queue entry. A stop in between leaves both. */
  protected async runLanding(a: T.Attempt, tries: number): Promise<void> {
    if (tries > MAX_LANDING_STARTS) {
      await this.askAboutStoppedMerge(
        a,
        `The merge did not finish after ${MAX_LANDING_STARTS} tries. A yes starts it again.`,
        `The merge of the work of ${this.callsign(a.id)} did not finish after ${MAX_LANDING_STARTS} tries. A person must decide on "${this.intents.get(a.intentId)?.title ?? "this task"}".`,
      );
      return;
    }
    const startedAt = Date.now();
    this.db.setMeta("landing", { id: a.id, startedAt, boot: this.bootId, tries } satisfies LandingRun);
    // If this object stops, the alarm starts the merge again when the lease ends.
    await this.scheduleBudgetRetry(startedAt + LANDING_LEASE_MS);
    let outcome: "done" | "wait" = "done";
    try {
      outcome = await this.landOne(a);
    } catch (err) {
      console.error("landOne", a.id, errorLine(err), err);
      outcome = await this.mergeStopped(a, err);
    }
    this.db.setMeta("landing", undefined);
    // A merge that waits (for the test budget, or to try again after an error) stays in the queue.
    if (outcome !== "wait") this.db.dequeue(a.id);
  }
}
