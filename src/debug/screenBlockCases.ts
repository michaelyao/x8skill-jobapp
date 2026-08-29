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

/**
 * Three live captures that each produced a FALSE finding, and the false finding is the case.
 *
 * All three sat in "not ready to review" — an application that is actually finished, held out of the
 * queue by our own reader. Blocks are verbatim from x8ocr on the review screenshot the run itself
 * took (the review-CODE.png in that run's log directory), sliced to the region that misfired.
 */

// REEHHB (Ashby). "Name" was reported as showing "Current location" — the label of the NEXT field,
// 299px below, because the name input's own text was never detected.
const ASHBY: ScreenBlock[] = [
  { label: "title", text: "Name $ ^{*} $", box: [534, 426, 593, 451], order: 13 },
  { label: "text", text: "Current location", box: [535, 750, 669, 778], order: 14 },
  { label: "text", text: "Pittsburgh, PA", box: [552, 793, 667, 821], order: 15 },
];

// QHKEQP (Workday). Every finding paired a question with a SECTION HEADING, and one question block
// had swallowed its own answer.
const WORKDAY: ScreenBlock[] = [
  { label: "other", text: "Do you have any, or anticipate any upcoming offer deadlines?\n\nYes\n\nNo\n\nIf so, what are the dates?\n\nAugust 1 - August 15\n\nAugust 16 - August 31\n\nWhat is your anticipated start date? (Month/Year)", box: [336, 3044, 1119, 4111], order: 3 },
  { label: "title", text: "EARLY TALENT - PREFERRED LOCATIONS", box: [334, 4237, 688, 4295], order: 4 },
  { label: "title", text: "High School Name", box: [334, 5667, 473, 5723], order: 7 },
  { label: "title", text: "UNIVERSITY", box: [335, 6066, 448, 6121], order: 8 },
  { label: "text", text: "Which university are you currently attending or did you last attend? Please select \"Other (School Not Listed)\" if your school is not listed.*\nCarnegie Mellon University - Pittsburgh", box: [336, 6145, 1113, 6255], order: 9 },
  { label: "title", text: "YEAR OF GRADUATION", box: [336, 6335, 540, 6404], order: 10 },
  { label: "text", text: "Please include your intended graduation year for the degree or relevant learning program that you are currently pursuing or have completed. *", box: [337, 6420, 1059, 6496], order: 11 },
  { label: "title", text: "ADDITIONAL QUESTIONS - EARLY TALENT (PD)", box: [334, 6877, 736, 6933], order: 12 },
];

// UPIKJL. The textarea was scrolled to the caret, so the box shows the value's TAIL — and OCR
// mangled the character it clipped through ("‘acking" for "…tracking").
const SCROLLED: ScreenBlock[] = [
  { label: "text", text: "(Optionally) include a short description of the work you're proudest of", box: [533, 1177, 1100, 1202], order: 31 },
  { label: "text", text: "‘acking, reaching 200+ community members and helping secure $2,000 in grants.", box: [549, 1224, 1190, 1249], order: 32 },
  { label: "title", text: "What other internship times are you open to?", box: [532, 1285, 902, 1309], order: 33 },
];

const PROUDEST = "(Optionally) include a short description of the work you're proudest of";
const PROUDEST_VALUE =
  "At Gravitas Medical, I built an automated computer vision pipeline using OpenCV and Meta's Segment Anything model to measure precise millimeter distances between electrodes on medical feeding tubes—automating the analysis of monthly shipments and eliminating days of manual QA work. I'm also proud of the Alviso Environmental Monitoring Dashboard, where I integrated SparkFun sensors with Raspberry Pi devices and built a Python RESTful API for real-time air and noise quality tracking, reaching 200+ community members and helping secure $2,000 in grants.";

const gaps = (blocks: ScreenBlock[], answers: Array<{ label: string; value: string }>): string[] =>
  describeVerdicts(verifyFields(blocks, answers));

console.log("\nthe next field's label is not this field's value (REEHHB)");
check(
  `"Name" 299px above "Current location" is not a pairing`,
  gaps(ASHBY, [{ label: "Name", value: "Nathan Yao" }]).length === 0,
  gaps(ASHBY, [{ label: "Name", value: "Nathan Yao" }]),
);
check(
  `the field below still reads its own value`,
  verifyFields(ASHBY, [{ label: "Current location", value: "Pittsburgh, PA" }])[0]?.status === "match",
);

console.log("\na section heading is not a value (QHKEQP)");
const WORKDAY_ANSWERS = [
  { label: "Do you have any, or anticipate any upcoming offer deadlines? ✱", value: "No" },
  { label: "High School Name ✱", value: "Summit Public Schools: Tahoma" },
  { label: "Which university are you currently attending or did you last attend? Please select \"Other (School Not Listed)\" if your school is not listed.", value: "Carnegie Mellon University - Pittsburgh" },
  { label: "Please include your intended graduation year for the degree or relevant learning program that you are currently pursuing or have completed.", value: "2028" },
];
check(`all five findings on this capture were ours, not the form's`, gaps(WORKDAY, WORKDAY_ANSWERS).length === 0, gaps(WORKDAY, WORKDAY_ANSWERS));
check(
  `a question block that swallowed its own answer counts as filled`,
  verifyFields(WORKDAY, [WORKDAY_ANSWERS[2]])[0]?.status === "match",
);
check(
  `a heading below a label leaves the value unlocated, not empty`,
  verifyFields(WORKDAY, [WORKDAY_ANSWERS[1]])[0]?.status === "value-not-located",
  verifyFields(WORKDAY, [WORKDAY_ANSWERS[1]])[0]?.status,
);

console.log("\na textarea scrolled to its caret shows the TAIL (UPIKJL)");
check(`the tail of a long value still matches`, gaps(SCROLLED, [{ label: PROUDEST, value: PROUDEST_VALUE }]).length === 0, gaps(SCROLLED, [{ label: PROUDEST, value: PROUDEST_VALUE }]));
check(
  `a DIFFERENT long value is still caught`,
  verifyFields(SCROLLED, [{ label: PROUDEST, value: "I rewrote our billing system in Rust over one weekend and cut the monthly invoice run from six hours to nine minutes." }])[0]?.status === "different",
);

// NJQUXB. A question, then a sentence of guidance, then a Yes/No control OCR never detected.
const HELPED: ScreenBlock[] = [
  { label: "text", text: "Can you work on-site in San Francisco during the week?*", box: [532, 1475, 990, 1499], order: 30 },
  { label: "text", text: "Our office is about a 10 minute walk from the Ferry Building", box: [532, 1505, 941, 1526], order: 31 },
  { label: "text", text: "Do you have personal website, X account, or any public writing we can check out?", box: [533, 1618, 1188, 1641], order: 32 },
];

console.log("\nguidance under a question is not its answer (NJQUXB)");
check(
  `"Yes" against a sentence about the Ferry Building is not a difference`,
  gaps(HELPED, [{ label: "Can you work on-site in San Francisco during the week?", value: "Yes" }]).length === 0,
  gaps(HELPED, [{ label: "Can you work on-site in San Francisco during the week?", value: "Yes" }]),
);
check(
  `it reads as unlocated, which is what it is`,
  verifyFields(HELPED, [{ label: "Can you work on-site in San Francisco during the week?", value: "Yes" }])[0]?.status === "value-not-located",
);
// A long answer to a long question is still checked — the rule is about SHORT values under prose.
check(
  `a long recorded value is still compared`,
  verifyFields(HELPED, [{ label: "Can you work on-site in San Francisco during the week?", value: "I would prefer to work remotely for most of the week" }])[0]?.status === "different",
  verifyFields(HELPED, [{ label: "Can you work on-site in San Francisco during the week?", value: "I would prefer to work remotely for most of the week" }])[0]?.status,
);
// The value may sit BELOW the helper text rather than instead of it.
const HELPED_ANSWERED: ScreenBlock[] = [
  ...HELPED.slice(0, 2),
  { label: "text", text: "Yes", box: [532, 1540, 590, 1562], order: 31.5 },
];
check(
  `a value under the guidance is still found`,
  verifyFields(HELPED_ANSWERED, [{ label: "Can you work on-site in San Francisco during the week?", value: "Yes" }])[0]?.status === "match",
  verifyFields(HELPED_ANSWERED, [{ label: "Can you work on-site in San Francisco during the week?", value: "Yes" }])[0]?.status,
);

console.log("\nthe fixes must not silence a real gap");
// Same real blocks, a value that genuinely is not there. If these pass, the change has only
// removed findings that were never about the form.
check(`a wrong location is still a difference`, gaps(ASHBY, [{ label: "Current location", value: "Sunnyvale, CA" }]).length === 1, gaps(ASHBY, [{ label: "Current location", value: "Sunnyvale, CA" }]));
check(`the MM/YYYY placeholders are still reported`, gaps(BLOCKS, [{ label: "Start date (Optional)", value: "08/2026" }, { label: "End date (Optional)", value: "05/2028" }]).length === 2);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
