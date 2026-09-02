import { checkEligibility } from "../core/eligibility.js";

/**
 * Does the posting rule the candidate out?  npm run test:eligibility
 *
 * Pony.ai's internship says "Currently pursuing a Masters or PhD program in Computer Science,
 * Machine Learning, Robotics, or similar field". Nathan is an undergraduate. Nothing read that line
 * — the filters cover title, location and age, and every check asks whether the FORM was filled
 * correctly — so a complete, correct, verified application was queued for a role that excludes him.
 *
 * The hard part is NOT flagging the inclusive phrasings, which are the majority.
 */
const BS = { degree: "Bachelor of Science" };
const MS = { degree: "Master of Science" };

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const flagged = (text: string, facts = BS) => checkEligibility(text, facts).length > 0;

console.log("a posting that excludes an undergraduate");
// The real line, verbatim.
check(`"Currently pursuing a Masters or PhD program in Computer Science, Machine Learning, Robotics, or similar field"`,
  flagged("Currently pursuing a Masters or PhD program in Computer Science, Machine Learning, Robotics, or similar field"));
check(`"Must be enrolled in a PhD program in a related field"`, flagged("Must be enrolled in a PhD program in a related field"));
check(`"Candidates must have a Master's degree in a quantitative discipline"`, flagged("Candidates must have a Master's degree in a quantitative discipline"));
check(`it quotes the posting's own words`,
  checkEligibility("Currently pursuing a Masters or PhD program in Computer Science", BS)[0]?.quote.includes("Masters or PhD"));

console.log("\nthe inclusive phrasings it must leave alone");
check(`"BS/MS/PhD in Computer Science or related field"`, !flagged("Requirement: BS/MS/PhD in Computer Science or related field"));
check(`"Pursuing a Bachelor's or Master's degree"`, !flagged("Pursuing a Bachelor's or Master's degree in engineering"));
check(`"Master's degree preferred"`, !flagged("Master's degree preferred but not required for this role"));
check(`"PhD a plus"`, !flagged("Experience with distributed systems; PhD a plus for research-track candidates"));
check(`"Bachelor's degree required"`, !flagged("Bachelor's degree required in Computer Science or equivalent experience"));
// A pay band naming degrees is not a requirement.
check(`"Master: $7000/month"`, !flagged("Master: $7000/month"));
check(`"PhD: $10,000/month"`, !flagged("PhD: $10,000/month"));
// Prose mentioning graduate school in passing.
check(`"our team includes PhDs from top programs"`, !flagged("Our team includes PhDs from top programs and we publish regularly"));

// Both of these were flagged on the real queue and both are wrong — caught before shipping, because
// two false findings out of four is how a guard stops being read.
check(`a posting that welcomes undergraduates elsewhere is inclusive`,
  !flagged("Open to current undergraduate students, graduate students, and recent graduates of a Computer Science program. If you're pursuing a graduate degree and don't mind taking on an internship-level role, we want to hear from you."));
check(`form instructions are not a requirement`,
  !flagged("If you're enrolled or plan on enrolling in a Master's program, use that program's expected graduation month/year (not an undergraduate date)."));
check(`a real graduate-only line split across lines is still caught`,
  flagged("Currently pursuing a Ph.D.\nor Master's degree in AI, Computer Science, Electrical Engineering, Robotics, or a related field."));

console.log("\nand it stops mattering if the candidate has the degree");
check(`a Master's holder is not excluded by a Master's requirement`,
  !flagged("Currently pursuing a Masters or PhD program in Computer Science", MS));

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
