import { detectAtsType, extractExternalJobId } from "../core/jobIdentity.js";

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
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
