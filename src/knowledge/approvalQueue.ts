import fs from "node:fs/promises";
import type { DocumentUploads } from "../agent/types.js";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { writeJsonAtomic } from "../utils/atomicWrite.js";
import type { FilledAnswer } from "../agent/types.js";

const QUEUE_PATH = path.join(DATA_DIR, "pending-approvals.json");

/**
 * "submitting" is a write-ahead marker: set immediately BEFORE a submit is attempted
 * and replaced by the real outcome after. If a run dies mid-submit, the entry is left
 * in this state — and because listAwaiting() only returns "awaiting_approval", it is
 * never picked up and re-submitted automatically. An entry still "submitting" on a
 * later poll means "we clicked, but never recorded the result": a human must confirm
 * on the ATS before it moves on. This is the guard against double submission.
 */
/**
 * "manual_submitted" means the user filled and submitted the application THEMSELVES on the
 * ATS. It is deliberately not "skipped": a skip means no application exists, while this one
 * went in and must never be re-opened, re-filled or re-submitted. Recording it as a skip is
 * how a live application gets applied for a second time on the next sweep.
 */
export type PendingStatus = "awaiting_approval" | "submitting" | "submitted" | "manual_submitted" | "skipped" | "error";

/**
 * Queue statuses that mean the application WENT IN — by us or by hand.
 *
 * A set rather than a literal comparison at each site: the guards that read it are spread
 * across the worker and the submit path, and adding a status without finding all of them is
 * exactly how one of them would keep saying "not submitted yet".
 */
const SUBMITTED: ReadonlySet<PendingStatus> = new Set<PendingStatus>(["submitted", "manual_submitted"]);

/** Is this entry finished — submitted by us, or by hand on the ATS? */
export function isSubmittedStatus(status: PendingStatus | undefined): boolean {
  return !!status && SUBMITTED.has(status);
}

/**
 * One application that reached Review and is waiting for the user's emailed
 * APPROVE/SKIP reply. Approval can take days, so this is persisted and processed
 * later by the Phase-B poller — the fill run does NOT block on it.
 */
export interface PendingEntry {
  key: string; // primary key: job code, else identity key
  code?: string;
  identityKey: string;
  externalJobId?: string; // the ATS's id for this listing
  companyReqId?: string; // the employer's own requisition id — matches across ATS
  ats: string;
  company: string;
  title: string;
  applyUrl: string;
  location?: string;
  region?: string;
  resumeName?: string;
  resumeStandard?: boolean;
  jobDescription?: string;
  filledFields: string[];
  /**
   * What the form ASKED for and what went in. Recorded so the readiness check can see a required
   * upload that never happened: read() excludes file inputs, so nothing else on the entry can.
   *
   * It was already being passed in by applyJob and silently dropped here, which is why every entry
   * in the queue reads `undefined` and why two applications sat in "ready for review" with a
   * required transcript missing.
   */
  documents?: DocumentUploads;
  answers?: FilledAnswer[]; // structured answers to replay on submit (== what was approved)
  reviewSentAt: string; // ISO
  updatedAt: string; // ISO
  status: PendingStatus;
  attempts: number; // Phase-B submit attempts
  lastError?: string;
  /** Set when answers were edited in the website before approving. The edited answers ARE the
   *  approved ones (they are what the ReplayAgent replays). */
  editedInConsoleAt?: string;
  editedBy?: string; // website account that edited the answers
  approvedBy?: string; // website account that approved it ("email" when approved by reply)
  /**
   * What the SCREEN said, checked asynchronously after the fill.
   *
   * The fill run no longer waits for OCR (it took 6-56s of a run that is already slow), so an
   * entry is queued before the visual check has a verdict. `state` is therefore part of the
   * submit guard, not a display field: submitApprovedEntry() refuses while it is "pending" or
   * "gaps", which is what stops an approval landing in the window before the result arrives.
   * "unavailable" means the check could not run and is treated exactly as it always was —
   * it says nothing and never blocks an application.
   */
  visualCheck?: {
    state: "pending" | "clean" | "gaps" | "unavailable";
    /** Human-readable findings, when state is "gaps". */
    gaps?: string[];
    /** x8ocr job id, for tracing. */
    jobId?: string;
    /** ISO — when this state was set. Used to age out a "pending" that never resolved. */
    at: string;
  };
  /** Set when an approved job was re-filled and the live form no longer matched what was
   *  approved. The submit was refused; these are the exact differences, awaiting a decision. */
  reapproval?: {
    at: string;
    reasons: string[];
    /** The answers as they now stand on the form — what a fresh approval would authorize. */
    proposed: FilledAnswer[];
    previous: FilledAnswer[];
  };
  decidedAt?: string; // ISO — when approve/skip was actioned
}

async function readQueue(): Promise<PendingEntry[]> {
  try {
    const raw = await fs.readFile(QUEUE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(entries: PendingEntry[]): Promise<void> {
  // Every guard against double submission reads this file. A half-written queue would be
  // worse than a lost command, so it is written atomically and fsynced.
  await writeJsonAtomic(QUEUE_PATH, entries);
}

export async function loadPendingQueue(): Promise<PendingEntry[]> {
  return readQueue();
}

export async function listAwaiting(): Promise<PendingEntry[]> {
  return (await readQueue()).filter((e) => e.status === "awaiting_approval");
}

/** Add or refresh a pending entry (re-running a job just updates its record). */
export async function upsertPending(
  entry: Omit<PendingEntry, "updatedAt" | "attempts" | "status"> & { status?: PendingStatus; attempts?: number },
): Promise<PendingEntry> {
  const entries = await readQueue();
  const now = new Date().toISOString();
  const idx = entries.findIndex((e) => e.key === entry.key);
  const prev = idx >= 0 ? entries[idx] : undefined;
  const merged: PendingEntry = {
    ...(prev ?? {}),
    ...entry,
    status: entry.status ?? prev?.status ?? "awaiting_approval",
    attempts: entry.attempts ?? prev?.attempts ?? 0,
    updatedAt: now,
  };
  if (idx >= 0) entries[idx] = merged;
  else entries.push(merged);
  await writeQueue(entries);
  return merged;
}

/**
 * Record the visual-check verdict for an entry. Worker-only, like every other writer here.
 * Returns false when the entry is gone (a re-fill can replace it while OCR is in flight).
 */
export async function setVisualCheck(
  key: string,
  visualCheck: NonNullable<PendingEntry["visualCheck"]>,
): Promise<boolean> {
  const entries = await readQueue();
  const idx = entries.findIndex((e) => e.key === key);
  if (idx < 0) return false;
  entries[idx] = { ...entries[idx], visualCheck, updatedAt: new Date().toISOString() };
  await writeQueue(entries);
  return true;
}

/** Update the status (and optionally attempts/error) of a pending entry by key. */
export async function updatePendingStatus(
  key: string,
  status: PendingStatus,
  // `reapproval: null` CLEARS a recorded hold. `undefined` leaves it alone — an omitted field
  // must never silently wipe state, which is the difference between "no opinion" and "remove".
  extra: { attempts?: number; lastError?: string; reapproval?: PendingEntry["reapproval"] | null } = {},
): Promise<void> {
  const entries = await readQueue();
  const idx = entries.findIndex((e) => e.key === key);
  if (idx < 0) return;
  entries[idx] = {
    ...entries[idx],
    status,
    updatedAt: new Date().toISOString(),
    ...(extra.attempts != null ? { attempts: extra.attempts } : {}),
    ...(extra.lastError != null ? { lastError: extra.lastError } : {}),
    ...(extra.reapproval === null ? { reapproval: undefined } : extra.reapproval !== undefined ? { reapproval: extra.reapproval } : {}),
  };
  await writeQueue(entries);
}
