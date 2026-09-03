/** `npm run test:chooser` — the RTX/Intel taxonomy chooser, and the lists it must not touch. */
import { isChooserRow, listChooserRow } from "../core/listChooser.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

console.log("the measured case");
const INTEL = ["Partial List (First 500 Entries)", "All"];
check(`Intel's Field of Study chooser is recognised`, listChooserRow(INTEL) === "All", listChooserRow(INTEL));
check(`it prefers "All" over the partial list`, listChooserRow(INTEL) === "All");
check(`"Partial List (First 500 Entries)" is a chooser row`, isChooserRow("Partial List (First 500 Entries)"));
check(`"All" is a chooser row`, isChooserRow("All"));
check(`a partial list alone still yields it`,
  listChooserRow(["Partial List (First 500 Entries)", "More"]) === "Partial List (First 500 Entries)");

console.log("\nlists it must leave alone");
check(`a real taxonomy page is not a chooser`,
  listChooserRow(["Accounting", "Actuarial Science", "Advertising", "Aerospace Engineering"]) === undefined);
check(`"All" among real answers is a real list`,
  listChooserRow(["All", "United States", "Canada"]) === undefined);
check(`a yes/no list is not a chooser`, listChooserRow(["Yes", "No"]) === undefined);
check(`one row is not a chooser`, listChooserRow(["All"]) === undefined);
check(`"No Items." alone is not a chooser`, listChooserRow(["No Items."]) === undefined);
check(`Michelin's major list is not a chooser`,
  listChooserRow(["Mechanical Engineering", "Computer Science, Computer Engineering", "Information Systems Technology"]) === undefined);
check(`"All Locations" is an answer, not navigation`, listChooserRow(["All Locations", "Remote"]) === undefined);
check(`a long meta-looking page is not treated as a chooser`,
  listChooserRow(["All", "More", "Partial List", "See all", "Browse all"]) === undefined);

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
