import fs from "node:fs/promises";
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
export type PendingStatus = "awaiting_approval" | "submitting" | "submitted" | "skipped" | "error";

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
  answers?: FilledAnswer[]; // structured answers to replay on submit (== what was approved)
  reviewSentAt: string; // ISO
  updatedAt: string; // ISO
  status: PendingStatus;
  attempts: number; // Phase-B submit attempts
  processedReplyIds?: string[]; // reply message ids already acted on (avoid re-triggering)
  lastError?: string;
  /** Set when a review email was explicitly requested from the console. The Gmail scan only
   *  considers entries with this set — email approval is opt-in per job, not automatic. */
  emailRequestedAt?: string;
  /** Set when answers were edited in the console before approving. The edited answers ARE the
   *  approved ones (they are what the ReplayAgent replays). */
  editedInConsoleAt?: string;
  editedBy?: string; // console account that edited the answers
  approvedBy?: string; // console account that approved it ("email" when approved by reply)
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

/** Record a reply message id as acted-on so it never re-triggers on later polls. */
export async function markReplyProcessed(key: string, messageId: string): Promise<void> {
  const entries = await readQueue();
  const idx = entries.findIndex((e) => e.key === key);
  if (idx < 0) return;
  const ids = new Set(entries[idx].processedReplyIds ?? []);
  ids.add(messageId);
  entries[idx] = { ...entries[idx], processedReplyIds: [...ids], updatedAt: new Date().toISOString() };
  await writeQueue(entries);
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
