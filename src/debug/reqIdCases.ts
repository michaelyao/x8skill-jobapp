import { findRequisitionId, reqIdFromPageText, reqIdFromUrl } from "../core/requisitionId.js";

const urlCases: Array<[string, string | undefined]> = [
  ["https://uline.wd1.myworkdayjobs.com/en-US/Uline_Careers/job/Pleasant-Prairie-WI/Software-Development-Internship---Summer-2027_R265684", "R265684"],
  ["https://medtronic.wd1.myworkdayjobs.com/en-US/Medtronic/job/Software-Engineer-Intern_R73630", "R73630"],
  ["https://x.wd5.myworkdayjobs.com/job/US-MN-BURNSVILLE/Software-Engineer-Intern_01865635", undefined], // bare digits in URL: too weak without a label
  ["https://jobs.lever.co/palantir/e27af7ab-41fc-40c9-b31d-02c6cb1c505c/apply", undefined],
  ["https://job-boards.greenhouse.io/pdtpartners/jobs/8077685", undefined],
  ["https://acme.wd1.myworkdayjobs.com/job/Intern-Summer-2027_JR0123456", "JR0123456"],
];

const textCases: Array<[string, string | undefined]> = [
  ["Software Engineer Intern Job ID: R73630 Apply now", "R73630"],
  ["Requisition Number 01865635 Location Largo FL", "01865635"],
  ["Posted 3 days ago JR11987 Samsara San Francisco", "JR11987"],
  ["Req #: REQ-4471 Full time", "REQ-4471"],
  // negatives — nothing here is an id
  ["Summer 2027 internship, 10 weeks, salary $180,000 for the 2026-2027 year", undefined],
  ["Apply by December 2026. Graduating in 2027.", undefined],
  ["Job Description Summary and responsibilities", undefined],
];

let bad = 0;
console.log("--- from URL ---");
for (const [url, want] of urlCases) {
  const got = reqIdFromUrl(url);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  got=${String(got).padEnd(11)} want=${String(want).padEnd(11)} ${url.slice(-58)}`);
}
console.log("--- from page text ---");
for (const [text, want] of textCases) {
  const got = reqIdFromPageText(text);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  got=${String(got).padEnd(11)} want=${String(want).padEnd(11)} ${text.slice(0, 52)}`);
}
// URL wins over page text when both are present.
const both = findRequisitionId("https://x.wd1.myworkdayjobs.com/job/Intern_R99999", "Job ID: R11111");
console.log(`${both === "R99999" ? "PASS" : "FAIL"}  URL takes precedence over page text (got ${both})`);
if (both !== "R99999") bad++;

console.log(bad === 0 ? "\nall requisition-id cases pass" : `\n${bad} case(s) failed`);
