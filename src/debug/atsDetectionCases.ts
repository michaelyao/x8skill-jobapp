import { detectAtsType, extractExternalJobId } from "../core/jobIdentity.js";
import { redirectedAwayFromPosting } from "../core/applyJob.js";

/**
 * ATS detection + posting-id extraction, over real URLs taken from the live list.
 *   npm run test:ats
 * Detection decides which driver drives a form and which listings a sweep will even open, so a
 * silent miss here means a whole ATS family is skipped without a word.
 */
const CASES: Array<[string, string, string]> = [
  // url, expected ats, expected external id
  ["https://apply.workable.com/pony-dot-ai/j/4C1F53EF5D/", "workable", "4C1F53EF5D"],
  ["https://apply.workable.com/western-magnetics/j/E366930F3F/", "workable", "E366930F3F"],
  ["https://apply.workable.com/pony-dot-ai/j/4C1F53EF5D/apply/", "workable", "4C1F53EF5D"],
  ["https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011679", "oracle", "26011679"],
  // the apply sub-path must give the SAME id, or the JD and the apply URL dedupe as two jobs
  ["https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011679/apply/email", "oracle", "26011679"],
  ["https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210773759", "oracle", "210773759"],
  ["https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345", "oracle", "12345"],
  ["https://jobs.smartrecruiters.com/WesternDigital/744000143171017", "smartrecruiters", "744000143171017"],
  // the families that already worked must not regress
  ["https://hp.wd5.myworkdayjobs.com/ExternalCareerSite/job/Spring-Texas/Software_3167906-1", "workday", ""],
  ["https://jobs.ashbyhq.com/notion/3fba1c39-c5cb-47d7-9000-000000000000", "ashby", "3fba1c39-c5cb-47d7-9000-000000000000"],
  ["https://job-boards.greenhouse.io/syskahennessy/jobs/8147733", "greenhouse", "8147733"],
  ["https://jobs.lever.co/acme/2b8a1c39-c5cb-47d7-9000-000000000001", "lever", "2b8a1c39-c5cb-47d7-9000-000000000001"],
  // an Oracle host WITHOUT the candidate-experience path is not an application site
  ["https://www.oracle.com/careers/", "unknown", ""],
  ["https://careers.sig.com/opportunity/12345", "unknown", ""],
];

let pass = 0;
let fail = 0;
for (const [url, wantAts, wantId] of CASES) {
  const ats = detectAtsType(url);
  const id = extractExternalJobId(url, ats);
  const atsOk = ats === wantAts;
  // "" means "we do not assert the id here" (workday falls back to a hash of the url)
  const idOk = wantId === "" || id === wantId;
  if (atsOk && idOk) {
    pass += 1;
    console.log(`  ✓ ${wantAts.padEnd(15)} ${wantId || "(id not asserted)"}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${url}\n      ats: got ${ats}, want ${wantAts}${idOk ? "" : `\n      id:  got ${id}, want ${wantId}`}`);
  }
}

/**
 * A WITHDRAWN posting redirects, and the page it lands on never says it is closed.
 *
 * Greenhouse sends a dead job to the company's board index, so the text test for "no longer
 * available" finds nothing, the reader sees other people's roles, and the run ends "0 field(s),
 * submitReady=false / No next control" — the signature of not being on the form, reported as a
 * failure to fill. Measured live on cssmerge/jobs/8687896002, which lands on
 * job-boards.greenhouse.io/cssmerge?error=true titled "Jobs at ATOMS Careers page".
 */
console.log("\na posting that redirects away is a posting that is gone");
const redirects: Array<[string, string, boolean, string]> = [
  ["https://job-boards.greenhouse.io/cssmerge/jobs/8687896002", "https://job-boards.greenhouse.io/cssmerge?error=true", true, "the live case"],
  ["https://job-boards.greenhouse.io/verkada/jobs/5210813007", "https://job-boards.greenhouse.io/verkada/jobs/5210813007", false, "still on the posting"],
  ["https://job-boards.greenhouse.io/verkada/jobs/5210813007", "https://job-boards.greenhouse.io/verkada/jobs/5210813007#app", false, "an anchor is not a redirect"],
  ["https://apply.workable.com/acme/j/ABC123/", "https://apply.workable.com/acme/?not_found=true", true, "workable's own flag"],
  // Only a numeric id is used, so a uuid-addressed posting is judged by the flag alone — Lever,
  // Ashby and Workday keep their existing behaviour.
  ["https://jobs.lever.co/acme/2f1a-9c", "https://jobs.lever.co/acme/2f1a-9c/apply", false, "lever's apply step"],
  ["https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Remote/SWE_R123", "https://acme.wd1.myworkdayjobs.com/en-US/careers/login", false, "workday's own auth step"],
];
for (const [asked, landed, want, why] of redirects) {
  const got = redirectedAwayFromPosting(asked, landed);
  if (got === want) { pass += 1; console.log(`  ✓ ${why}`); }
  else { fail += 1; console.log(`  ✗ ${why} — got ${got}, want ${want}`); }
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
