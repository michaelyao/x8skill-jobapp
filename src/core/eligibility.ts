import { degreeLevel } from "./factChecks.js";

/**
 * Does the POSTING ITSELF rule the candidate out?
 *
 * Pony.ai's internship says "Currently pursuing a Masters or PhD program in Computer Science,
 * Machine Learning, Robotics, or similar field". Nathan is an undergraduate. Nothing in this system
 * read that line: the filters cover title, location and age, and the checks cover whether the FORM
 * was filled correctly — none asks whether he is eligible at all. So a complete, correct, verified
 * application was queued for a role that excludes him, and the candidate found it by reading the
 * description himself.
 *
 * CONSERVATIVE BY CONSTRUCTION. Most postings list degrees inclusively — "BS/MS/PhD in Computer
 * Science", "Bachelor's or Master's", "PhD a plus" — and flagging those would bury the real ones,
 * which is how a guard stops being read. A finding needs a requirement phrase (pursuing, enrolled,
 * must have, required) AND a graduate degree AND no undergraduate option in the same breath.
 *
 * Pure: npm run test:eligibility.
 */
export interface EligibilityProblem {
  /** The posting's own words, so the reviewer judges the line rather than my paraphrase. */
  quote: string;
  message: string;
}

const GRADUATE = /\b(master'?s?|masters|ms|m\.s\.?|phd|ph\.?d\.?|doctoral|doctorate|graduate degree|graduate program|graduate student)\b/i;
const UNDERGRAD = /\b(bachelor'?s?|bachelors|bs|b\.s\.?|ba|b\.a\.?|undergraduate|undergrad|4th year|junior|sophomore)\b/i;
/** Words that make a degree a REQUIREMENT rather than a nice-to-have or a pay band. */
const REQUIRED = /\b(currently pursuing|pursuing|enrolled|must be|must have|required|require|requirement|candidates? must|you are a|you must)\b/i;
/** Words that make it optional — never a bar. */
const OPTIONAL = /\b(preferred|a plus|nice to have|bonus|ideally|desirable|or equivalent)\b/i;

export function checkEligibility(
  description: string,
  facts: { degree?: string },
): EligibilityProblem[] {
  const text = (description ?? "").trim();
  if (!text) return [];
  // Only relevant while the candidate has no graduate degree. If the resume ever says otherwise,
  // this stops firing on its own.
  const level = facts.degree ? degreeLevel(facts.degree) : undefined;
  if (level && level !== "bachelor" && level !== "associate" && level !== "highschool") return [];

  /**
   * A posting that WELCOMES undergraduates anywhere in its text is inclusive, whatever a single
   * line says. Xsolla's reads "Open to current undergraduate students, graduate students, and
   * recent graduates" and then, further down, "If you're pursuing a graduate degree and don't mind
   * taking on an internship-level role, we want to hear from you" — the second line alone looks like
   * a bar and the posting plainly is not one.
   */
  if (/open to[^.]{0,80}undergraduate|undergraduate[^.]{0,60}(welcome|eligible|encouraged)|(undergraduate|bachelor'?s?)[^.]{0,40}\b(or|and|,)\b[^.]{0,40}(graduate|master)/i.test(text)) {
    return [];
  }

  const out: EligibilityProblem[] = [];
  for (const raw of text.split(/\r?\n|(?<=[.;])\s+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 20 || line.length > 300) continue;
    if (!GRADUATE.test(line)) continue;
    // A line that also offers an undergraduate route is inclusive, not a bar.
    if (UNDERGRAD.test(line)) continue;
    if (OPTIONAL.test(line)) continue;
    if (!REQUIRED.test(line)) continue;
    /**
     * A CONDITIONAL is not a requirement. Zip's description says "If you're enrolled or plan on
     * enrolling in a Master's program, use that program's expected graduation month/year" — form
     * instructions, and it matched "enrolled" straight through the requirement test.
     */
    if (/^\W*(if|should|whether)\b|\bif you\b|\bif you'?re\b/i.test(line)) continue;
    // A pay band mentioning degrees is not a requirement ("Master: $7000/month").
    if (/\$\s?\d|\bper month\b|\bsalary\b|\bstipend\b/i.test(line)) continue;
    out.push({
      quote: line.slice(0, 200),
      message: `the posting requires a graduate degree — "${line.slice(0, 130)}" — and the resume says ${facts.degree ?? "an undergraduate degree"}`,
    });
    break; // one is enough; the reviewer needs the fact, not every phrasing of it
  }
  return out;
}
