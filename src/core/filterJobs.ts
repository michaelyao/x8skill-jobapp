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

export function filterJobs(jobs: JobListing[]): FilteredJob[] {
  return jobs
    .filter((job) => AGE_ALLOWLIST.has(job.age.trim()))
    .filter((job) => isLikelySoftwareEngineeringTitle(job.title))
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
