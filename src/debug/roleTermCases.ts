import { classifyRoleTerm } from "../core/roleTerm.js";
import { skipAsOptionalProse } from "../agent/llmAgent.js";

/**
 * Which postings are not the summer internship.  npm run test:roleterm
 *
 * The list is built from "Summer 2027" sections, but a title inside one can still be a co-op, a
 * new-grad programme, or an internship in the wrong term — and those are decisions the candidate
 * answers differently. A co-op usually means a semester out of classes; a new-grad role cannot be
 * taken while still enrolled.
 */
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const term = (title: string, desc = "") => classifyRoleTerm(title, desc).term;

console.log("the ones we are applying for");
check(`"Software Engineer Intern - Summer 2027"`, term("Software Engineer Intern - Summer 2027") === "summer-internship");
check(`"Summer 2027 Software Engineering Intern"`, term("Summer 2027 Software Engineering Intern") === "summer-internship");
check(`an intern title whose body says summer`, term("Backend Software Engineer Intern", "This is a summer 2027 position based in NYC.") === "summer-internship");
check(`no alarm on a summer internship`, classifyRoleTerm("Software Engineer Intern, Summer 2027").needsAThought === false);

console.log("\nthe ones worth a second look");
check(`a co-op`, term("Software Engineering Co-Op (Fall 2026)") === "co-op");
check(`"Coop" spelled without the hyphen`, term("Engineering Coop - Spring 2027") === "co-op");
check(`a new-grad programme`, term("New Grad Software Engineer") === "new-grad");
check(`"Entry-Level Software Engineer"`, term("Entry-Level Software Engineer") === "new-grad");
check(`a full-time role that never says intern`, term("Software Engineer II") === "new-grad");
check(`an internship in the wrong term`, term("Software Engineer Intern - Fall 2026") === "off-cycle-internship");
check(`and it quotes the term it found`, classifyRoleTerm("Software Engineer Intern - Fall 2026").because.includes("Fall"), classifyRoleTerm("Software Engineer Intern - Fall 2026").because);
check(`an intern title with no term named`, term("Software Engineer Intern") === "unclear");
check(`each of those asks for a thought`, ["Software Engineering Co-Op", "New Grad Engineer", "Software Engineer Intern - Fall 2026", "Software Engineer II"].every((t) => classifyRoleTerm(t).needsAThought));
// Most intern titles name no season, and they come from a list built of Summer 2027 sections. Warning
// on those raised a flag on fourteen of forty-one queued applications, which is a flag nobody reads.
check(`a terse intern title does NOT raise the flag`, classifyRoleTerm("Backend Software Engineer Intern").needsAThought === false);
check(`it is still classified, just quietly`, term("Backend Software Engineer Intern") === "unclear");

console.log("\nwhat the DESCRIPTION must not decide");
// An employer's boilerplate lists every programme it runs; the title is what this posting IS.
check(`a summer internship whose body mentions co-ops is still a summer internship`,
  term("Software Engineer Intern, Summer 2027", "We hire interns and co-ops across all our teams.") === "summer-internship");

/**
 * OPTIONAL prose is left blank, on instruction: no cover letter and no summary unless the form
 * requires one. A REQUIRED one is still answered, because the gate will not pass without it.
 */
console.log("\noptional cover letters and summaries");
for (const [label, required, expected] of [
  ["Cover letter (optional)", false, true],
  ["Summary", false, true],
  ["Personal statement", false, true],
  ["Additional information", false, true],
  ["Cover letter *", true, false],
  ["Cover Letter", true, false],
  // Not prose fields — these must keep being answered.
  ["Why do you want to work here?", false, false],
  ["What is something hard you built recently?", false, false],
  ["LinkedIn Profile", false, false],
] as Array<[string, boolean, boolean]>) {
  check(`${required ? "required" : "optional"} "${label}" ${expected ? "left blank" : "answered"}`,
    skipAsOptionalProse(label, required) === expected, skipAsOptionalProse(label, required));
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
