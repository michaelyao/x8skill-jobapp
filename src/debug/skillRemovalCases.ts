/**
 * Cases for the skill-removal rule.
 *
 * Uploading the resume makes the ATS populate Skills from its own parse of the PDF. Six of
 * the entries it produced on a live Workday application are wrong and have to come OFF the
 * form. The danger is not failing to remove one — that is visible in the review — it is
 * removing something that should have stayed, which is silent.
 *
 * Run: npx tsx src/debug/skillRemovalCases.ts
 */
import { isSkillContainer, matchingRemoval, pillsToRemove, type SkillPill } from "../knowledge/skillPlan.js";

const REMOVALS = [
  "Quality Assurance (QA)",
  "Social Media",
  "Teaching",
  "Verification",
  "Microsoft Office",
  "Natural Language",
];

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}\n      expected ${e}\n      actual   ${a}`);
  }
};

console.log("\nRemoved — the six the autofill got wrong");
for (const label of REMOVALS) {
  check(label, matchingRemoval(label, REMOVALS), label);
}

console.log("\nKept — everything else the autofill produced for this resume");
for (const label of [
  "Artificial Intelligence (AI)",
  "C++ Programming Language",
  "Geographic Information Systems (GIS)",
  "Hyper Text Markup Language (HTML)",
  "Image Processing",
  "JavaScript",
  "Language Processing",
  "Python (Programming Language)",
  "Structured Query Language (SQL)",
]) {
  check(label, matchingRemoval(label, REMOVALS), undefined);
}

console.log("\nKept — near misses a substring rule would have deleted");
// These are the reason the match is exact. "Language Processing" and "Natural Language
// Processing" are real skills on this resume; "Natural Language" alone is the ATS's guess.
for (const label of [
  "Language Processing",
  "Natural Language Processing (NLP)",
  "Natural Language Understanding",
  "Formal Verification",
  "Model Verification and Validation",
  "Software Quality Assurance",
  "Teaching Assistant",
  "Social Media Analytics",
  "Microsoft Office 365 Administration",
]) {
  check(label, matchingRemoval(label, REMOVALS), undefined);
}

console.log("\nMatched despite cosmetic differences");
check("trailing space", matchingRemoval("Microsoft Office ", REMOVALS), "Microsoft Office");
check("case", matchingRemoval("SOCIAL MEDIA", REMOVALS), "Social Media");
check("collapsed whitespace", matchingRemoval("Quality  Assurance   (QA)", REMOVALS), "Quality Assurance (QA)");
check("newline from innerText", matchingRemoval("Teaching\n", REMOVALS), "Teaching");
// A pill's text can include its own delete control's label.
check("pill carries 'Delete'", matchingRemoval("Verification Delete", REMOVALS), "Verification");
check("pill carries '×'", matchingRemoval("Social Media ×", REMOVALS), "Social Media");
// ...but only as a trailing verb. A skill that merely contains the word stays.
check("'delete' mid-label stays", matchingRemoval("Delete Verification Records", REMOVALS), undefined);

console.log("\nContainer scoping — a pill is only removable from a skills box");
check("formField-skills", isSkillContainer("formField-skills", ""), true);
check("label 'Skills'", isSkillContainer("formField-abc123", "Skills"), true);
check("label 'Type to Add Skills'", isSkillContainer("formField-abc123", "Type to Add Skills*"), true);
check("label 'Skill'", isSkillContainer("formField-abc123", "Skill"), true);
check("field of study", isSkillContainer("formField-fieldOfStudy", "Field of Study"), false);
check("languages", isSkillContainer("formField-languages", "Languages"), false);
check("empty", isSkillContainer("", ""), false);

console.log("\nEnd to end — the same text in two different containers");
// The load-bearing case: "Teaching" is the ATS's bad guess in Skills, but in a "Field of
// Study" or "Areas of Interest" box it is the candidate's own answer. Only the first goes.
const pills: SkillPill[] = [
  { mark: "0", containerId: "formField-skills", containerLabel: "Skills", text: "Teaching" },
  { mark: "1", containerId: "formField-skills", containerLabel: "Skills", text: "Python (Programming Language)" },
  { mark: "2", containerId: "formField-skills", containerLabel: "Skills", text: "Natural Language" },
  { mark: "3", containerId: "formField-skills", containerLabel: "Skills", text: "Language Processing" },
  { mark: "4", containerId: "formField-interest", containerLabel: "Areas of Interest", text: "Teaching" },
  { mark: "5", containerId: "formField-fieldOfStudy", containerLabel: "Field of Study", text: "Social Media" },
];
check(
  "only the skills-box matches",
  pillsToRemove(pills, REMOVALS),
  [
    { mark: "0", label: "Teaching" },
    { mark: "2", label: "Natural Language" },
  ],
);
check("no removals configured → nothing removed", pillsToRemove(pills, []), []);
check("no pills → nothing removed", pillsToRemove([], REMOVALS), []);

console.log(failures === 0 ? `\n✓ all cases pass\n` : `\n✗ ${failures} case(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
