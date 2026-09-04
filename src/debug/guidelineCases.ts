/** `npm run test:guidelines` — the candidate's own preference file, and what it must never do. */
import { guidelineFor, guidelineInstruction, optionsUnderGuideline, parseGuidelines } from "../core/../knowledge/guidelines.js";
import fs from "node:fs";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

const SAMPLE = `
# a comment
[what I want to work on]
MATCH:  something specific|areas? of interest
PREFER: software development, AI agents, machine learning
AVOID:  QA, hardware, iOS, robotic control
NOTE:   He is applying for software internships.
`;

console.log("parsing");
const gs = parseGuidelines(SAMPLE);
check(`one guideline parsed`, gs.length === 1, gs.length);
check(`name kept`, gs[0]?.name === "what I want to work on");
check(`PREFER split on commas`, gs[0]?.prefer.length === 3, gs[0]?.prefer);
check(`AVOID split on commas`, gs[0]?.avoid.length === 4, gs[0]?.avoid);
check(`NOTE kept`, (gs[0]?.note ?? "").startsWith("He is applying"));
check(`comments ignored`, !JSON.stringify(gs).includes("a comment"));
check(`an unreadable MATCH drops that block instead of throwing`,
  parseGuidelines("[bad]\nMATCH: (unclosed\nPREFER: x").length === 0);

console.log("\nmatching the question");
check(`the candidate's own wording matches`,
  Boolean(guidelineFor(gs, "Are you applying to work on something specific at Acme?")));
check(`"areas of interest" matches`, Boolean(guidelineFor(gs, "What areas of interest do you have?")));
check(`an unrelated question does not`, guidelineFor(gs, "What is your GPA?") === undefined);

console.log("\nchoosing from an option list");
const OPTS = [
  "Software Development",
  "AI Agents / Agentic Systems",
  "Machine Learning",
  "QA / Test Engineering",
  "Hardware Engineering",
  "iOS Development",
  "Robotic Control",
  "Finance",
];
const picked = optionsUnderGuideline(gs[0], OPTS);
check(`picks the three it prefers`, picked.length === 3, picked);
check(`never picks QA`, !picked.some((o) => /QA/i.test(o)));
check(`never picks hardware`, !picked.some((o) => /hardware/i.test(o)));
check(`never picks iOS`, !picked.some((o) => /iOS/i.test(o)));
check(`never picks robotic control`, !picked.some((o) => /robotic/i.test(o)));
check(`AVOID beats PREFER on a mixed option`,
  optionsUnderGuideline(gs[0], ["Mobile (iOS/Android) software development"]).length === 0);
check(`a list with nothing preferred yields NOTHING rather than the least-bad row`,
  optionsUnderGuideline(gs[0], ["Finance", "Marketing", "Supply Chain"]).length === 0);

console.log("\nthe instruction handed to the model for free text");
const inst = guidelineInstruction(gs[0]);
check(`it carries the preferences`, /prefer: software development/i.test(inst));
check(`it carries the avoids`, /never mention or ask for: QA/i.test(inst));
check(`it carries the note`, /software internships/i.test(inst));

console.log("\nthe file that ships");
const shipped = parseGuidelines(fs.readFileSync("guidelines.txt", "utf8"));
check(`guidelines.txt parses`, shipped.length >= 1, shipped.length);
check(`it covers the question he asked about`,
  Boolean(guidelineFor(shipped, "Are you applying to work on something specific at Exa?")));
check(`and it would refuse an iOS option there`,
  optionsUnderGuideline(shipped[0], ["iOS Development", "AI Agents"]).join() === "AI Agents",
  optionsUnderGuideline(shipped[0], ["iOS Development", "AI Agents"]));

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
