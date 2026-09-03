/**
 * `npm run test:dateparts` — the measured Michelin case and its neighbours.
 *
 * "09" / "03" / "2026" committed on the same page that refused "1" and "4", which is what
 * identified the two-digit spinbutton as the cause rather than the widget or the label.
 */
import { datePartOf, datePartValue } from "../core/dateParts.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const v = (l: string, x: string) => datePartValue(l, x);

console.log("recognising a date PART");
check(`a qualified Workday month tail`,
  datePartOf("Start Date — From* — Work Experience — Month") === "month");
check(`a qualified year tail`,
  datePartOf("first Year Attended — From — Education — Year") === "year");
check(`a bare "Month"`, datePartOf("Month") === "month");
check(`an asterisked bare "Day*"`, datePartOf("Day*") === "day");
check(`"Month of graduation" is a QUESTION, not a spinbutton`,
  datePartOf("Month of graduation") === undefined);
check(`"When do you graduate?" is not a date part`,
  datePartOf("When do you graduate?") === undefined);

console.log("\nthe values Michelin refused");
check(`"1" pads to "01"`, v("Start Date — From* — Work Experience — Month", "1") === "01");
check(`"4" pads to "04"`, v("End Date — To* — Work Experience — Month", "4") === "04");
check(`"09" is already right and is untouched`,
  v("Signed On — Date* — Month", "09") === "09");
check(`"03" day untouched`, v("Signed On — Date* — Day", "03") === "03");
check(`"2025" year untouched`, v("Start Date — From* — Work Experience — Year", "2025") === "2025");
check(`"12" month untouched`, v("Month", "12") === "12");

console.log("\nnames, junk and things it must not invent");
check(`"January" becomes "01"`, v("Month", "January") === "01");
check(`"Sep" becomes "09"`, v("Month", "Sep") === "09");
check(`"jan" becomes "01"`, v("Month", "jan") === "01");
check(`a month of 13 is left alone rather than padded into nonsense`, v("Month", "13") === "13");
check(`a day of 40 is left alone`, v("Day", "40") === "40");
check(`"May 2025" in a year field yields the year`,
  v("Education — Year", "May 2025") === "2025");
check(`an empty value stays empty`, v("Month", "") === "");
check(`prose is not mangled into a number`,
  v("Month", "whenever you need me") === "whenever you need me");
check(`a non-date field is passed straight through`,
  v("Company", "Michelin") === "Michelin");

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
