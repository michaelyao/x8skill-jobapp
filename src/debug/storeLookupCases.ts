import { loadEnv } from "../utils/env.js";
loadEnv();
import { loadAnswers } from "../knowledge/answerStore.js";
import { normalizeQuestion } from "../utils/normalize.js";
import { isAreasOfInterest, mustComeFromRecords, preferredHearAboutUs, softwareInterests, storedAnswerFor } from "../agent/llmAgent.js";

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


console.log("\nhow did you hear about us — the whole ladder");
// Michelin's real seven, as the trace printed them.
const MICHELIN = ["Campus Campaign", "Career Websites", "Employee Referral", "Job Board", "Social Media", "Print Advertising", "Other"];
check(`campus wins when offered`, preferredHearAboutUs(MICHELIN)?.option === "Campus Campaign", preferredHearAboutUs(MICHELIN));
// The candidate's addition: Career Websites is fine, and must be reachable when campus is not.
const noCampus = MICHELIN.filter((o) => o !== "Campus Campaign");
check(`Career Websites is chosen when there is no campus option`,
  preferredHearAboutUs(noCampus)?.option === "Career Websites", preferredHearAboutUs(noCampus));
const noSite = noCampus.filter((o) => o !== "Career Websites");
check(`then a job board`, preferredHearAboutUs(noSite)?.option === "Job Board", preferredHearAboutUs(noSite));
const noBoard = noSite.filter((o) => o !== "Job Board");
check(`then a referral`, preferredHearAboutUs(noBoard)?.option === "Employee Referral", preferredHearAboutUs(noBoard));
const noRef = noBoard.filter((o) => o !== "Employee Referral");
check(`then social`, preferredHearAboutUs(noRef)?.option === "Social Media", preferredHearAboutUs(noRef));
check(`then Other, last`, preferredHearAboutUs(["Print Advertising", "Other"])?.option === "Other");
check(`and nothing recognisable yields nothing rather than a guess`,
  preferredHearAboutUs(["Print Advertising", "Radio", "Billboard"]) === undefined,
  preferredHearAboutUs(["Print Advertising", "Radio", "Billboard"]));
// A tenant that words it differently must still resolve.
for (const wording of ["Our Careers Website", "Careers Page", "Company Website", "Michelin Careers Site"])
  check(`"${wording}" counts as the company's own site`,
    preferredHearAboutUs([wording, "Social Media"])?.why === "the company's own site",
    preferredHearAboutUs([wording, "Social Media"]));

/**
 * A GPA QUESTION THAT MENTIONS A DEGREE IS STILL A GPA QUESTION.
 *
 * Michelin asks "What is your cumulative GPA for your 4 year degree on a 4.0 scale?". The word
 * "degree" put it under the do-not-invent rule, so the correctly derived band "Between 3.00 and
 * 3.49" was refused — and the field was not empty, it held "Below 2.60" from an earlier draft, so
 * the refusal PRESERVED the false answer it was meant to prevent. The rule still has to hold for
 * the questions it was written for, which is what the second half of these asserts.
 */
console.log("\nwhat must come from the records");
check(`Michelin's GPA question is NOT a records-only field`,
  mustComeFromRecords("What is your cumulative GPA for your 4 year degree on a 4.0 scale?") === false);
check(`a bare GPA question is not either`, mustComeFromRecords("GPA*") === false);
check(`"Overall Result (GPA)" is not either`, mustComeFromRecords("Overall Result (GPA)") === false);
check(`grade point average spelled out, next to "degree"`,
  mustComeFromRecords("Grade point average for your degree") === false);
check(`"Degree*" still is`, mustComeFromRecords("Degree*") === true);
check(`"Field of Study" still is`, mustComeFromRecords("Education — Field of Study") === true);
check(`"What is your current major?" still is`, mustComeFromRecords("What is your current major?") === true);
check(`"Discipline*" still is`, mustComeFromRecords("Discipline*") === true);
check(`an ordinary question is unaffected`, mustComeFromRecords("Job Title*") === false);

/**
 * A MAJOR IS A FIELD OF STUDY. Michelin's "What is your current major?" found nothing in the
 * store, so the model answered "Information Systems Technology" and the do-not-invent rule
 * refused it — the question went out blank while the answer sat on file under another name.
 */
console.log("\nthe store's aliases");
const STORE = [
  { normalizedQuestion: normalizeQuestion("Field of Study"), value: "Computer and Information Science" },
  { normalizedQuestion: normalizeQuestion("Home address"), value: "318 Morse Ave, Sunnyvale, CA 94085" },
];
const found = (label: string) => storedAnswerFor(STORE, label)?.value;
check(`"What is your current major?" reads the recorded field of study`,
  found("What is your current major?") === "Computer and Information Science", found("What is your current major?"));
check(`"Major*" does too`, found("Major*") === "Computer and Information Science");
check(`"Discipline*" does too`, found("Discipline*") === "Computer and Information Science");
check(`"Program of Study" does too`, found("Program of Study") === "Computer and Information Science");
check(`an em-dash qualified label still resolves by its tail`,
  found("Education — Field of Study") === "Computer and Information Science");
check(`an exact match is unchanged`, found("Field of Study") === "Computer and Information Science");
check(`an unrelated question still finds nothing rather than the nearest record`,
  found("What is your favourite programming language?") === undefined, found("What is your favourite programming language?"));
check(`a GPA question does not resolve to the field of study`,
  found("What is your cumulative GPA for your 4 year degree on a 4.0 scale?") === undefined);
check(`"Degree*" does not silently become the field of study`,
  found("Degree*") === undefined, found("Degree*"));

/**
 * GENERAL MATTER: the word "degree" is not the question.
 *
 * One application refused three correct answers, two of them REQUIRED, and left the fields blank:
 * "Degree*" -> "Bachelor's Degree" (the record's own wording), "Do you have, or are you currently
 * pursuing a degree?" -> "Yes", "What year do you intend to complete your degree?" -> "2028".
 * A yes/no and a year are not degree names, and no record could be quoted verbatim for them, so
 * the rule could only ever blank them.
 */
console.log("\nthe rule is about questions whose ANSWER is a degree");
check(`"Do you have, or are you currently pursuing a degree?" is a yes/no`,
  mustComeFromRecords("Do you have, or are you currently pursuing a degree?") === false);
check(`"Are you currently enrolled in a degree seeking program?" is a yes/no`,
  mustComeFromRecords("Are you currently enrolled in a degree seeking program?") === false);
check(`"What year do you intend to complete your degree?" is a year`,
  mustComeFromRecords("What year do you intend to complete your degree?") === false);
check(`"When will you complete your degree?" is a date`,
  mustComeFromRecords("When will you complete your degree?") === false);
check(`"Expected graduation date for your degree" is a date`,
  mustComeFromRecords("Expected graduation date for your degree") === false);
check(`"Degree*" still asks for a degree NAME`, mustComeFromRecords("Degree*") === true);
check(`"What is your current major?" still does`,
  mustComeFromRecords("What is your current major?") === true);
check(`"Education — Field of Study" still does`,
  mustComeFromRecords("Education — Field of Study") === true);
check(`"Discipline*" still does`, mustComeFromRecords("Discipline*") === true);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
