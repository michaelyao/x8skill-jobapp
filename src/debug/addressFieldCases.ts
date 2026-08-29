import { addressPartFor } from "../agent/llmAgent.js";

/**
 * Which fields the home address may answer.  npm run test:address
 *
 * Appian asked "Are you currently authorized to work in the city/country where this position is
 * located? *" — a required yes/no question — and the address block answered "Sunnyvale", three
 * passes in a row, because the label contains the word "city". The application stopped there.
 *
 * The rule is about SHAPE. An address field is a label: short, and not a question. Anything long
 * enough to be prose, or ending in "?", is asking about something else even when it mentions a
 * place. Matching by vocabulary alone cannot tell the two apart.
 */
const HOME = { street: "318 Morse Ave", city: "Sunnyvale", state: "California", postal: "94085" };

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const part = (label: string) => addressPartFor(label, HOME);

console.log("a field that NAMES an address part");
check(`"City"`, part("City") === "Sunnyvale");
check(`"City *"`, part("City *") === "Sunnyvale");
check(`"City/Town"`, part("City/Town") === "Sunnyvale");
check(`"Address Line 1"`, part("Address Line 1") === "318 Morse Ave");
check(`"Address Line 2" is deliberately EMPTY, not unanswered`, part("Address Line 2") === "");
check(`"State"`, part("State") === "California");
check(`"State (If N/A, Select Other)*"`, part("State (If N/A, Select Other)*") === "California");
check(`"Postal Code"`, part("Postal Code") === "94085");
check(`"Zip"`, part("Zip") === "94085");

console.log("\na field that merely MENTIONS one");
// The case this file exists for.
check(
  `"Are you currently authorized to work in the city/country where this position is located?"`,
  part("Are you currently authorized to work in the city/country where this position is located? *") === undefined,
  part("Are you currently authorized to work in the city/country where this position is located? *"),
);
check(
  `"What city would you like to work from? Please explain your reasoning."`,
  part("What city would you like to work from? Please explain your reasoning.") === undefined,
);
check(`"Are you willing to relocate to another state?"`, part("Are you willing to relocate to another state?") === undefined);
check(`"Which of our office locations is nearest your city?"`, part("Which of our office locations is nearest your city?") === undefined);
// Long, and not a question — still prose, still not a label.
check(
  `a long statement that mentions a city`,
  part("Please confirm the city and country in which you will be residing during the internship") === undefined,
);

console.log("\nunrelated fields are untouched");
check(`"First Name"`, part("First Name") === undefined);
check(`"Gender"`, part("Gender") === undefined);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
