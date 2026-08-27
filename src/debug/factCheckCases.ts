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
const codes = (answers: Array<[string, string]>) =>
  checkFacts(answers.map(([label, value]) => ({ label, value })), FACTS).map((p) => p.code).sort();

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
check(`a GPA band that excludes the real GPA`, codes([["What is your cumulative GPA?*", "3.0-3.5"]]).includes("gpa-wrong"));
check(`a master's when the resume says bachelor's`, codes([["Highest level of education", "Master of Science"]]).includes("degree-wrong"));

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
