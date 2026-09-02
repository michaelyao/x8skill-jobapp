import { AGE_ALLOWLIST } from "../config.js";
import { isLikelyUsLocation } from "../utils/normalize.js";
import type { FilteredJob, JobListing } from "../types.js";

function isLikelySoftwareEngineeringTitle(title: string): boolean {
  const text = title.toLowerCase();
  const positivePatterns = [
    /\bsoftware\b/,
    /\bengineer(ing)?\b/,
    /\bdeveloper\b/,
    /\bmember of technical staff\b/,
    /\btechnical staff\b/,
    /\bswe\b/,
    /\bsde\b/,
    /\bfull[- ]stack\b/,
    /\bfrontend\b/,
    /\bbackend\b/,
    /\bplatform\b/,
  ];
  const negativePatterns = [
    /\berp\b/,
    /\bcompensation\b/,
    /\binformation systems?\b/,
    /\bconsulting\b/,
    /\banalyst\b/,
    /\boperations\b/,
    /\bdigital\b/,
    /\bdata\b(?!.*engineer)/,
    /\bmultiple teams\b/,
    /\bintelligence\b(?!.*engineer)/,
    /**
     * HARDWARE-ADJACENT ROLES. The candidate wants software and AI/ML; a title built around the
     * hardware is not suitable however much software it involves — "Embedded Software Engineering
     * Intern" reads as software and is a hardware role. Firmware was recorded as unsuitable weeks
     * ago and never encoded here, so it kept being applied for: a preference that lives only in a
     * note is a preference nothing honours.
     */
    /\bfirmware\b/,
    /\bembedded\b/,
    /\bhardware\b/,
    /\bfpga\b/,
    /\brtl\b/,
    /\bvlsi\b/,
    /\bsilicon\b/,
    /\bpcb\b/,
    /\bmechanical\b/,
    /\belectrical\b/,
  ];

  return positivePatterns.some((pattern) => pattern.test(text)) && !negativePatterns.some((pattern) => pattern.test(text));
}

/**
 * A job the candidate handed over BY URL is not sifted.
 *
 * The discovery filters exist to thin four hundred tracker rows down to the ones worth opening —
 * age, title shape, location. None of that applies to a posting he chose deliberately: its title
 * may be "(supplied by URL)" because nothing has opened the page yet, and rejecting it for that
 * would silently drop the one job he actually asked for. The judgements that matter for it — the
 * role's term, the degree it requires, whether it duplicates something already submitted — all
 * happen later, at review, where he can see them.
 */
const suppliedByHand = (job: JobListing): boolean => job.source === "you";

export function filterJobs(jobs: JobListing[]): FilteredJob[] {
  return jobs
    .filter((job) => suppliedByHand(job) || AGE_ALLOWLIST.has(job.age.trim()))
    .filter((job) => suppliedByHand(job) || isLikelySoftwareEngineeringTitle(job.title))
    .map((job) => {
      const location = job.location.trim();
      const explicitlyInternational = /\b(canada|international|emea|india|mexico|europe|singapore)\b/i.test(location);
      const usEligible = !explicitlyInternational && (isLikelyUsLocation(location) || /^remote$/i.test(location));
      const needsManualLocationReview = !explicitlyInternational && !usEligible;
      return {
        ...job,
        usEligible,
        needsManualLocationReview,
      };
    })
    .filter((job) => job.usEligible || job.needsManualLocationReview);
}
