import { filterJobs } from "../core/filterJobs.js";
import type { JobListing } from "../types.js";

/** Any age the allowlist accepts — this suite is about TITLES, nothing else. */
const AGE = "0d";

/**
 * Which titles are worth applying for.  npm run test:titles
 *
 * This file exists because a preference that lives only in a note is a preference nothing honours.
 * "Firmware roles are not suitable" was recorded weeks ago and never encoded here, so firmware kept
 * being applied for; "Embedded Software Engineering Intern" reads as software and is a hardware
 * role, and it reached the review queue.
 */
const job = (title: string, age: string): JobListing => ({
  id: "TEST00",
  company: "Test",
  title,
  location: "San Francisco, CA",
  age,
  applyUrl: "https://job-boards.greenhouse.io/test/jobs/1234567",
});

// filterJobs drops a title it will not apply for, so surviving the filter IS the assertion.
const kept = (title: string) => filterJobs([job(title, AGE)]).length > 0;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

console.log("the roles he wants");
for (const t of [
  "Software Engineer Intern",
  "Software Engineering Intern - Backend",
  "Full-Stack Developer Intern",
  "Frontend Software Engineer Intern",
  "Machine Learning Engineer Intern",
  "Member of Technical Staff Intern",
]) check(`"${t}"`, kept(t), t);

console.log("\nhardware-adjacent, however much software is in the title");
for (const t of [
  "Embedded Software Engineering Intern",
  "Firmware Engineer Intern",
  "Hardware Engineering Intern",
  "FPGA Design Intern",
  "Electrical Engineering Intern",
  "Mechanical Engineer Intern",
  "Silicon Validation Software Intern",
]) check(`"${t}" is not applied for`, !kept(t), t);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
