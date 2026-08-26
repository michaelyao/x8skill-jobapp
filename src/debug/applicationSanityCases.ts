import { reviewApplication, type SanityInput } from "../core/applicationSanity.js";
import type { FieldSpec, FilledAnswer } from "../agent/types.js";

/**
 * Cases for the whole-application guardrail.  npm run test:sanity
 *
 * Most of these check that it stays QUIET. This rule can stop a finished application from reaching
 * you, so a false positive is worse than the bug it guards: a real gap costs one re-fill, while a
 * rule that fires on complete applications stops the pipeline on jobs that were ready to go.
 */
const field = (label: string, required = false): FieldSpec => ({ key: label, label, type: "text", required });
const ans = (label: string, value: string): FilledAnswer => ({ label, type: "text", value });

const CASES: Array<{ name: string; input: SanityInput; want: string[] }> = [
  {
    // The bug this exists for: Workable ZNSIQU, after the sections were expanded but before
    // anything filled them.
    name: "education section present and entirely blank",
    input: {
      observedFields: [field("* School", true), field("Field of study (Optional)"), field("Degree (Optional)")],
      answers: [ans("* First name", "Nathan"), ans("* Email", "n@example.com")],
      resumeAttached: true,
    },
    want: ["education-blank"],
  },
  {
    name: "experience section present and entirely blank",
    input: {
      observedFields: [field("* Title", true), field("Company (Optional)")],
      answers: [ans("* First name", "Nathan")],
      resumeAttached: true,
    },
    want: ["experience-blank"],
  },
  {
    // The real Workable experience section is Title + Company + Industry. Bare "* Title" is NOT
    // matched on its own — see the note on EXPERIENCE in applicationSanity.ts — so the case has to
    // use the label set the form actually renders.
    name: "both sections blank — both reported, not just the first",
    input: {
      observedFields: [field("* School", true), field("* Title", true), field("Company (Optional)")],
      answers: [],
      resumeAttached: true,
    },
    want: ["education-blank", "experience-blank"],
  },
  {
    name: "no resume attached",
    input: { observedFields: [field("* First name", true)], answers: [ans("* First name", "Nathan")], resumeAttached: false },
    want: ["no-resume"],
  },
  // ---- must stay QUIET ------------------------------------------------------------------
  {
    name: "education asked and answered",
    input: {
      observedFields: [field("* School", true), field("Degree (Optional)")],
      answers: [ans("* School", "Carnegie Mellon University"), ans("Degree (Optional)", "BS")],
      resumeAttached: true,
    },
    want: [],
  },
  {
    name: "partially filled counts as filled — one answer is a real record",
    input: {
      observedFields: [field("* School", true), field("Field of study (Optional)"), field("Degree (Optional)")],
      answers: [ans("* School", "Carnegie Mellon University")],
      resumeAttached: true,
    },
    want: [],
  },
  {
    // Most Greenhouse/Lever forms. Complete as submitted — the resume carries the history.
    name: "a form that never asks for education or experience",
    input: {
      observedFields: [field("First Name", true), field("Email", true), field("LinkedIn Profile")],
      answers: [ans("First Name", "Nathan"), ans("Email", "n@example.com")],
      resumeAttached: true,
    },
    want: [],
  },
  {
    // "Tell us about your education" is a prose prompt, not an education record. Treating it as
    // one would demand a School field the form never had.
    name: "a prose question that merely mentions education",
    input: {
      observedFields: [field("First Name", true), field("Cover letter — describe your education")],
      answers: [ans("First Name", "Nathan")],
      resumeAttached: true,
    },
    want: [],
  },
  {
    name: "'How did you hear about us' is not a work-experience field",
    input: {
      observedFields: [field("First Name", true), field("How did you hear about us? (company website)")],
      answers: [ans("First Name", "Nathan")],
      resumeAttached: true,
    },
    want: [],
  },
  {
    name: "a blank-valued answer does not count as filled",
    input: {
      observedFields: [field("* School", true)],
      answers: [ans("* School", "   ")],
      resumeAttached: true,
    },
    want: ["education-blank"],
  },
  {
    // "Title" is also the salutation field (Mr/Ms/Dr). Matching it as work experience would fire
    // on complete applications, which is the one failure mode this guard must not have.
    name: "a bare Title field is not treated as work experience",
    input: {
      observedFields: [field("First Name", true), field("Title")],
      answers: [ans("First Name", "Nathan")],
      resumeAttached: true,
    },
    want: [],
  },
  {
    name: "identity blank on a form that asks for it",
    input: {
      observedFields: [field("First Name", true), field("Email", true)],
      answers: [],
      resumeAttached: true,
    },
    want: ["identity-blank"],
  },
];

let pass = 0;
let fail = 0;
for (const c of CASES) {
  const got = reviewApplication(c.input).map((p) => p.code).sort();
  const want = [...c.want].sort();
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    console.log(`  ✓ ${c.name}${got.length ? ` → ${got.join(", ")}` : " → quiet"}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${c.name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
