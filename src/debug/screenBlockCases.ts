import { boxesAreExact, describeVerdicts, looksEmpty, textIsLiteral, valueBlockFor, verifyFields, type ScreenBlock } from "../knowledge/screenBlocks.js";

/**
 * Cases for field-level screen verification.  npm run test:blocks
 *
 * BLOCKS is the real x8ocr output for the reported Workable experience entry — captured verbatim
 * from the live service with includeLayout=true, boxes and all. It is the ideal fixture because the
 * bug is in it: both date boxes show the "MM/YYYY" placeholder while the run had recorded 08/2026
 * and 05/2028, and the two placeholders sit at the SAME y in different columns, which is what makes
 * the x-overlap rule necessary rather than decorative.
 */
const BLOCKS: ScreenBlock[] = [
  { label: "table", text: '<table><tr><td>Title</td><td>Oct</td><td>Nov</td><td>Dec</td></tr><tr><td colspan="4">Software Engineering Intern, Shield Infrastruc</td></tr></table>', box: [89, 1, 978, 118], order: 0 },
  { label: "text", text: "Company (Optional)", box: [89, 163, 289, 193], order: 1 },
  { label: "text", text: "Amazon", box: [108, 224, 194, 251], order: 2 },
  { label: "title", text: "Industry (Optional)", box: [89, 310, 277, 339], order: 3 },
  { label: "text", text: "Computer Software", box: [108, 369, 304, 399], order: 4 },
  { label: "title", text: "Summary (Optional)", box: [89, 455, 289, 486], order: 5 },
  { label: "text", text: "CS undergraduate at Carnegie Mellon University (BS Information Systems, GPA 3.44, exp. May 2028) with internship experience", box: [100, 502, 952, 686], order: 6 },
  { label: "text", text: "Start date (Optional)", box: [89, 722, 295, 751], order: 7 },
  { label: "text", text: "MM/YYYY", box: [108, 780, 213, 811], order: 8 },
  { label: "text", text: "End date (Optional)", box: [549, 722, 743, 751], order: 9 },
  { label: "text", text: "MM/YYYY", box: [568, 780, 673, 811], order: 10 },
  { label: "checkbox", text: "☐ I currently work here", box: [88, 861, 334, 894], order: 11, checked: false },
  { label: "text", text: "Update", box: [125, 971, 208, 1000], order: 12 },
];

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const status = (label: string, value: string) => verifyFields(BLOCKS, [{ label, value }])[0]?.status;

console.log("pairing a label with ITS OWN value box");
check(`"Company (Optional)" pairs with "Amazon"`, valueBlockFor(BLOCKS, "Company (Optional)")?.value?.text === "Amazon");
check(`the recorded label may carry a * the OCR stripped`, valueBlockFor(BLOCKS, "Company*")?.value?.text === "Amazon", valueBlockFor(BLOCKS, "Company*")?.value?.text);
check(`"(Optional)" in either copy does not matter`, valueBlockFor(BLOCKS, "Industry")?.value?.text === "Computer Software");
// The two MM/YYYY boxes share a y. Only x-overlap tells them apart, and pairing End date with
// Start date's box would report the wrong field as filled.
check(`"Start date" takes the LEFT placeholder`, valueBlockFor(BLOCKS, "Start date (Optional)")?.value?.box?.[0] === 108, valueBlockFor(BLOCKS, "Start date (Optional)")?.value?.box);
check(`"End date" takes the RIGHT placeholder`, valueBlockFor(BLOCKS, "End date (Optional)")?.value?.box?.[0] === 568, valueBlockFor(BLOCKS, "End date (Optional)")?.value?.box);
check(`a label that is not on the page`, valueBlockFor(BLOCKS, "Postal Code") === undefined);

console.log("\nverdicts — the reported bug");
check(`a date recorded but showing MM/YYYY reads EMPTY`, status("Start date (Optional)", "08/2026") === "empty", status("Start date (Optional)", "08/2026"));
check(`the other date too`, status("End date (Optional)", "05/2028") === "empty");
check(`a value that IS in its own box matches`, status("Company (Optional)", "Amazon") === "match", status("Company (Optional)", "Amazon"));
check(`a value contradicted by its box`, status("Company (Optional)", "Google") === "different", status("Company (Optional)", "Google"));
// A narrow input clips its text; demanding the whole string reported filled fields as missing.
check(`a visually truncated long value still matches`, status("Summary (Optional)", "CS undergraduate at Carnegie Mellon University (BS Information Systems, GPA 3.44, exp. May 2028) with internship experience across real-time systems") === "match", status("Summary (Optional)", "CS undergraduate at Carnegie Mellon University (BS Information Systems, GPA 3.44, exp. May 2028) with internship experience across real-time systems"));

console.log("\ncheckboxes carry their own state");
check(`"Yes" against an unticked box is a difference`, status("I currently work here", "Yes") === "different", status("I currently work here", "Yes"));
check(`"No" against an unticked box matches`, status("I currently work here", "No") === "match", status("I currently work here", "No"));

console.log("\nwhat must NOT be reported");
// THE POINT OF THIS FILE. The page text contains "Carnegie Mellon University" inside the Summary
// block, so a page-level containment check passes an empty School field. Field-level does not.
check(`a value present ELSEWHERE on the page does not vouch for an empty field`,
  status("Start date (Optional)", "Carnegie Mellon University") === "empty",
  status("Start date (Optional)", "Carnegie Mellon University"));
// A label OCR did not place is far likelier to be our reader, a scroll cut, or an overlay merge
// than a real gap — blocking on it would fire on almost every long form.
check(`a label that could not be located is not a finding`, describeVerdicts(verifyFields(BLOCKS, [{ label: "Postal Code", value: "94085" }])).length === 0);
check(`a blank recorded value is skipped`, verifyFields(BLOCKS, [{ label: "Company (Optional)", value: "  " }]).length === 0);

console.log("\ncapability gates");
check(`paddleocr boxes are trusted`, boxesAreExact({ boxes: "exact" }) === true);
check(`a vision engine's boxes are NOT`, boxesAreExact({ boxes: "approximate" }) === false);
check(`literal text may be judged absent`, textIsLiteral({ textFidelity: "literal" }) === true);
check(`normalized text may NOT`, textIsLiteral({ textFidelity: "normalized" }) === false);
check(`no capability at all is not trusted`, boxesAreExact(undefined) === false);

console.log("\nplaceholder recognition");
check(`"MM/YYYY" is empty`, looksEmpty("MM/YYYY"));
check(`"Select..." is empty`, looksEmpty("Select..."));
check(`"Start typing" is empty`, looksEmpty("Start typing"));
check(`"Amazon" is not`, !looksEmpty("Amazon"));
check(`"3.44" is not`, !looksEmpty("3.44"));

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
