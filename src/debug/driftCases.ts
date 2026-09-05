import { compareToApproved, describeDrift } from "../core/approvalDrift.js";
import type { FilledAnswer } from "../agent/types.js";

/**
 * The gate that decides whether an approved application may be submitted after a re-fill.
 * Every case here is a real shape this system has hit. Run: npx tsx src/debug/driftCases.ts
 */

const a = (label: string, value: string): FilledAnswer => ({ label, type: "text", value });

interface Case {
  name: string;
  approved: FilledAnswer[];
  now: FilledAnswer[];
  submit: boolean;
  expect?: string;
}

const CASES: Case[] = [
  /**
   * A RELABELLED QUESTION IS NOT A CHANGED ANSWER.
   *
   * Pony.ai came back with seventeen "differences", not one of which was a different value. Our own
   * label derivation had changed under a pending approval - "Education - School" became "* School"
   * - so every answer was counted twice: once as a question that was not approved, once as an
   * answer that had vanished. The candidate had approved it repeatedly and checked the screenshot
   * himself, and the system kept handing it back.
   */
  {
    name: "our own code renamed the question - same value, must submit (the ZNSIQU case)",
    approved: [a("Education - School", "Carnegie Mellon University"), a("Education - Field of Study", "Computer and Information Science")],
    now: [a("* School", "Carnegie Mellon University"), a("Field of study (Optional)", "Computer and Information Science")],
    submit: true,
  },
  {
    name: "renamed AND a different value - still blocks",
    approved: [a("Education - School", "Carnegie Mellon University")],
    now: [a("* School", "Stanford University")],
    submit: false,
  },
  {
    name: "a repeated Yes is never paired away by value alone",
    approved: [a("Are you 18 or over?", "Yes"), a("Do you require sponsorship?", "Yes")],
    now: [a("Some question we invented", "Yes")],
    submit: false,
  },
  {
    name: "a genuinely new answer still blocks",
    approved: [a("Name", "Nathan Yao")],
    now: [a("Name", "Nathan Yao"), a("Salary expectation", "100000")],
    submit: false,
  },
  {
    name: "unchanged form — the 99% case, must submit without a murmur",
    approved: [a("Full name *", "Nathan Yao"), a("GPA*", "3.7")],
    now: [a("Full name *", "Nathan Yao"), a("GPA*", "3.7")],
    submit: true,
  },
  {
    name: "required marker appeared — same question, same answer",
    approved: [a("What is your current GPA? Please specify on a 4 point scale.", "3.7")],
    now: [a("What is your current GPA? Please specify on a 4 point scale.*", "3.7")],
    submit: true,
  },
  {
    name: "question REWORDED but the approved answer still goes in — submit (this is the BXGRTC case)",
    approved: [a("Are you currently authorized to work for all employers in the country where this job is based in the US? *", "Yes")],
    now: [a("Are you currently authorized to work for all employers in the country where this job is based? *", "Yes")],
    submit: true,
  },
  {
    name: "reworded AND the value differs — hold, the user never read this answer",
    approved: [a("Are you currently authorized to work for all employers in the country where this job is based in the US? *", "Yes")],
    now: [a("Are you currently authorized to work for all employers in the country where this job is based? *", "No")],
    submit: false,
  },
  {
    name: "a brand new required question the re-fill answered on its own — hold",
    approved: [a("Full name *", "Nathan Yao")],
    now: [a("Full name *", "Nathan Yao"), a("Are you willing to work in the office 5-days a week?*", "Yes")],
    submit: false,
  },
  {
    name: "an approved value silently changed — hold (a wrong end date must never slip through)",
    approved: [a("Company*", "BART"), a("To — Year", "2024")],
    now: [a("Company*", "BART"), a("To — Year", "2012")],
    submit: false,
  },
  {
    name: "repeated labels keep their own values positionally — three employers stay three employers",
    approved: [a("Company*", "BART"), a("Company*", "Studio X8"), a("Company*", "CMU")],
    now: [a("Company*", "BART"), a("Company*", "Studio X8"), a("Company*", "CMU")],
    submit: true,
  },
  {
    name: "a fourth experience block appeared and was filled — hold",
    approved: [a("Company*", "BART"), a("Company*", "Studio X8")],
    now: [a("Company*", "BART"), a("Company*", "Studio X8"), a("Company*", "BART")],
    submit: false,
  },
  {
    name: "an approved question is GONE — hold: we probably stopped reading a field that is still there",
    approved: [a("Full name *", "Nathan Yao"), a("Do you require sponsorship?", "No")],
    now: [a("Full name *", "Nathan Yao")],
    submit: false,
  },
  {
    name: "the whole page failed to read — every approved answer would be dropped, so hold loudly",
    approved: [a("Full name *", "Nathan Yao"), a("Email*", "nyao2@andrew.cmu.edu"), a("GPA*", "3.7")],
    now: [],
    submit: false,
  },
  {
    name: "formatting-only difference in the value — submit",
    approved: [a("Country*", "United States")],
    now: [a("Country*", "  united   states ")],
    submit: true,
  },
  {
    name: "an empty field the form left blank is not an unapproved value",
    approved: [a("Phone Extension", "")],
    now: [a("Phone Extension", "")],
    submit: true,
  },
];

let failed = 0;
for (const c of CASES) {
  const report = compareToApproved(c.approved, c.now);
  const ok = report.safeToSubmit === c.submit;
  if (!ok) failed += 1;
  console.log(`${ok ? "✅" : "❌"} ${c.submit ? "SUBMIT" : "HOLD  "} — ${c.name}`);
  if (!ok || !report.safeToSubmit) {
    for (const line of describeDrift(report)) console.log(`        ${line}`);
  }
}
console.log(`\n${CASES.length - failed}/${CASES.length} cases pass.`);
if (failed) process.exitCode = 1;
