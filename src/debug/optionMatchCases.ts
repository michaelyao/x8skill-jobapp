import { optionForRecorded } from "../agent/llmAgent.js";

/**
 * Cases for matching a RECORDED answer to a closed list's own wording.  npm run test:options
 *
 * The field these exist for is "Country Phone Code*", which reported "no answer available" 130
 * times in one log while "United States of America (+1)" sat in the answer store: the guard that
 * stops us writing a value the widget cannot take refused every wording that was not identical,
 * and it refused in silence.
 */
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const m = (options: string[], value: string) => optionForRecorded(options, value);

const DIALLING = ["Afghanistan (+93)", "United States of America (+1)", "United Kingdom (+44)"];

console.log("the answer is on the menu");
check(`identical wording`, m(DIALLING, "United States of America (+1)").kind === "exact");
check(`the option's lead segment`, m(DIALLING, "United States of America").kind === "exact", m(DIALLING, "United States of America"));
check(`case and spacing do not matter`, m(DIALLING, "united states of america (+1)").kind === "exact");

console.log("\nthe same choice printed differently");
const CODES = ["+93", "+1", "+44"];
const one = m(CODES, "United States of America (+1)");
check(`a bare code list takes the code out of our answer`, one.kind === "reworded" && one.option === "+1", one);
const spelled = m(["United States of America (+1)"], "United States");
check(`an option that spells our answer out is adopted`, spelled.kind === "reworded" && spelled.option === "United States of America (+1)", spelled);

console.log("\nwhat it must refuse");
// A guess is worse than leaving the field: the turn loop reports it and the reviewer sees it.
check(`"+1" must not match "+12"`, m(["+12", "+13"], "Somewhere (+1)").kind === "absent", m(["+12", "+13"], "Somewhere (+1)"));
const amb = m(["United States of America (+1)", "United States Minor Outlying Islands (+1)"], "United States");
check(`two options our answer could name is ambiguous, not a pick`, amb.kind === "ambiguous", amb);
// The infix trap: adopting "Formal Verification" for a recorded "Verification" would upgrade the
// claim. Only a PREFIX counts, which is the same discipline the skills pruning uses in reverse.
check(`a recorded "Verification" does not become "Formal Verification"`, m(["Formal Verification"], "Verification").kind === "absent", m(["Formal Verification"], "Verification"));
// The word trap: a stored answer that MEANS empty must not tick "No" off a yes/no list.
check(`"none — no extension" does not become "No"`, m(["Yes", "No"], "none — no extension; leave this field empty").kind === "absent", m(["Yes", "No"], "none — no extension; leave this field empty"));
check(`an answer nothing offers`, m(DIALLING, "Narnia (+99)").kind === "absent");
check(`an empty recorded answer`, m(DIALLING, "   ").kind === "absent");

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
