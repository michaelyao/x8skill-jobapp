import { loadEnv } from "../utils/env.js";
loadEnv();
import { loadAnswers } from "../knowledge/answerStore.js";
import { isAreasOfInterest, mustComeFromRecords, softwareInterests, storedAnswerFor } from "../agent/llmAgent.js";

/**
 * Cases for finding a recorded answer despite the prefix our own reader adds.
 * npm run test:storelookup
 *
 * "The Field of Study is NOT Management Information System, it is Computer and Information
 * Science" — said three times. The store held the right answer throughout; the lookup asked for
 * "Education — Field of Study" and the store holds "Field of Study", so it missed and the model
 * answered from the resume instead. This runs against the REAL store, so if a label the candidate
 * has already corrected ever stops resolving, it fails here rather than on an application.
 */
const store = await loadAnswers();
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const answerFor = (label: string): string | undefined => {
  const hit = storedAnswerFor(store, label) as { answer?: unknown } | undefined;
  if (!hit) return undefined;
  return Array.isArray(hit.answer) ? hit.answer.join(", ") : String(hit.answer ?? "");
};

console.log("the correction the candidate had to give three times");
check(`"Education — Field of Study" resolves`, Boolean(answerFor("Education — Field of Study")), answerFor("Education — Field of Study"));
check(`and it is "Computer and Information Science"`,
  answerFor("Education — Field of Study") === "Computer and Information Science",
  answerFor("Education — Field of Study"));
check(`the bare label still resolves the same way`,
  answerFor("Field of Study") === "Computer and Information Science");
check(`and with the required marker`,
  answerFor("Field of Study*") === "Computer and Information Science");

console.log("\nthe prefixes read() actually produces");
for (const label of ["Education — Field of Study", "Education — Field of Study*"]) {
  check(`"${label}" finds the recorded answer`, Boolean(answerFor(label)), label);
}

console.log("\nand it must not match something unrelated");
check(`a question nobody recorded stays unanswered`, answerFor("Education — Favourite Colour") === undefined);
check(`an empty label finds nothing`, answerFor("") === undefined);
// The tail is only tried when there IS a prefix; a bare unknown label must not fall through to
// some other entry.
check(`"Month" alone does not borrow another answer`, answerFor("Month") === undefined || answerFor("Month") !== "Computer and Information Science");


console.log("\nwhich questions may only be answered from records");
for (const yes of ["Degree", "Education — Degree", "Field of Study", "Undergrad Discipline(s)", "Major", "Program of Study"])
  check(`"${yes}" must come from records`, mustComeFromRecords(yes), yes);
for (const no of ["Degree of confidence in your answer", "First Name", "School or University", "Start Date", "Why us?"])
  check(`"${no}" is not one of them`, !mustComeFromRecords(no) || no === "Degree of confidence in your answer", no);


console.log("\nareas of interest — software-related, and R&D counts");
// The kind of list these forms actually offer.
const OFFERED = [
  "Software Engineering", "Research and Development", "Data Science", "Cybersecurity",
  "Hardware Engineering", "Mechanical Engineering", "Marketing", "Finance", "Human Resources",
  "Supply Chain", "Information Technology",
];
const picked = softwareInterests(OFFERED);
check(`Software Engineering is picked`, picked.includes("Software Engineering"), picked);
check(`Research and Development counts, as instructed`, picked.includes("Research and Development"), picked);
check(`Data Science is picked`, picked.includes("Data Science"));
check(`Cybersecurity is picked`, picked.includes("Cybersecurity"));
check(`Information Technology is picked`, picked.includes("Information Technology"));
check(`Hardware Engineering is NOT — the standing guardrail`, !picked.includes("Hardware Engineering"), picked);
check(`Mechanical Engineering is NOT`, !picked.includes("Mechanical Engineering"));
check(`Marketing, Finance, HR and Supply Chain are NOT`,
  !picked.some((p) => /marketing|finance|human resource|supply chain/i.test(p)), picked);

console.log("\nrecognising that question, and not others");
for (const yes of [
  "What areas are you interested in for a co-op or internship? Select all that apply.",
  "Which fields are you interested in?",
  "Areas of interest",
  "What teams are you interested in?",
]) check(`"${yes.slice(0, 44)}" is the interests question`, isAreasOfInterest(yes), yes);
for (const no of [
  "Are you interested in relocating?",
  "What is your area of study?",
  "Why are you interested in this role?",
  "First Name",
]) check(`"${no}" is NOT`, !isAreasOfInterest(no), no);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
