import { isExclusiveGroup } from "../core/fieldGroups.js";

/** Cases for "is this one question or several boxes?".  npm run test:groups */
let pass = 0, fail = 0;
const check = (n: string, c: boolean, got?: unknown) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${got===undefined?"":` — got ${JSON.stringify(got)}`}`); }
};

console.log("one question with alternatives — tick ONE");
// Michelin's Self Identify, verbatim from the log.
check(`the disability triple is exclusive`, isExclusiveGroup([
  "Yes, I have a disability, or have had one in the past",
  "No, I do not have a disability and have not had one in the past",
  "I do not want to answer",
]));
check(`a bare yes/no pair is exclusive`, isExclusiveGroup(["Yes", "No"]));
check(`a decline option makes it exclusive`, isExclusiveGroup(["I am a protected veteran", "I prefer not to say"]));
check(`"decline to self-identify" counts`, isExclusiveGroup(["Hispanic or Latino", "Decline to self-identify"]));

console.log("\nseveral independent boxes — tick as many as apply");
check(`areas of interest stays multi-select`, !isExclusiveGroup([
  "Software Engineering", "Research and Development", "Data Science", "Hardware Engineering",
]), "areas of interest");
check(`the race/ethnicity list stays multi-select`, !isExclusiveGroup([
  "Asian or Asian American", "Black or African American", "Hispanic or Latine", "Indigenous",
]));
check(`sexual-orientation "select all that apply" stays multi-select`, !isExclusiveGroup([
  "Bisexual", "Lesbian", "Gay", "Queer",
]));
check(`a single option is not a group`, !isExclusiveGroup(["I currently work here"]));
check(`an empty group is not a group`, !isExclusiveGroup([]));

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
