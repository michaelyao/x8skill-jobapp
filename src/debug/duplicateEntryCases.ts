/** `npm run test:dupes` - the Pony.ai profile, and the rows that must survive. */
import { duplicateEntriesToDelete, type CommittedEntry } from "../core/duplicateEntries.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  OK  ${name}`); }
  else { fail += 1; console.log(`  XX  ${name}${got === undefined ? "" : ` - got ${JSON.stringify(got)}`}`); }
};
const E = (section: string, index: number, text: string): CommittedEntry => ({ section, index, text });

const CMU = "School Carnegie Mellon University Field of study Information Systems Degree Bachelor of Science Period August 2024";
const BART = "Title Software Engineering Intern Company Bay Area Rapid Transit (BART) Period June 2023 - August 2023";
const VTA = "Title Software Engineering Intern Company Santa Clara Valley Transportation Authority (VTA) Period January 2025 - April 2025";

console.log("the profile the candidate found on Pony.ai");
const pony = [
  E("education", 0, CMU), E("education", 1, CMU), E("education", 2, CMU),
  E("experience", 0, VTA), E("experience", 1, BART), E("experience", 2, BART),
];
const drop = duplicateEntriesToDelete(pony);
check("three identical degrees leave two to delete", drop.filter((d) => d.section === "education").length === 2);
check("two identical BART rows leave one to delete", drop.filter((d) => d.section === "experience").length === 1);
check("the FIRST of each group survives", !drop.some((d) => d.index === 0));
check("deletions run highest-index first so positions do not shift",
  drop.map((d) => d.index).join(",") === "2,2,1", drop.map((d) => `${d.section}:${d.index}`));

console.log("");
console.log("rows that must NOT be touched");
check("different employers are kept",
  duplicateEntriesToDelete([E("experience", 0, VTA), E("experience", 1, BART)]).length === 0);
check("same company, different role is kept",
  duplicateEntriesToDelete([
    E("experience", 0, "Title Teaching Assistant Company Carnegie Mellon University Period 2026"),
    E("experience", 1, "Title Research Assistant Company Carnegie Mellon University Period 2025"),
  ]).length === 0);
check("the same text in DIFFERENT sections is not a duplicate",
  duplicateEntriesToDelete([E("education", 0, CMU), E("experience", 0, CMU)]).length === 0);
check("spacing and punctuation differences still count as the same row",
  duplicateEntriesToDelete([E("experience", 0, BART), E("experience", 1, "  " + BART + "  ")]).length === 1);
check("an empty row is never deleted as a duplicate",
  duplicateEntriesToDelete([E("experience", 0, ""), E("experience", 1, "")]).length === 0);
check("a single entry is never a duplicate", duplicateEntriesToDelete([E("education", 0, CMU)]).length === 0);

console.log("");
console.log(`${fail === 0 ? "OK" : "XX"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
