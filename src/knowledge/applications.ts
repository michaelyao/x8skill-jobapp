import fs from "node:fs/promises";
import path from "node:path";
import { APPLICATIONS_DIR, APPLICATIONS_JSON_PATH } from "../config.js";
import { writeJson, writeText } from "../utils/log.js";
import { normalizeCompany } from "../utils/normalize.js";
import type { ApplicationRecord, JobIdentity } from "../types.js";

// Statuses that mean "we've already engaged this job" — used for cross-run dedupe
// so a later run doesn't re-open a job we already prefilled.
const ENGAGED_STATUSES = new Set<ApplicationRecord["status"]>([
  "prefilled_pending_submit",
  "already_applied_on_site",
]);

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "job";
}

/** Load the persistent application ledger (empty array if it doesn't exist yet). */
export async function loadApplications(): Promise<ApplicationRecord[]> {
  try {
    const raw = await fs.readFile(APPLICATIONS_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ApplicationRecord[]) : [];
  } catch {
    return [];
  }
}

// Statuses that mean the application actually WENT IN — re-opening these risks a
// duplicate application, so no override may bypass them.
const SUBMITTED_STATUSES = new Set<ApplicationRecord["status"]>(["submitted", "already_applied_on_site"]);

/**
 * Does this ledger record refer to the same job? Any one route is enough — they are
 * redundant on purpose, so a job is still recognised when one identifier changes.
 *
 * The requisition-id route is the only one that spans ATS: the employer's own id stays
 * the same when the identical opening is posted to a second board, where the ATS id,
 * the URL and therefore identityKey all differ.
 */
function sameJob(record: ApplicationRecord, identity: JobIdentity): boolean {
  const sameReq =
    !!identity.companyReqId &&
    !!record.companyReqId &&
    record.companyReqId === identity.companyReqId &&
    normalizeCompany(record.company) === normalizeCompany(identity.company);
  return (
    sameReq ||
    record.id === identity.identityKey ||
    (!!identity.externalJobId && record.externalJobId === identity.externalJobId) ||
    (!!identity.normalizedApplyUrl && normalize(record.applyUrl) === identity.normalizedApplyUrl)
  );
}

/** Word-overlap ratio (Jaccard) of two texts — 0..1. Cheap and dependency-free. */
function textOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared);
}

const normalizeTitle = (t: string): string =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(internship|inter)\b/g, "intern").replace(/\s+/g, " ").trim();

export interface DuplicateSuspicion {
  record: ApplicationRecord;
  reason: string;
  descriptionOverlap?: number;
}

/**
 * How sure we are that this job is one we have already engaged.
 *
 * `decision` is what downstream acts on; `confidence` is why. Nothing in this codebase
 * guesses at the boundary: "same_job" is only ever returned on a hard identifier match,
 * and anything softer is "possibly_same_job", which must be put to a human rather than
 * resolved automatically — a wrong "same" silently drops a real application, and a wrong
 * "distinct" submits twice.
 */
export interface JobMatchVerdict {
  decision: "same_job" | "possibly_same_job" | "distinct";
  confidence: number; // 0..1
  basis: string; // human-readable: which signal decided it
  matched?: ApplicationRecord;
  needsHumanConfirmation: boolean;
  suspicions: DuplicateSuspicion[];
}

/**
 * A DIFFERENT listing that was already submitted and shares this employer's requisition
 * id — i.e. the same job reached through another ATS. This is the case ATS ids cannot
 * see, and the one worth hard-blocking: the employer receives two applications for one
 * requisition. A record for this same listing (same URL) is excluded, since re-running a
 * job deliberately is normal.
 */
export function findCrossAtsDuplicate(
  records: ApplicationRecord[],
  identity: JobIdentity,
): ApplicationRecord | undefined {
  if (!identity.companyReqId) return undefined;
  return records.find(
    (record) =>
      record.companyReqId === identity.companyReqId &&
      normalizeCompany(record.company) === normalizeCompany(identity.company) &&
      normalize(record.applyUrl) !== identity.normalizedApplyUrl &&
      SUBMITTED_STATUSES.has(record.status),
  );
}

/** Classify this job against the ledger, reporting confidence instead of a bare boolean. */
export function classifyJobMatch(
  records: ApplicationRecord[],
  identity: JobIdentity,
  jobDescription?: string,
): JobMatchVerdict {
  // Hard identifiers. The requisition id is the strongest: it is the employer's own id,
  // so it holds even when the same job is posted through a different ATS.
  for (const record of records) {
    if (!sameJob(record, identity)) continue;
    const viaReq =
      !!identity.companyReqId && !!record.companyReqId && record.companyReqId === identity.companyReqId;
    return {
      decision: "same_job",
      confidence: viaReq ? 1 : 0.95,
      basis: viaReq
        ? `same company requisition id (${identity.companyReqId})`
        : "same ATS posting id / apply URL",
      matched: record,
      needsHumanConfirmation: false,
      suspicions: [],
    };
  }

  // No hard identifier. Fall back to the soft signals, which can only ever raise a question.
  const suspicions = findDuplicateSuspicions(records, identity, jobDescription);
  if (suspicions.length === 0) {
    return { decision: "distinct", confidence: 0, basis: "no matching identifier or title", needsHumanConfirmation: false, suspicions: [] };
  }
  // Rank by description overlap: the strongest corroboration we have without an id.
  const best = [...suspicions].sort((a, b) => (b.descriptionOverlap ?? 0) - (a.descriptionOverlap ?? 0))[0];
  const overlap = best.descriptionOverlap ?? 0;
  const sameLocation = /same location/.test(best.reason);
  // Same company + title, same location, and near-identical text: very likely one job on
  // two boards. Different location: very likely two real requisitions (RTX does exactly
  // this). Either way we do NOT decide — we hand it over with a number attached.
  const confidence = sameLocation ? Math.min(0.9, 0.55 + overlap * 0.4) : Math.min(0.5, 0.2 + overlap * 0.3);
  return {
    decision: "possibly_same_job",
    confidence,
    basis: best.reason,
    matched: best.record,
    needsHumanConfirmation: true,
    suspicions,
  };
}

/**
 * Records that LOOK like the same job but share no hard identifier: same company and
 * title, corroborated by how similar the descriptions are.
 *
 * This is a warning, never a block. Measured against the real ledger, RTX posts two
 * distinct "Software Engineer Intern" requisitions (Burnsville MN and Largo FL), so
 * company+title alone would merge two genuinely different jobs. Location and
 * description similarity are what separate them, and neither is reliable enough to
 * auto-skip an application on — a human decides.
 */
export function findDuplicateSuspicions(
  records: ApplicationRecord[],
  identity: JobIdentity,
  jobDescription?: string,
): DuplicateSuspicion[] {
  const out: DuplicateSuspicion[] = [];
  for (const record of records) {
    if (sameJob(record, identity)) continue; // already a hard match; not a "suspicion"
    if (normalizeCompany(record.company) !== normalizeCompany(identity.company)) continue;
    if (normalizeTitle(record.title) !== normalizeTitle(identity.title)) continue;
    const sameLocation =
      !!record.location && !!identity.location &&
      record.location.trim().toLowerCase() === identity.location.trim().toLowerCase();
    const overlap = jobDescription && record.jobDescription ? textOverlap(jobDescription, record.jobDescription) : undefined;
    const bits = ["same company + title"];
    if (sameLocation) bits.push("same location");
    else if (record.location || identity.location) bits.push(`different location (${record.location || "?"} vs ${identity.location || "?"})`);
    if (overlap !== undefined) bits.push(`description overlap ${(overlap * 100).toFixed(0)}%`);
    out.push({ record, reason: bits.join(", "), descriptionOverlap: overlap });
  }
  return out;
}

/** True if we've already engaged this job in a previous run. */
export function hasAppliedBefore(records: ApplicationRecord[], identity: JobIdentity): boolean {
  return records.some((record) => ENGAGED_STATUSES.has(record.status) && sameJob(record, identity));
}

/**
 * True if this job was really submitted (or the ATS reported us as already applied).
 * FORCE_RETRY must never override this — a second submission is not undoable.
 */
export function hasSubmittedBefore(records: ApplicationRecord[], identity: JobIdentity): boolean {
  return records.some((record) => SUBMITTED_STATUSES.has(record.status) && sameJob(record, identity));
}

function normalize(url: string): string {
  return url.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Upsert an application into the ledger (keyed by id) and write a per-application
 * folder with the job description and the fields we filled. Returns the full,
 * updated ledger so the caller can keep it in memory for the rest of the run.
 */
export async function recordApplication(
  records: ApplicationRecord[],
  entry: Omit<ApplicationRecord, "firstSeenAt" | "updatedAt">,
): Promise<ApplicationRecord[]> {
  const now = new Date().toISOString();
  const existing = records.find((record) => record.id === entry.id);
  const record: ApplicationRecord = {
    ...entry,
    firstSeenAt: existing?.firstSeenAt ?? now,
    updatedAt: now,
  };

  const next = existing
    ? records.map((r) => (r.id === entry.id ? record : r))
    : [...records, record];

  await writeJson(APPLICATIONS_JSON_PATH, next);

  // Per-application artifacts: human-readable JD + machine-readable record.
  const dir = path.join(APPLICATIONS_DIR, safeId(record.id));
  await fs.mkdir(dir, { recursive: true });
  await writeText(
    path.join(dir, "job-description.txt"),
    `${record.company} — ${record.title}\n${record.applyUrl}\n\n${record.jobDescription || "(no description captured)"}\n`,
  );
  await writeJson(path.join(dir, "application.json"), record);

  return next;
}
