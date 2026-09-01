import path from "node:path";
/**
 * Enter must never reach a form.  npm run test:enter
 *
 * On 29 August 2026 three applications were submitted to The Nuclear Company, three minutes apart,
 * with no approval and no record. The fill reached Greenhouse's EEO dropdowns, spent ninety seconds
 * per field pressing Enter at a menu that never opened, and Enter in a form control SUBMITS THE
 * FORM. The run reported "No next control — stopping"; the ledger wrote prefilled_pending_submit;
 * the debug screenshot said "Thank you for applying".
 *
 * SUBMIT_TEXT_BLOCKLIST could not have caught it: it guards CLICKS, and no click happened. The log
 * line "never clicked" was true and meaningless.
 *
 * The fixture is that form: a combobox whose menu never opens, on a page that submits on Enter.
 */
import { chromium } from "playwright";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import type { FieldSpec } from "../agent/types.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
await page.goto(`file://${path.resolve("test/fake-ats/greenhouse-enter-submits.html")}`);

const field: FieldSpec = { key: "#gender", label: "Gender", type: "single_select", required: false, searchable: true, widget: "react-select" };
const filled = await new GreenhouseDriver().fill(page as never, field, { key: field.key, value: "Male", confidence: 1, source: "curated" });
const submitted = await page.evaluate("(() => window.__submitted)()");

check("the value could not be set — the menu never opens", filled === false, filled);
// The fixture has a SECOND field with its menu open. A guard that asks "is any menu open on the
// page" is satisfied by that one and permits Enter on this one, which is how four applications went
// out at HP IQ hours after the guard was supposed to have closed this.
check("another field's open menu does not license Enter here", submitted === false, submitted);
// THE POINT OF THIS FILE.
check("and NOTHING was submitted", submitted === false, submitted);
check("the form is still on screen", (await page.locator("#app").isHidden().catch(() => true)) === false);

/**
 * And if something DOES submit — a keystroke this guard does not know about, a stray click, an ATS
 * that posts on blur — the run has to notice. Prevention alone is what failed on 29 August: every
 * run afterwards said "No next control — stopping" while the page said "Thank you for applying".
 */
console.log("\nnoticing a submission that should not have happened");
const driver = new GreenhouseDriver();
check("a form still on screen is not a confirmation", (await driver.submissionConfirmed(page as never)) === false);
await page.evaluate("(() => { document.getElementById('app').hidden = true; document.getElementById('done').hidden = false; })()");
check("a confirmation page IS recognised", (await driver.submissionConfirmed(page as never)) === true);
// The words on a form must never look like a confirmation.
await page.setContent('<body><h1>Application</h1><button>Submit application</button><p>Please review before you submit.</p></body>');
check('"Submit application" on a button is not a confirmation', (await driver.submissionConfirmed(page as never)) === false);

await browser.close();
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
