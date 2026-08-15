import type { ApplicationRecord, PendingEntry } from "./store";

/**
 * Progress and statistics derived from the two stores. Nothing here is cached: the ledger is
 * ~280 KB and the queue ~440 KB, so a read per request is cheaper than any staleness bug.
 */

export interface Funnel {
  /** Jobs we have a record for at all. */
  engaged: number;
  /** Postings that turned out to be closed. */
  expired: number;
  /** Opened and filled, but stopped before Review. */
  blocked: number;
  /** Filled all the way to the Review step. */
  reachedReview: number;
  /** Waiting on a human decision right now. */
  awaitingApproval: number;
  /** The application actually went in. */
  submitted: number;
}

const SUBMITTED = new Set(["submitted", "already_applied_on_site"]);

export function funnel(apps: ApplicationRecord[], queue: PendingEntry[]): Funnel {
  const submitted = apps.filter((a) => SUBMITTED.has(a.status)).length;
  const expired = apps.filter((a) => a.status === "expired").length;
  const prefilled = apps.filter((a) => a.status === "prefilled_pending_submit").length;
  const awaiting = queue.filter((q) => q.status === "awaiting_approval").length;
  // A prefilled job that never made it into the queue is one that stopped short of Review.
  const queuedCodes = new Set(queue.map((q) => q.code).filter(Boolean));
  const blocked = apps.filter((a) => a.status === "prefilled_pending_submit" && !queuedCodes.has(a.code)).length;
  return {
    engaged: apps.length,
    expired,
    blocked,
    reachedReview: prefilled - blocked,
    awaitingApproval: awaiting,
    submitted,
  };
}

export function countBy<T>(items: T[], key: (item: T) => string | undefined): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** Why blocked jobs stopped — the histogram that tells you which answer to add next. */
export function blockedReasons(apps: ApplicationRecord[]): Array<{ name: string; count: number }> {
  const reasons: string[] = [];
  for (const a of apps) {
    for (const note of a.notes ?? []) {
      const m = /^blocked required: (.+)$/.exec(note) ?? /^blocked by empty required: (.+)$/.exec(note);
      if (m) reasons.push(...m[1].split(";").map((s) => s.trim()).filter(Boolean));
    }
  }
  return countBy(reasons, (r) => r.slice(0, 60));
}

/** Entries whose answers include an LLM draft — worth a human read before approving. */
export function draftCount(entry: PendingEntry): number {
  return (entry.answers ?? []).filter((a) => a.draft).length;
}

export interface DailyPoint {
  day: string;
  engaged: number;
  submitted: number;
}

/** Activity over the last N days, from firstSeenAt / updatedAt. */
export function daily(apps: ApplicationRecord[], days = 14): DailyPoint[] {
  const byDay = new Map<string, DailyPoint>();
  const dayOf = (iso?: string) => (iso ? iso.slice(0, 10) : null);
  for (const a of apps) {
    const seen = dayOf(a.firstSeenAt);
    if (seen) {
      const p = byDay.get(seen) ?? { day: seen, engaged: 0, submitted: 0 };
      p.engaged += 1;
      byDay.set(seen, p);
    }
    if (SUBMITTED.has(a.status)) {
      const done = dayOf(a.updatedAt);
      if (done) {
        const p = byDay.get(done) ?? { day: done, engaged: 0, submitted: 0 };
        p.submitted += 1;
        byDay.set(done, p);
      }
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-days);
}
