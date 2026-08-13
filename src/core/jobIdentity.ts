import { normalizeCompany, normalizeUrl, stableHash } from "../utils/normalize.js";
import { reqIdFromUrl } from "./requisitionId.js";
import type { AtsType, DedupeDecision, JobIdentity, JobListing, SheetRow } from "../types.js";

export function detectAtsType(url: string): AtsType {
  const lower = url.toLowerCase();
  if (lower.includes("myworkdayjobs.com") || lower.includes(".wd1.") || lower.includes(".wd5.")) {
    return "workday";
  }
  if (lower.includes("ashbyhq.com")) {
    return "ashby";
  }
  if (lower.includes("greenhouse.io") || lower.includes("boards.greenhouse.io")) {
    return "greenhouse";
  }
  if (lower.includes("lever.co")) {
    return "lever";
  }
  return "unknown";
}

export function extractExternalJobId(url: string, atsType: AtsType): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (atsType === "workday") {
      const reqMatch = pathname.match(/[_-](req[0-9a-z-]+)$/i) || pathname.match(/\/([^/]*req[0-9a-z-]+)$/i);
      if (reqMatch?.[1]) {
        return reqMatch[1].toUpperCase();
      }
    }
    if (atsType === "ashby" || atsType === "lever") {
      // Both use a UUID posting id in the path (…/{company}/{uuid}[/apply]).
      const uuidMatch = pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch?.[0]) {
        return uuidMatch[0].toLowerCase();
      }
    }
    if (atsType === "greenhouse") {
      const numMatch = pathname.match(/\/jobs\/([0-9]+)/i);
      const ghMatch = parsed.searchParams.get("gh_jid");
      if (numMatch?.[1]) {
        return numMatch[1];
      }
      if (ghMatch) {
        return ghMatch;
      }
    }
  } catch {
    return stableHash(url);
  }
  return stableHash(url);
}

export function buildJobIdentity(job: JobListing): JobIdentity {
  const normalizedApplyUrl = normalizeUrl(job.applyUrl);
  const atsType = detectAtsType(normalizedApplyUrl);
  const externalJobId = extractExternalJobId(normalizedApplyUrl, atsType);
  return {
    company: job.company,
    title: job.title,
    location: job.location,
    normalizedApplyUrl,
    externalJobId,
    atsType,
    // identityKey stays ATS-derived so it keeps matching records written before
    // requisition ids existed. The requisition id is an ADDITIONAL match route in
    // sameJob(), not a replacement — no migration of the ledger required.
    identityKey: `${normalizeCompany(job.company)}::${externalJobId}`,
    companyReqId: reqIdFromUrl(normalizedApplyUrl),
  };
}

/**
 * Attach a requisition id discovered after the posting was opened (most employers only
 * print it in the page body). Returns a new identity — never mutates the original.
 */
export function withRequisitionId(identity: JobIdentity, companyReqId: string | undefined): JobIdentity {
  if (!companyReqId || companyReqId === identity.companyReqId) return identity;
  return { ...identity, companyReqId };
}

export function decideDedupe(identity: JobIdentity, rows: SheetRow[]): DedupeDecision {
  const normalizedCompany = normalizeCompany(identity.company);
  const normalizedTitle = identity.title.trim().toLowerCase();

  for (const row of rows) {
    const rowCompany = normalizeCompany(row.company ?? "");
    const rowTitle = (row.title ?? "").trim().toLowerCase();
    const rowJobId = (row.jobId ?? "").trim();
    const rowUrl = row.applyLink?.trim() ?? "";
    const appliedSignal = (row.status ?? "").toLowerCase();

    if (rowCompany === normalizedCompany && rowJobId && rowJobId === identity.externalJobId) {
      return {
        shouldSkip: true,
        reason: `matched sheet by company + job id${appliedSignal ? ` (${row.status})` : ""}`,
        matchedRow: row,
      };
    }

    if (rowUrl && normalizeUrl(rowUrl) === identity.normalizedApplyUrl) {
      return {
        shouldSkip: true,
        reason: `matched sheet by apply url${appliedSignal ? ` (${row.status})` : ""}`,
        matchedRow: row,
      };
    }

    if (rowCompany === normalizedCompany && rowTitle === normalizedTitle && appliedSignal) {
      return {
        shouldSkip: true,
        reason: `matched sheet by company + title (${row.status})`,
        matchedRow: row,
      };
    }
  }

  return {
    shouldSkip: false,
    reason: "no sheet match",
  };
}

