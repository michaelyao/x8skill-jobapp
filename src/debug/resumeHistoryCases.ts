import { parseResumeHistory, toMonthYear } from "../knowledge/resumeHistory.js";

/**
 * Cases for the structured resume parser.  npm run test:history
 *
 * BOTH resume formats are tested, because that is where the first version failed: it understood
 * only the .txt, loadProfile prefers the .md, and against the .md it returned 0 education and 0
 * experience — a "successful" parse that left every history section on the form empty.
 */
const TXT = `Nathan Yao

======================================================================
EDUCATION
======================================================================

Carnegie Mellon University -- Pittsburgh, PA
Major: B.S. in Information Systems | GPA: 3.53 | Expected May 2028

======================================================================
WORK EXPERIENCE
======================================================================

Amazon -- Seattle, WA
Software Engineering Intern, Shield Infrastructure | Aug 2026 - Present

- Built a detection algorithm into AWS Shield's pipeline.

CompassPoint Mentorship -- Alviso, CA
Software Engineering Intern and Teaching Assistant | 2023 - 2024

- Engineered the Alviso Environmental Monitoring Dashboard.
- Integrated SparkFun sensors with Raspberry Pi devices.

======================================================================
AWARD
======================================================================

- USACO Gold -- 2023
`;

const MD = `# Nathan Yao

## Education

**Carnegie Mellon University** — Pittsburgh, PA
Major: B.S. in Information Systems | GPA: 3.53 | Expected May 2028

## Work Experience

### Amazon — Seattle, WA
**Software Engineering Intern, Shield Infrastructure** | Aug 2026 – Present

- Built a detection algorithm into AWS Shield's pipeline.

### CompassPoint Mentorship — Alviso, CA
**Software Engineering Intern and Teaching Assistant** | 2023 – 2024

- Engineered the Alviso Environmental Monitoring Dashboard.
- Integrated SparkFun sensors with Raspberry Pi devices.

## Award

- USACO Gold — 2023
`;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

for (const [label, text] of [["txt", TXT], ["md", MD]] as const) {
  console.log(`\n${label} format`);
  const h = parseResumeHistory(text);

  check(`${label}: one education entry`, h.education.length === 1, h.education.length);
  const e = h.education[0];
  check(`${label}: school`, e?.school === "Carnegie Mellon University", e?.school);
  check(`${label}: "B.S." becomes a readable degree`, e?.degree === "Bachelor of Science", e?.degree);
  check(`${label}: field of study split off the degree`, e?.fieldOfStudy === "Information Systems", e?.fieldOfStudy);
  check(`${label}: gpa`, e?.gpa === "3.53", e?.gpa);
  check(`${label}: "Expected May 2028" → end date`, e?.endDate === "05/2028", e?.endDate);
  // A start date is not on the resume. These fields want one, so it is derived — and recorded as
  // derived, so a reviewer can see it was inferred rather than read.
  check(`${label}: start date derived from a 4-year degree`, e?.startDate === "08/2024", e?.startDate);
  check(`${label}: the derivation is disclosed`, (e?.derived ?? []).length === 1, e?.derived);

  check(`${label}: two experience entries`, h.experience.length === 2, h.experience.length);
  const [amazon, compass] = h.experience;
  check(`${label}: employer`, amazon?.company === "Amazon", amazon?.company);
  check(`${label}: title`, amazon?.title === "Software Engineering Intern, Shield Infrastructure", amazon?.title);
  check(`${label}: "Present" means current, with no end date`, amazon?.current === true && !amazon?.endDate, [amazon?.current, amazon?.endDate]);
  check(`${label}: start date`, amazon?.startDate === "08/2026", amazon?.startDate);
  // The per-role Summary wants THIS role's bullets, not a general blurb about the candidate.
  check(`${label}: summary is the role's own bullet`, /AWS Shield/.test(amazon?.summary ?? ""), amazon?.summary);
  check(`${label}: multiple bullets are joined`, (compass?.summary.match(/Alviso|SparkFun/g) ?? []).length === 2, compass?.summary);
  // A bare year has no month. January for a start, December for an end — a convention, not
  // invented precision.
  check(`${label}: year-only range`, compass?.startDate === "01/2023" && compass?.endDate === "12/2024", [compass?.startDate, compass?.endDate]);
  // The AWARD section must not be swallowed into work experience.
  check(`${label}: the following section is not absorbed`, !h.experience.some((x) => /USACO/.test(x.company)), h.experience.map((x) => x.company));
}

console.log(`\nmonth parsing`);
check(`"Aug 2026" → 08/2026`, toMonthYear("Aug 2026") === "08/2026", toMonthYear("Aug 2026"));
check(`"Sept 2025" → 09/2025`, toMonthYear("Sept 2025") === "09/2025", toMonthYear("Sept 2025"));
check(`"2023" as a start → 01/2023`, toMonthYear("2023", false) === "01/2023", toMonthYear("2023", false));
check(`"2023" as an end → 12/2023`, toMonthYear("2023", true) === "12/2023", toMonthYear("2023", true));
check(`nonsense → undefined`, toMonthYear("Present") === undefined, toMonthYear("Present"));

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
