import fs from "node:fs/promises";
import path from "node:path";
import { APPLICATIONS_DIR, APPLICATIONS_JSON_PATH } from "../config.js";
import { writeJson, writeText } from "../utils/log.js";
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

/** True if we've already engaged this job in a previous run. */
export function hasAppliedBefore(records: ApplicationRecord[], identity: JobIdentity): boolean {
  return records.some(
    (record) =>
      ENGAGED_STATUSES.has(record.status) &&
      (record.id === identity.identityKey ||
        (!!identity.externalJobId && record.externalJobId === identity.externalJobId) ||
        (!!identity.normalizedApplyUrl && normalize(record.applyUrl) === identity.normalizedApplyUrl)),
  );
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
