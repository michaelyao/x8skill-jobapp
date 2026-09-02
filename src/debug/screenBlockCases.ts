import { boxesAreExact, describeVerdicts, looksEmpty, textIsLiteral, unansweredOnScreen, valueBlockFor, verifyFields, type ScreenBlock } from "../knowledge/screenBlocks.js";

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

const gaps = (blocks: ScreenBlock[], answers: Array<{ label: string; value: string; type?: string }>): string[] =>
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

// LSWING (Ashby). "Location" labels two different things on one page: the JOB's location in the
// posting panel on the left, and the applicant's own Location field on the form to the right.
const TWICE_LABELLED: ScreenBlock[] = [
  { label: "text", text: "Location", box: [232, 236, 291, 255], order: 1 },
  { label: "text", text: "New York City", box: [232, 262, 348, 285], order: 3 },
  { label: "text", text: "Location $ ^{*} $", box: [534, 1117, 615, 1139], order: 28 },
];

console.log("\nthe same word can label two different things (LSWING)");
check(
  `the job's city does not contradict the applicant's location`,
  gaps(TWICE_LABELLED, [{ label: "Location", value: "Pittsburgh, PA" }]).length === 0,
  gaps(TWICE_LABELLED, [{ label: "Location", value: "Pittsburgh, PA" }]),
);
check(
  `the form's own field is the one that could not be read`,
  verifyFields(TWICE_LABELLED, [{ label: "Location", value: "Pittsburgh, PA" }])[0]?.status === "value-not-located",
  verifyFields(TWICE_LABELLED, [{ label: "Location", value: "Pittsburgh, PA" }])[0]?.status,
);
check(
  `and when one of them DOES hold the value, that is a match`,
  verifyFields([...TWICE_LABELLED, { label: "text", text: "Pittsburgh, PA", box: [534, 1145, 640, 1167], order: 29 }],
    [{ label: "Location", value: "Pittsburgh, PA" }])[0]?.status === "match",
);

// The same capture, with the form's Location field actually holding a value — a REAL difference,
// which must be described using the FORM's field and not the posting's heading further up.
const TWICE_LABELLED_FILLED: ScreenBlock[] = [
  ...TWICE_LABELLED,
  { label: "text", text: "United States", box: [550, 1164, 662, 1187], order: 29 },
  { label: "text", text: "Email $ ^{*} $", box: [534, 900, 600, 922], order: 20 },
  { label: "text", text: "nyao2@andrew.cmu.edu", box: [550, 947, 760, 970], order: 21 },
];
check(
  `a real difference is quoted from the FORM's field, not the posting heading`,
  gaps(TWICE_LABELLED_FILLED, [
    { label: "Email", value: "nyao2@andrew.cmu.edu" },
    { label: "Location", value: "Pittsburgh, PA" },
  ])[0] === '"Location" was recorded as "Pittsburgh, PA" but the screen shows "United States"',
  gaps(TWICE_LABELLED_FILLED, [
    { label: "Email", value: "nyao2@andrew.cmu.edu" },
    { label: "Location", value: "Pittsburgh, PA" },
  ]),
);

/**
 * OMISSION, which the other direction cannot see.
 *
 * verifyFields walks OUR answers, so a question the reader never found is never examined. Five
 * REQUIRED questions on one Ashby form reached review that way with nothing filled and nothing
 * reported. This reads from the SCREEN instead.
 */
const REQUIRED_ON_SCREEN: ScreenBlock[] = [
  { label: "text", text: "Do you currently reside in Houston, TX?*", box: [532, 400, 900, 424], order: 1 },
  { label: "text", text: "Yes No", box: [532, 430, 660, 460], order: 2 },
  { label: "text", text: "Will you now or in the future require sponsorship for employment visa status?*", box: [532, 500, 1100, 524], order: 3 },
  { label: "text", text: "Name*", box: [532, 600, 620, 624], order: 4 },
  { label: "text", text: "Nathan Yao", box: [532, 630, 700, 654], order: 5 },
  { label: "title", text: "ADDITIONAL QUESTIONS*", box: [532, 700, 800, 730], order: 6 },
  { label: "text", text: "Twitter", box: [532, 760, 620, 784], order: 7 },
];

console.log("\nquestions the form REQUIRES that we never answered");
const un = unansweredOnScreen(REQUIRED_ON_SCREEN, [{ label: "Name", value: "Nathan Yao" }]);
check(`the Houston question is reported`, un.some((g) => /Houston/.test(g)), un);
check(`so is the sponsorship question`, un.some((g) => /sponsorship/.test(g)), un);
check(`a question we DID answer is not`, !un.some((g) => /"Name/.test(g)), un);
check(`an optional field is not — no marker, no complaint`, !un.some((g) => /Twitter/.test(g)), un);
check(`a section heading is not a question`, !un.some((g) => /ADDITIONAL/.test(g)), un);
check(`exactly the two`, un.length === 2, un);
// OCR clips a long question at the end and mangles the character it clips through, so neither
// string contains the other. Every long question on a form would otherwise raise a false gap.
const CLIPPED: ScreenBlock[] = [
  { label: "text", text: "Will you now or in the future require sponsorship for employment visa stat H*", box: [532, 400, 1100, 424], order: 1 },
];
check(`a question OCR clipped mid-word still counts as answered`,
  unansweredOnScreen(CLIPPED, [
    { label: "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?", value: "No" },
  ]).length === 0,
  unansweredOnScreen(CLIPPED, [{ label: "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?", value: "No" }]));
// But a genuinely different question that merely starts alike is still reported.
check(`two questions with different openings are not confused`,
  unansweredOnScreen(CLIPPED, [{ label: "Do you currently reside in Houston, TX?", value: "No" }]).length === 1);

// Measured on the queue: of twelve findings, eight were the checker's limits rather than the form's
// faults — and a check that cries wolf is one nobody reads.
console.log("\nnoise the check must not make");
const CLIPPED_START: ScreenBlock[] = [
  { label: "text", text: "hat pronouns would you like our team to use when addressing you?*", box: [532, 400, 1100, 424], order: 1 },
];
// The real block from Notion: clipped in front, "NY" misread as "IY", and three words dropped from
// the middle. Openings, closings and a fixed middle window each fail on it — words survive.
const MANGLED: ScreenBlock[] = [
  { label: "text", text: "quires that you are willing to relocate to one of the following locations IY, USA or San Francisco, CA, USA. Please confirm that you are willing to this role?*", box: [532, 400, 1200, 460], order: 1 },
];
check(`a question damaged at both ends AND inside still counts as answered`,
  unansweredOnScreen(MANGLED, [{ label: "This role requires that you are willing to relocate to one of the following locations New York, NY, USA or San Francisco, CA, USA. Please confirm that you are willing to relocate for this role", value: "Yes" }]).length === 0,
  unansweredOnScreen(MANGLED, [{ label: "This role requires that you are willing to relocate to one of the following locations New York, NY, USA or San Francisco, CA, USA. Please confirm that you are willing to relocate for this role", value: "Yes" }]));
check(`but a genuinely different question is still reported`,
  unansweredOnScreen(MANGLED, [{ label: "What pronouns would you like our team to use when addressing you?", value: "He/Him" }]).length === 1);

check(`a label OCR clipped at the START still counts as answered`,
  unansweredOnScreen(CLIPPED_START, [{ label: "What pronouns would you like our team to use when addressing you?", value: "He/Him" }]).length === 0,
  unansweredOnScreen(CLIPPED_START, [{ label: "What pronouns would you like our team to use when addressing you?", value: "He/Him" }]));
// A yes/no pair renders BOTH words and marks the choice by colour, which this engine does not read.
const YESNO_PAIR: ScreenBlock[] = [
  { label: "text", text: "Are you legally authorized to work in the United States?", box: [532, 400, 1100, 424], order: 1 },
  { label: "text", text: "Yes No", box: [532, 430, 640, 456], order: 2 },
];
check(`"Yes No" beside a field we answered "Yes" is not a finding`,
  describeVerdicts(verifyFields(YESNO_PAIR, [{ label: "Are you legally authorized to work in the United States?", value: "Yes" }])).length === 0);
check(`it reads as unlocated, which is the truth`,
  verifyFields(YESNO_PAIR, [{ label: "Are you legally authorized to work in the United States?", value: "Yes" }])[0]?.status === "value-not-located");
// But a real value beside the label is still compared.
check(`a genuine mismatch is still reported`,
  describeVerdicts(verifyFields([YESNO_PAIR[0], { label: "text", text: "Canada", box: [532, 430, 640, 456], order: 2 }],
    [{ label: "Are you legally authorized to work in the United States?", value: "Yes" }])).length === 1);

// Two findings on the queue that were about our reader, not the form.
console.log("\nblocks that cannot stand in for a value");
const JUNK: ScreenBlock[] = [
  { label: "text", text: "Email*", box: [532, 400, 620, 424], order: 1 },
  { label: "text", text: "- α-Δ-ε", box: [532, 430, 700, 456], order: 2 },
  { label: "text", text: "nyao2@andrew.cmu.edu", box: [532, 462, 800, 488], order: 3 },
];
check(`OCR garbage is skipped, and the real value below it is found`,
  verifyFields(JUNK, [{ label: "Email", value: "nyao2@andrew.cmu.edu" }])[0]?.status === "match",
  verifyFields(JUNK, [{ label: "Email", value: "nyao2@andrew.cmu.edu" }])[0]);
const TABLE: ScreenBlock[] = [
  { label: "text", text: "LinkedIn Profile", box: [532, 400, 700, 424], order: 1 },
  { label: "table", text: "<table><tr><td>Yesserday</td></tr></table>", box: [532, 430, 900, 470], order: 2 },
];
check(`a merged table block is not this field's value`,
  describeVerdicts(verifyFields(TABLE, [{ label: "LinkedIn Profile", value: "https://www.linkedin.com/in/nathandyao" }])).length === 0,
  verifyFields(TABLE, [{ label: "LinkedIn Profile", value: "https://www.linkedin.com/in/nathandyao" }])[0]);

console.log("\na radio group renders EVERY option, so a nearby row is not the answer");
/**
 * JNBEPY on the real queue: "What is your current US work authorization?" was recorded as
 * "US Citizen / Permanent Resident" and reported against the "H-1B" row sitting under the label.
 * Every option of a radio group is on the screen and this engine reports no selection state, so
 * the row is not evidence either way.
 */
const RADIO: ScreenBlock[] = [
  { label: "text", text: "What is your current US work authorization?", box: [100, 200, 600, 230], order: 1 },
  { label: "text", text: "H-1B", box: [120, 250, 220, 278], order: 2 },
];
const AUTH = "US Citizen / Permanent Resident";
check(`a radio row that is not our answer is unlocatable, not a difference`,
  verifyFields(RADIO, [{ label: "What is your current US work authorization?", value: AUTH, type: "radio" }])[0]?.status === "value-not-located",
  verifyFields(RADIO, [{ label: "What is your current US work authorization?", value: AUTH, type: "radio" }])[0]);
check(`and it is not reported`,
  gaps(RADIO, [{ label: "What is your current US work authorization?", value: AUTH, type: "radio" }]).length === 0);
// A SELECT commits its value into the control, which is how the false-success bug was caught.
// Radio is the only widget that shows all of its options, so only radio gets the exemption.
check(`a SELECT showing the wrong value is still a difference`,
  verifyFields(RADIO, [{ label: "What is your current US work authorization?", value: AUTH, type: "select" }])[0]?.status === "different",
  verifyFields(RADIO, [{ label: "What is your current US work authorization?", value: AUTH, type: "select" }])[0]);
check(`an untyped answer is still judged`,
  verifyFields(RADIO, [{ label: "What is your current US work authorization?", value: AUTH }])[0]?.status === "different");

/** CKVKRC: the "○" makes the row a CONTROL, whatever the recorded type says. */
const UNSET: ScreenBlock[] = [
  { label: "text", text: "Veteran Status", box: [100, 200, 300, 230], order: 1 },
  { label: "text", text: "\u25cb I identify as one or more of the classifications of protected veteran listed above", box: [120, 250, 900, 282], order: 2 },
];
check(`a row carrying an unselected glyph is never the value`,
  verifyFields(UNSET, [{ label: "Veteran Status", value: "I am not a protected veteran" }])[0]?.status === "value-not-located",
  verifyFields(UNSET, [{ label: "Veteran Status", value: "I am not a protected veteran" }])[0]);

console.log("\na clipped essay with one OCR-mangled word is still our answer");
/**
 * RKEZBD and BFXCLX: the textarea was scrolled to the caret, so the box shows the TAIL, and OCR
 * mangled the word it clipped through ("zero-direct" for "zero-defect"). Exact-substring tolerance
 * failed on that one character and reported two correct essays as wrong.
 */
const ESSAY = "At Gravitas Medical, I built an automated computer vision pipeline using OpenCV and Meta's Segment Anything model to measure precise millimeter distances between electrodes on medical feeding tubes. It automated the analysis of monthly shipments of wires, eliminating days of manual QA work. Medical devices demand zero-defect precision, and building a system reliable enough to replace human judgment in that context was both technically demanding and genuinely meaningful.";
const CLIPPED_ESSAY: ScreenBlock[] = [
  { label: "text", text: "What's something you worked on that you were proud of?", box: [100, 200, 700, 230], order: 1 },
  { label: "text", text: "QA work. Medical devices demand zero-direct precision, and building a system reliable enough to replace human judgment in that context was both technically demanding and genuinely meaningful.", box: [110, 250, 950, 400], order: 2 },
];
check(`the mangled tail of our own essay is a match`,
  verifyFields(CLIPPED_ESSAY, [{ label: "What's something you worked on that you were proud of?", value: ESSAY }])[0]?.status === "match",
  verifyFields(CLIPPED_ESSAY, [{ label: "What's something you worked on that you were proud of?", value: ESSAY }])[0]);

console.log("\na checkbox group is read from its GLYPHS, never the `checked` flag");
/**
 * Every string here is verbatim from the captures, re-OCR'd from the saved review screenshots.
 * The engine's own capability note says it has no notion of checkbox state, and `checked` is true
 * whenever ANYTHING in a merged region is ticked — which is how one Sierra application produced
 * three findings claiming boxes were ticked that the capture plainly shows empty.
 */
const SIERRA_VISA: ScreenBlock[] = [
  { label: "checkbox", text: "Will you now or in the future require visa sponsorship to work in the United States?*\n☐ Yes\n☑ No", box: [533, 2291, 1208, 2384], order: 11, checked: true },
];
check(`the tick is on "No" and we recorded No — a match, though the flag says checked`,
  verifyFields(SIERRA_VISA, [{ label: "Will you now or in the future require visa sponsorship to work in the United States?", value: "No" }])[0]?.status === "match",
  verifyFields(SIERRA_VISA, [{ label: "Will you now or in the future require visa sponsorship to work in the United States?", value: "No" }])[0]);

const SIERRA_ORIENTATION: ScreenBlock[] = [
  { label: "checkbox", text: "How do you identify your sexual orientation? Please select all that apply\n☐ Bisexual\n☐ Lesbian\n☐ Gay\n☐ Queer", box: [533, 5447, 1110, 5716], order: 26, checked: true },
];
check(`"☐ Bisexual" against a recorded No is a match, not a false claim`,
  verifyFields(SIERRA_ORIENTATION, [{ label: "How do you identify your sexual orientation? Please select all that apply. — Bisexual", value: "No" }])[0]?.status === "match",
  verifyFields(SIERRA_ORIENTATION, [{ label: "How do you identify your sexual orientation? Please select all that apply. — Bisexual", value: "No" }])[0]);

// The capture's region [27] is a CONTINUATION with no question in it, so a recorded label can
// never match it and it is never reported — correct, and not a finding. The ticked path is worth
// testing on the shape that DOES carry its question, as regions [26] and [28] do.
const SIERRA_RACE: ScreenBlock[] = [
  { label: "checkbox", text: "What is your race or ethnicity? Please select all that apply.\n✓ Asian or Asian American\n☐ Black or African American\n☐ Hispanic or Latine", box: [533, 5758, 890, 6018], order: 27, checked: true },
];
check(`a row that IS ticked and was recorded Yes is a match`,
  verifyFields(SIERRA_RACE, [{ label: "What is your race or ethnicity? Please select all that apply. — Asian or Asian American", value: "Yes" }])[0]?.status === "match",
  verifyFields(SIERRA_RACE, [{ label: "What is your race or ethnicity? Please select all that apply. — Asian or Asian American", value: "Yes" }])[0]);
check(`the same ticked row recorded as No IS a difference`,
  verifyFields(SIERRA_RACE, [{ label: "What is your race or ethnicity? Please select all that apply. — Asian or Asian American", value: "No" }])[0]?.status === "different",
  verifyFields(SIERRA_RACE, [{ label: "What is your race or ethnicity? Please select all that apply. — Asian or Asian American", value: "No" }])[0]);

// N1: the Yes box is EMPTY and Yes is what we recorded. This one is real and must survive.
const N1_RELOCATE: ScreenBlock[] = [
  { label: "checkbox", text: "Are you willing to relocate to NYC (if not in NYC already)?*\n☐ Yes", box: [532, 4000, 1200, 4090], order: 30, checked: false },
];
check(`"☐ Yes" against a recorded Yes is a REAL difference`,
  verifyFields(N1_RELOCATE, [{ label: "Are you willing to relocate to NYC (if not in NYC already)?", value: "Yes" }])[0]?.status === "different",
  verifyFields(N1_RELOCATE, [{ label: "Are you willing to relocate to NYC (if not in NYC already)?", value: "Yes" }])[0]);
check(`and it IS reported`,
  gaps(N1_RELOCATE, [{ label: "Are you willing to relocate to NYC (if not in NYC already)?", value: "Yes" }]).length === 1);

// Zip: a bare box with no option text beside it cannot say which option it is.
const ZIP_AUTH: ScreenBlock[] = [
  { label: "checkbox", text: "Are you currently authorized to work in the United States?*\n☐", box: [532, 3000, 1200, 3080], order: 24, checked: false },
];
check(`a bare "☐" with no option text is unreadable, not a fault`,
  verifyFields(ZIP_AUTH, [{ label: "Are you currently authorized to work in the United States?", value: "Yes" }])[0]?.status === "value-not-located",
  verifyFields(ZIP_AUTH, [{ label: "Are you currently authorized to work in the United States?", value: "Yes" }])[0]);

// DV Trading: a graduation date paired with a checkbox region is a bad pairing, not a bad form.
const DV_GRAD: ScreenBlock[] = [
  { label: "checkbox", text: "Please re-confirm your expected graduation date*\n☐ I confirm", box: [532, 900, 1200, 980], order: 5, checked: true },
];
check(`a date recorded against a checkbox region is unreadable`,
  verifyFields(DV_GRAD, [{ label: "Please re-confirm your expected graduation date", value: "January 2028 - July 2028" }])[0]?.status === "value-not-located",
  verifyFields(DV_GRAD, [{ label: "Please re-confirm your expected graduation date", value: "January 2028 - July 2028" }])[0]);

console.log("\nthe yes/no pair, however OCR splits it");
/**
 * Pylon (Ashby), verbatim: the two buttons are SEPARATE blocks at the same y. The rule that
 * already existed needed both words in one block, so this went unhandled and the checker quoted
 * whichever was nearer — reporting a US citizen as requiring visa sponsorship on four
 * applications.
 */
const ASHBY_PAIR: ScreenBlock[] = [
  { label: "text", text: "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)? $ ^{*} $", box: [532, 1354, 1195, 1398], order: 35 },
  { label: "text", text: "Yes", box: [559, 1426, 593, 1447], order: 36 },
  { label: "text", text: "No", box: [640, 1425, 669, 1449], order: 37 },
];
const SPONSOR = "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?";
check(`Yes and No as two blocks is unreadable, not the opposite answer`,
  verifyFields(ASHBY_PAIR, [{ label: SPONSOR, value: "No" }])[0]?.status === "value-not-located",
  verifyFields(ASHBY_PAIR, [{ label: SPONSOR, value: "No" }])[0]);
check(`and nothing is reported`, gaps(ASHBY_PAIR, [{ label: SPONSOR, value: "No" }]).length === 0);

/** Circleback: "Yes" must not prefix-match "Yes, but I will need sponsorship". */
const CIRCLEBACK: ScreenBlock[] = [
  { label: "checkbox", text: "Are you authorized to work in the United States?*\nWe can transfer work visas and we will sponsor visas.\n○ Yes, but I will need sponsorship\n○ No", box: [531, 1730, 950, 1921], order: 32, checked: false },
];
check(`a bare "Yes" does not match the "Yes, but…" row`,
  verifyFields(CIRCLEBACK, [{ label: "Are you authorized to work in the United States? We can transfer work visas and we will sponsor visas.", value: "Yes" }])[0]?.status === "value-not-located",
  verifyFields(CIRCLEBACK, [{ label: "Are you authorized to work in the United States? We can transfer work visas and we will sponsor visas.", value: "Yes" }])[0]);

console.log("\na posting heading is not a form field");
/** HP IQ, verbatim: "Why HP IQ?" is a heading in the DESCRIPTION column, blurb underneath. */
const HP_POSTING: ScreenBlock[] = [
  { label: "title", text: "Why HP IQ?", box: [292, 2382, 390, 2422], order: 25 },
  { label: "text", text: "HP IQ is HP's new AI innovation lab, building the intelligence to empower humanity—reimagining how we work, create, and connect to shape the future of work.", box: [294, 2420, 1116, 2478], order: 26 },
];
const ESSAY_HP = "HP IQ sits at the intersection of AI and real hardware — exactly where I want to build. My work at Gravitas Medical processing binary sensor logs from medical feeding tubes and building computer-vision pipelines taught me that the most impactful software runs close to the metal.";
check(`the employer's own blurb is not quoted as our answer`,
  verifyFields(HP_POSTING, [{ label: "Why HP IQ?", value: ESSAY_HP }])[0]?.status === "value-not-located",
  verifyFields(HP_POSTING, [{ label: "Why HP IQ?", value: ESSAY_HP }])[0]);
// The exemption is for WRITTEN answers only: a heading with a short value and a short box under
// it is still judged. (A long blurb against a short value is caught earlier, by the prose rule.)
const HEADING_SHORT: ScreenBlock[] = [
  { label: "title", text: "Current location", box: [292, 400, 460, 430], order: 4 },
  { label: "text", text: "New York City", box: [294, 445, 430, 470], order: 5 },
];
check(`a short answer under a heading is still judged`,
  verifyFields(HEADING_SHORT, [{ label: "Current location", value: "Sunnyvale, CA" }])[0]?.status === "different",
  verifyFields(HEADING_SHORT, [{ label: "Current location", value: "Sunnyvale, CA" }])[0]);

console.log("\nthe fixes must not silence a real gap");
// The new rules must not swallow the cases they resemble.
const OTHER_ESSAY: ScreenBlock[] = [
  { label: "text", text: "What's something you worked on that you were proud of?", box: [100, 200, 700, 230], order: 1 },
  { label: "text", text: "I spent the summer rebuilding our warehouse routing service in Go, cutting median pick time by a third and writing the load tests that proved it before we shipped to the Dallas site.", box: [110, 250, 950, 400], order: 2 },
];
check(`a DIFFERENT long answer is still a difference`,
  verifyFields(OTHER_ESSAY, [{ label: "What's something you worked on that you were proud of?", value: ESSAY }])[0]?.status === "different",
  verifyFields(OTHER_ESSAY, [{ label: "What's something you worked on that you were proud of?", value: ESSAY }])[0]);
const TICKED: ScreenBlock[] = [
  { label: "text", text: "Which communities do you belong to?", box: [100, 200, 500, 230], order: 1 },
  { label: "checkbox", text: "Person with disability", box: [110, 250, 400, 280], order: 2, checked: true },
];
check(`a box we recorded as No but the screen shows TICKED is still reported`,
  gaps(TICKED, [{ label: "Which communities do you belong to?", value: "No" }]).length === 1,
  gaps(TICKED, [{ label: "Which communities do you belong to?", value: "No" }]));

// Same real blocks, a value that genuinely is not there. If these pass, the change has only
// removed findings that were never about the form.
check(`a wrong location is still a difference`, gaps(ASHBY, [{ label: "Current location", value: "Sunnyvale, CA" }]).length === 1, gaps(ASHBY, [{ label: "Current location", value: "Sunnyvale, CA" }]));
check(`the MM/YYYY placeholders are still reported`, gaps(BLOCKS, [{ label: "Start date (Optional)", value: "08/2026" }, { label: "End date (Optional)", value: "05/2028" }]).length === 2);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
