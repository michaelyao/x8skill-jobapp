import { bandContains, checkFacts, degreeLevel, parseGpaBand } from "../core/factChecks.js";

/**
 * Cases for the fact checks.  npm run test:facts
 *
 * Each "must catch" case below is a value that was really submitted on a live application. Each
 * "must stay quiet" case is a correct answer that must not be blocked — the balance matters,
 * because a check that fires on a right answer stops the pipeline on jobs that were ready.
 */
const FACTS = { degree: "Bachelor of Science", fieldOfStudy: "Information Systems", gpa: "3.53" };

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const codes = (answers: Array<[string, string, string[]?]>) =>
  checkFacts(answers.map(([label, value, options]) => ({ label, value, options })), FACTS)
    .map((p) => p.code)
    .sort();

console.log("degree level classification");
check(`"B.S." is a bachelor's`, degreeLevel("B.S.") === "bachelor", degreeLevel("B.S."));
check(`"Bachelor of Science" is a bachelor's`, degreeLevel("Bachelor of Science") === "bachelor");
check(`"Bachelors" is a bachelor's`, degreeLevel("Bachelors") === "bachelor");
check(`"Associate's Degree" is an associate`, degreeLevel("Associate's Degree") === "associate", degreeLevel("Associate's Degree"));
check(`"Associate of Science" is NOT read as a bachelor's`, degreeLevel("Associate of Science") === "associate", degreeLevel("Associate of Science"));
check(`"Master of Science" is a master's`, degreeLevel("Master of Science") === "master");
check(`"PhD" is a doctorate`, degreeLevel("PhD") === "doctorate");
check(`"High School Diploma" is highschool`, degreeLevel("High School Diploma") === "highschool");
check(`a field of study has no level`, degreeLevel("Information Systems") === undefined, degreeLevel("Information Systems"));

console.log("\nGPA bands");
check(`"3.0-3.5" excludes 3.53`, !bandContains(parseGpaBand("3.0-3.5")!, 3.53));
check(`"3.5 or higher" includes 3.53`, bandContains(parseGpaBand("3.5 or higher")!, 3.53));
check(`"3.5+" includes 3.53`, bandContains(parseGpaBand("3.5+")!, 3.53));
check(`"3.5 - 4.0" includes 3.53`, bandContains(parseGpaBand("3.5 - 4.0")!, 3.53));
check(`"Below 3.0" excludes 3.53`, !bandContains(parseGpaBand("Below 3.0")!, 3.53));
check(`"3.53" includes itself`, bandContains(parseGpaBand("3.53")!, 3.53));
check(`"3.53/4.0" includes itself`, bandContains(parseGpaBand("3.53/4.0")!, 3.53));

console.log("\nmust CATCH — all of these were really submitted");
check(`the wrong degree level`, codes([["Degree*", "Associate's Degree"]]).includes("degree-wrong"), codes([["Degree*", "Associate's Degree"]]));
check(`a field of study given as the degree`, codes([["Degree", "Information Systems"]]).includes("degree-not-a-degree"));
check(`a SKILL given as the degree`, codes([["Degree", "Python (Programming Language) (Suggested)"]]).includes("degree-not-a-degree"));
check(`"Yes" given as the degree program`, codes([["What is your Current Degree Program?*", "Yes"]]).includes("degree-not-a-degree"));
// Aquatic Capital: 3.5-4.0 was on offer and fits 3.53, so answering 3.0-3.5 was wrong. This is
// the bug that was reported.
check(`a band that excludes the GPA when a fitting one was offered`,
  codes([["What is your cumulative GPA?*", "3.0-3.5", ["3.5-4.0", "3.0-3.5", "Below 3.0"]]]).includes("gpa-wrong"),
  codes([["What is your cumulative GPA?*", "3.0-3.5", ["3.5-4.0", "3.0-3.5", "Below 3.0"]]]));
// With no options recorded (older entries) the benefit of the doubt goes to the application: this
// check catches misstatements, it does not fail on missing metadata.
check(`the same answer with no options recorded is still flagged`,
  codes([["What is your cumulative GPA?*", "3.0-3.5"]]).includes("gpa-wrong"));
// Verkada: 3.6-4.0 / 3.1-3.5 / 3.0-or-under — a 3.53 fits NOTHING. Understating into the nearest
// band below is the honest pick, and flagging it would leave a required field unanswerable.
check(`understating is excused when the form offered nothing that fits`,
  codes([["What is your GPA?*", "3.1 - 3.5", ["3.6 - 4.0", "3.1 - 3.5", "3.0 or under"]]]).length === 0,
  codes([["What is your GPA?*", "3.1 - 3.5", ["3.6 - 4.0", "3.1 - 3.5", "3.0 or under"]]]));
// …but OVERSTATING is never excused, whatever the form offered.
check(`overstating is never excused`,
  codes([["What is your GPA?*", "3.6 - 4.0", ["3.6 - 4.0", "3.1 - 3.5", "3.0 or under"]]]).includes("gpa-wrong"),
  codes([["What is your GPA?*", "3.6 - 4.0", ["3.6 - 4.0", "3.1 - 3.5", "3.0 or under"]]]));
check(`a master's when the resume says bachelor's`, codes([["Highest level of education", "Master of Science"]]).includes("degree-wrong"));

console.log("\nmust stay QUIET — real questions from the 50 queued applications");
// Every case below was a FALSE POSITIVE this check produced when first run over the live queue.
// It reported 15 problems of which 8 were wrong, which is the failure mode that makes a guardrail
// worthless: it blocks applications that were ready to send.
check(`a yes/no question about holding a degree`,
  codes([["Do you have, or are you currently pursuing, a college degree?", "Yes"]]).length === 0,
  codes([["Do you have, or are you currently pursuing, a college degree?", "Yes"]]));
check(`a checkbox-group option answered Yes`,
  codes([["Degree Type — Undergraduate/Bachelors", "Yes"]]).length === 0,
  codes([["Degree Type — Undergraduate/Bachelors", "Yes"]]));
check(`a group option answered No`, codes([["Degree Type — PhD", "No"]]).length === 0);
check(`a graduation YEAR question`,
  codes([["Please include your intended graduation year for the degree", "2028"]]).length === 0,
  codes([["Please include your intended graduation year for the degree", "2028"]]));
check(`US class standing is a real education level`,
  codes([["What is your current education level?*", "Junior"]]).length === 0,
  codes([["What is your current education level?*", "Junior"]]));
check(`a GPA question whose label mentions "degree" is not a degree question`,
  codes([["For your most recent degree, what is/was your GPA (normalized to 4.0)", "3.53"]]).length === 0,
  codes([["For your most recent degree, what is/was your GPA (normalized to 4.0)", "3.53"]]));
// …but the SAME label with a wrong band must still be caught as a GPA problem.
check(`that same label with a band excluding 3.53 IS still caught`,
  codes([["For your most recent degree, what is/was your GPA (normalized to 4.0)", "3.0 -3.5", ["3.5-4.0", "3.0 -3.5"]]]).includes("gpa-wrong"),
  codes([["For your most recent degree, what is/was your GPA (normalized to 4.0)", "3.0 -3.5", ["3.5-4.0", "3.0 -3.5"]]]));

console.log("\nmust stay QUIET — correct answers");
check(`"Bachelor of Science"`, codes([["Degree (Optional)", "Bachelor of Science"]]).length === 0, codes([["Degree (Optional)", "Bachelor of Science"]]));
check(`"Bachelors"`, codes([["Degree*", "Bachelors"]]).length === 0);
check(`"B.S. in Information Systems at Carnegie Mellon"`, codes([["* Tell us more about your degree?", "B.S. in Information Systems at Carnegie Mellon"]]).length === 0);
// The subject questions are where "Information Systems" is the RIGHT answer. Flagging them would
// block every correctly-filled application.
check(`"Information Systems" as the field of study`, codes([["Field of study (Optional)", "Information Systems"]]).length === 0, codes([["Field of study (Optional)", "Information Systems"]]));
check(`"Information Systems" as the major`, codes([["Major", "Information Systems"]]).length === 0);
check(`"Computer and Information Science" as the discipline`, codes([["Discipline*", "Computer and Information Science"]]).length === 0);
check(`the exact GPA`, codes([["Overall Result (GPA)*", "3.53"]]).length === 0);
check(`"3.5 or higher"`, codes([["What is your cumulative GPA?", "3.5 or higher"]]).length === 0);
// A GPA field holding something unparseable is not evidence of a WRONG value; the blank/format
// checks belong elsewhere. Guessing here would fire on free-text explanations.
check(`an unparseable GPA answer is not called wrong`, codes([["GPA", "See transcript"]]).length === 0, codes([["GPA", "See transcript"]]));

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
