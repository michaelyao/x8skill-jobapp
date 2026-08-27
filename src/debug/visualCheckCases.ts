import { missingFromScreen, placeholdersShowing } from "../knowledge/visualCheck.js";

/**
 * Cases for the visual (OCR) cross-check.  npm run test:visual
 *
 * SCREEN is the real x8ocr output for the reported Workable experience entry — the same text the
 * service returned for screenshots/issue 2.png. It is the ideal fixture, because the bug is in it:
 * the page shows "MM/YYYY" for both dates while the run had recorded 08/2026 and 05/2028.
 *
 * As with the other guardrail suites, the "must stay quiet" cases carry the weight. This check can
 * block a finished application, so it must only fire when a value is definitely not on the screen.
 */
const SCREEN = `
<table border=1><tr><td>Title</td><td>Oct</td><td>Nov</td><td>Dec</td></tr><tr><td colspan="4">Software Engineering Intern, Shield Infrastruc</td></tr></table>

Company (Optional)

Amazon

## Industry (Optional)

Computer Software

## Summary (Optional)

CS undergraduate at Carnegie Mellon University (BS Information Systems, GPA 3.53, exp. May 2028)
with internship experience across real-time systems, data pipelines, and computer vision.

Start date (Optional)

MM/YYYY

End date (Optional)

MM/YYYY

☐ I currently work here

Update
`;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const gaps = (answers: Array<[string, string]>) =>
  missingFromScreen(answers.map(([label, value]) => ({ label, value })), SCREEN).map((g) => g.value);

console.log("must CATCH — recorded but not on the screen");
// The bug that started this: the run recorded these dates, the screen shows placeholders.
check(`a start date the screen shows as MM/YYYY`, gaps([["Start date (Optional)", "08/2026"]]).length === 1, gaps([["Start date (Optional)", "08/2026"]]));
check(`an end date the screen shows as MM/YYYY`, gaps([["End date (Optional)", "05/2028"]]).length === 1);
check(`a company that is not on the page`, gaps([["Company (Optional)", "TriState Capital Bank"]]).length === 1, gaps([["Company (Optional)", "TriState Capital Bank"]]));
check(`a degree that is not on the page`, gaps([["Degree (Optional)", "Bachelor of Science"]]).length === 1, gaps([["Degree (Optional)", "Bachelor of Science"]]));

console.log("\nmust stay QUIET");
check(`a company that IS on the page`, gaps([["Company (Optional)", "Amazon"]]).length === 0, gaps([["Company (Optional)", "Amazon"]]));
check(`a title that IS on the page`, gaps([["* Title", "Software Engineering Intern, Shield Infrastruc"]]).length === 0);
// A narrow input clips what it shows: the screen has "…Shield Infrastruc", the value is
// "…Shield Infrastructure". Demanding the whole string reported a filled field as missing — the
// first false positive this check produced.
check(`a value the input VISUALLY TRUNCATES is not called missing`,
  gaps([["* Title", "Software Engineering Intern, Shield Infrastructure"]]).length === 0,
  gaps([["* Title", "Software Engineering Intern, Shield Infrastructure"]]));
// Long free text re-flows through OCR; demanding an exact appearance would flag every application.
check(`a long cover letter is not checked`, gaps([["Cover letter", "x".repeat(400)]]).length === 0);
// Only factual fields are checked — a "how did you hear" answer may render as a collapsed control.
check(`a non-factual field is not checked`, gaps([["How did you hear about us?", "Nowhere At All"]]).length === 0, gaps([["How did you hear about us?", "Nowhere At All"]]));
check(`"Yes" is not expected to render as text`, gaps([["Degree", "Yes"]]).length === 0);
// Punctuation and case must not matter: the screen may render a different apostrophe or dash.
check(`folding ignores case and punctuation`, gaps([["Company (Optional)", "amazon"]]).length === 0);
check(`an empty OCR result blames nothing`, missingFromScreen([{ label: "* School", value: "Carnegie Mellon University" }], "").length === 0);

console.log("\nplaceholder detection");
check(`two MM/YYYY placeholders are reported`, /2 date field/.test(placeholdersShowing(SCREEN)[0] ?? ""), placeholdersShowing(SCREEN));
check(`a clean page reports none`, placeholdersShowing("First name Nathan Last name Yao").length === 0);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
