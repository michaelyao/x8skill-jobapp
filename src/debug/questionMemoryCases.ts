import {
  fingerprintOf,
  mechanismsRuledOut,
  recallAnswer,
  recallMechanism,
  studyBudgetFor,
  type QuestionMemory,
} from "../knowledge/questionMemory.js";

/**
 * Cases for what we remember about a question.  npm run test:memory
 *
 * The whole point of this store is one asymmetry: an ANSWER travels between employers and widgets,
 * a MECHANISM does not. Most of these cases exist to hold that line, because getting it wrong fails
 * in two opposite and equally bad ways — losing an answer the candidate gave us, or applying a
 * Workday click recipe to a Greenhouse radio.
 *
 * And, per PROPOSAL.md §1.3: these test the DECISIONS, not the helpers. The bug that cost three
 * weeks was a gate at a call site while 92 cases passed against the function behind it.
 */
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`);
  }
};

const mem = (over: Partial<QuestionMemory>): QuestionMemory => ({
  fingerprint: fingerprintOf(over.sampleLabel ?? ""),
  sampleLabel: "",
  ats: "workday",
  shape: "workday-prompt",
  source: "learned",
  worked: true,
  at: "2026-09-07T00:00:00.000Z",
  hits: 1,
  ...over,
});

console.log("the fingerprint ignores the noise each form adds");
// Verbatim from two real tenants: Workday numbers its custom questions, and the starred required
// marker comes and goes. Both must reach the same memory.
check(
  `a list number and a required star do not change the question`,
  fingerprintOf("5. How Did You Hear About Us?*") === fingerprintOf("How did you hear about us"),
  [fingerprintOf("5. How Did You Hear About Us?*"), fingerprintOf("How did you hear about us")],
);
check(
  `a parenthetical does not change it`,
  fingerprintOf("Current location (City) ✱") === fingerprintOf("Current location ✱"),
);
check(`two different questions do NOT collide`,
  fingerprintOf("How did you hear about us") !== fingerprintOf("Are you legally authorized to work"));

console.log("\nan ANSWER travels — across employer and across widget");
{
  const memories = [
    mem({
      sampleLabel: "Have you ever worked for Mastercard as an employee or provided services as a contingent worker?",
      answer: "No",
      source: "candidate",
      ats: "workday",
      shape: "radio",
    }),
  ];
  // The same question at another employer, on a different widget. His instruction was explicit:
  // "once i answered, they need remember this type of question … and use it again if they see the
  // similar question."
  const hit = recallAnswer(memories, "Have you ever worked for Mastercard as an employee or provided services as a contingent worker?*");
  check(`the answer is found again despite the required star`, hit?.answer === "No", hit?.answer);
  check(`and it is found from a DIFFERENT ats and shape`, recallAnswer(memories, "have you ever worked for mastercard as an employee or provided services as a contingent worker")?.answer === "No");
}
{
  // What he told us beats what we worked out, whichever came first.
  const memories = [
    mem({ sampleLabel: "Do you have a valid driver's license?", answer: "Yes", source: "learned", at: "2026-09-07T10:00:00.000Z" }),
    mem({ sampleLabel: "Do you have a valid driver's license?", answer: "No", source: "candidate", at: "2026-09-06T10:00:00.000Z" }),
  ];
  check(`his answer outranks ours even when ours is newer`,
    recallAnswer(memories, "Do you have a valid driver's license?")?.answer === "No",
    recallAnswer(memories, "Do you have a valid driver's license?")?.answer);
}
{
  // Two corrections from him: the later one is the one he meant.
  const memories = [
    mem({ sampleLabel: "What is your current major?", answer: "Information Systems", source: "candidate", at: "2026-09-01T00:00:00.000Z" }),
    mem({ sampleLabel: "What is your current major?", answer: "Information Systems Technology", source: "candidate", at: "2026-09-05T00:00:00.000Z" }),
  ];
  check(`the most recent of his own answers wins`,
    recallAnswer(memories, "What is your current major?")?.answer === "Information Systems Technology");
}

console.log("\na MECHANISM does not travel — it is a fact about one tenant's markup");
{
  const memories = [
    mem({
      sampleLabel: "How Did You Hear About Us?*",
      ats: "workday",
      shape: "workday-prompt",
      mechanism: { path: ["Job Board", "Handshake"] },
    }),
  ];
  check(`found for the same question, ats and shape`,
    recallMechanism(memories, "5. How did you hear about us", "workday", "workday-prompt")?.mechanism?.path?.join(">") === "Job Board>Handshake");
  // CLAUDE.md: never across ATSes. How a control behaves is a property of that tenant's widget.
  check(`NOT offered to another ATS`,
    recallMechanism(memories, "How Did You Hear About Us?*", "greenhouse", "workday-prompt") === undefined);
  check(`NOT offered to another widget shape on the same ATS`,
    recallMechanism(memories, "How Did You Hear About Us?*", "workday", "select") === undefined);
  // But the ANSWER behind it still travels, which is the whole asymmetry.
  check(`while an answer recorded for it would still travel`,
    recallAnswer([...memories, mem({ sampleLabel: "How Did You Hear About Us?*", answer: "Handshake", ats: "workday", shape: "workday-prompt" })], "How did you hear about us?")?.answer === "Handshake");
}
{
  // A remedy that did not work must never be tried again — the existing field-notes rule, kept.
  const memories = [
    mem({ sampleLabel: "I agree with the terms", ats: "oracle", shape: "checkbox", mechanism: { recipe: "force-click" }, worked: false }),
    mem({ sampleLabel: "I agree with the terms", ats: "oracle", shape: "checkbox", mechanism: { recipe: "click-label" }, worked: true }),
  ];
  check(`the recipe that worked is returned`,
    recallMechanism(memories, "I agree with the terms", "oracle", "checkbox")?.mechanism?.recipe === "click-label");
  check(`the one that failed is reported as ruled out`,
    mechanismsRuledOut(memories, "I agree with the terms", "oracle", "checkbox").join() === "force-click");
  check(`a failed mechanism is never returned as usable`,
    recallMechanism([memories[0]!], "I agree with the terms", "oracle", "checkbox") === undefined);
}

console.log("\nthe study budget follows how many applications the field is blocking");
// "especially common field" — his words. Hear-about-us blocks 29; a one-off blocks 1.
check(`29 blocked earns vision and six experiments`, studyBudgetFor(29).vision && studyBudgetFor(29).experiments === 6);
check(`three blocked still earns vision`, studyBudgetFor(3).vision);
check(`one blocked does NOT spend a vision call`, studyBudgetFor(1).vision === false, studyBudgetFor(1));
check(`and gets the shortest clock`, studyBudgetFor(1).ms < studyBudgetFor(29).ms);

console.log("\nempty and unknown inputs");
check(`a blank label recalls nothing rather than matching everything`,
  recallAnswer([mem({ sampleLabel: "", answer: "No" })], "") === undefined);
check(`an unknown question recalls nothing`,
  recallAnswer([mem({ sampleLabel: "How did you hear about us", answer: "Handshake" })], "What is your GPA?") === undefined);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
