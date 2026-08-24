import { normalizeCompany, normalizeUrl, stableHash } from "../utils/normalize.js";
import { reqIdFromUrl } from "./requisitionId.js";
import type { AtsType, JobIdentity, JobListing } from "../types.js";

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
  if (lower.includes("workable.com")) {
    return "workable";
  }
  // Tenant-hosted, so the host varies (egug.fa.us2…, jpmc.fa…, fa-evmr-saasfaprod1.fa.ocs…).
  // The /hcmUI/CandidateExperience/ path is the stable part.
  if (lower.includes("oraclecloud.com") && lower.includes("candidateexperience")) {
    return "oracle";
  }
  // Classified even though there is no driver: an identity is worth having for dedupe and for
  // reporting WHY a listing was never opened. See selectJobs.ts SUPPORTED_ATS.
  if (lower.includes("smartrecruiters.com")) {
    return "smartrecruiters";
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
    if (atsType === "workable") {
      // /{company}/j/{ID}/ — the hex id is the posting.
      const m = pathname.match(/\/j\/([0-9A-F]{6,})/i);
      if (m?.[1]) return m[1].toUpperCase();
    }
    if (atsType === "oracle") {
      // …/job/{numeric id}[/apply/…] — keep only the id, so the apply and the JD URL agree.
      const m = pathname.match(/\/job\/([0-9]+)/i);
      if (m?.[1]) return m[1];
    }
    if (atsType === "smartrecruiters") {
      // jobs.smartrecruiters.com/{Company}/{numeric id}
      const m = pathname.match(/\/([0-9]{6,})(?:\/|$)/);
      if (m?.[1]) return m[1];
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


