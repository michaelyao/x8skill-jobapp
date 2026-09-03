import { confirmsSubmission } from "../agent/drivers/base.js";

/**
 * Cases for "has this application already been submitted?".  npm run test:confirm
 *
 * The real captures are here verbatim. This guard is what turned a repeat submission at HP IQ
 * into a log line at the moment it happened, and it MISSED DV Trading for eighteen days — the
 * employer held the application while the queue offered an Approve button.
 */
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

console.log("real confirmation pages");
// Verbatim from logs/2026-08-31T04-49-56-240Z/debug-WREEFN.png — the one that was missed.
const DV = "DV Thank you for your interest in DV Trading! We've received your application and will be in touch if your background is a strong match for the role. We appreciate you taking the time to apply! View more jobs at DV Trading Back to job post Track your application Sign in to MyGreenhouse Powered by greenhouse";
check(`DV Trading — "We've received your application"`, confirmsSubmission(DV) === true);
check(`the same with a curly apostrophe`, confirmsSubmission(DV.replace("We've", "We’ve")) === true);
check(`and spelled out`, confirmsSubmission(DV.replace("We've", "We have")) === true);
check(`Greenhouse classic`, confirmsSubmission("Thank you for applying to Acme. We will be in touch.") === true);
check(`Workday`, confirmsSubmission("Your application has been submitted. You can track it in your profile.") === true);
check(`Ashby`, confirmsSubmission("Application received! Thanks for your application.") === true);
check(`Lever`, confirmsSubmission("Thanks for applying — we'll review your application shortly.") === true);
check(`"received your application" at the end of a sentence`,
  confirmsSubmission("We received your application. Someone will reach out.") === true);
check(`"your application to X was received"`,
  confirmsSubmission("Your application to the Software Engineer Intern role was received.") === true);

console.log("\nwhat must NOT count as a confirmation");
// A FALSE positive marks the job engaged and loses the opportunity silently, so the forward-
// looking framings a job description uses are excluded.
check(`a description promising what happens next`,
  confirmsSubmission("Once we have received your application, our team will review it within two weeks.") === false,
  confirmsSubmission("Once we have received your application, our team will review it within two weeks."));
check(`"after we receive your application"`,
  confirmsSubmission("After we receive your application you will hear from a recruiter.") === false);
check(`a bare thank-you on a job page`,
  confirmsSubmission("Thank you for your interest in DV Trading! Browse our open roles below.") === false,
  confirmsSubmission("Thank you for your interest in DV Trading! Browse our open roles below."));
check(`an empty page`, confirmsSubmission("") === false);
check(`a form still asking for things`,
  confirmsSubmission("Apply for this job. First name. Last name. Resume. Submit application") === false,
  confirmsSubmission("Apply for this job. First name. Last name. Resume. Submit application"));

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
