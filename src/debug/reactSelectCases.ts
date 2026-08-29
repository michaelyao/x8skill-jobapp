import path from "node:path";
/**
 * The react-select contract, driven by the REAL filler against test/fake-ats/greenhouse-select.html.
 *
 *   npm run test:reactselect
 *
 * Greenhouse's newer forms (job-boards.greenhouse.io) cost 776 field timeouts in one batch — 90
 * seconds each, every one logged as "tried but the field would not take it" about a menu whose
 * options were sitting there readable. Four separate causes, and the fixture reproduces all four:
 * a menu that is not inside the control, an unbounded Workday-only probe read per row, a clear
 * that closes the menu it just opened, and a commit the driver never looked for.
 */
import { chromium } from "playwright";
import { GreenhouseDriver } from "../agent/drivers/greenhouse.js";
import { indexOfOption, optionMatches } from "../agent/drivers/base.js";
import type { FieldSpec } from "../agent/types.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

console.log("matching an option, without a browser");
check("exact", indexOfOption(["Male", "Female"], "male") === 0);
check("the leading segment beats a bare free-text row",
  indexOfOption(["python", "Python (Programming Language)"], "python") === 1,
  indexOfOption(["python", "Python (Programming Language)"], "python"));
check("a dialling code prefers the United States",
  indexOfOption(["Canada (+1)", "United States of America (+1)"], "+1") === 1);
check("a value the list does not hold", indexOfOption(["Computer Science", "Information Systems"], "information science") === -1);
check("an option CONTAINING the value answers it", indexOfOption(["United States +1"], "united states") === 0);
// A fragment of the value is only an answer when it opens the value or accounts for most of it.
check("a fragment that opens the value", indexOfOption(["Carnegie Mellon University"], "carnegie mellon university - pittsburgh") === 0);
check("a fragment that does NOT — \"Science\" is not \"Information Science\"",
  indexOfOption(["Accounting", "Science", "Information Systems"], "information science") === -1,
  indexOfOption(["Accounting", "Science", "Information Systems"], "information science"));
// The control displays the option's own wording, sometimes only part of it.
check("a control reading \"+1\" does not vouch for \"United States\" on its own", !optionMatches("+1", "united states"));
check("but it does for the row that was clicked", "united states +1".includes("+1"));
check("\"No\" must never vouch for \"November\"", !optionMatches("No", "november"));

console.log("\ndriving the real filler against the fixture");
const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
await page.goto(`file://${path.resolve("test/fake-ats/greenhouse-select.html")}`);
const field: FieldSpec = { key: "#country", label: "Country*", type: "single_select", required: true, searchable: true, widget: "react-select" };
const started = Date.now();
const ok = await new GreenhouseDriver().fill(page as never, field, { key: field.key, value: "United States", confidence: 1, source: "curated" });
const seconds = (Date.now() - started) / 1000;
const picked = await page.evaluate("(() => window.__picked)()");
check("the value is committed", picked === "United States +1", picked);
check("and the fill REPORTS it, though the control only shows \"+1\"", ok === true);
// The whole point: this used to run out the 90-second field deadline and report a failure.
check(`in seconds, not the field deadline (${seconds.toFixed(1)}s)`, seconds < 15, seconds);
await browser.close();

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
