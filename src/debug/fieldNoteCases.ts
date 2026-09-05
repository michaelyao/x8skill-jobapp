/** `npm run test:notes` - what is remembered about a field, and what must never be assumed. */
import { noteFor, type FieldNote } from "../knowledge/fieldNotes.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  OK  ${name}`); }
  else { fail += 1; console.log(`  XX  ${name}${got === undefined ? "" : ` - got ${JSON.stringify(got)}`}`); }
};
const N = (ats: string, label: string, remedy?: string, worked?: boolean): FieldNote => ({
  ats, label, note: "seen", at: "2026-09-05T00:00:00.000Z",
  ...(remedy ? { remedy } : {}), ...(worked === undefined ? {} : { worked }),
});

console.log("finding what we learned");
const notes = [
  N("workday", "Country Phone Code*", "click-label", true),
  N("workable", "* Do you have a High school diploma?", "click-label", true),
  N("greenhouse", "Country", "force-click", false),
];
check("an exact label is found", noteFor(notes, "workday", "Country Phone Code*")?.remedy === "click-label");
check("the required marker is not part of the identity",
  noteFor(notes, "workday", "Country Phone Code")?.remedy === "click-label");
check("nor is a prefix our own reader added",
  noteFor(notes, "workday", "My Information \u2014 Country Phone Code*")?.remedy === "click-label");
check("nor is (Optional)",
  noteFor(notes, "workable", "* Do you have a High school diploma? (Optional)")?.remedy === "click-label");

console.log("");
console.log("what must NOT be assumed");
check("never across ATSes - a Workday widget says nothing about Greenhouse",
  noteFor(notes, "greenhouse", "Country Phone Code*") === undefined);
check("an unknown field has no note", noteFor(notes, "workday", "Salary expectation") === undefined);
check("a very short label is not matched loosely", noteFor(notes, "workday", "To") === undefined);
check("a remedy recorded as NOT working is still returned by noteFor (the caller decides)",
  noteFor(notes, "greenhouse", "Country")?.worked === false);

console.log("");
console.log(`${fail === 0 ? "OK" : "XX"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
