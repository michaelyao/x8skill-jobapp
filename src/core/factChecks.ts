/**
 * Check what the application SAYS against what the resume says.
 *
 * The rest of the guardrail asks whether fields are filled. These ask whether the filled values
 * are TRUE — which is a different and worse class of failure, because a wrong answer looks
 * complete. Observed on live applications:
 *
 *   Degree                             -> "Python (Programming Language)"     a skill
 *   Degree                             -> "Information Systems"               a field of study
 *   Degree                             -> "Associate's Degree"                the wrong LEVEL
 *   What is your Current Degree Program? -> "Yes"                             not an answer
 *   cumulative GPA                     -> "3.0-3.5"                           excludes the real 3.53
 *
 * A misstated degree level or GPA is a misrepresentation of the candidate on a real application.
 * An empty field costs a re-fill; these get submitted and believed.
 *
 * Pure functions: npm run test:facts.
 */

export type DegreeLevel = "highschool" | "associate" | "bachelor" | "master" | "doctorate";

/**
 * Classify a degree string into a level. Order matters: "Bachelor of Science" contains neither
 * "associate" nor "master", but "Associate of Science" contains "of science", so the level words
 * are matched explicitly rather than by suffix.
 */
export function degreeLevel(text: string): DegreeLevel | undefined {
  const t = ` ${text.toLowerCase().replace(/[.]/g, "")} `;
  if (/\b(ph ?d|phd|doctor|doctorate|dphil)\b/.test(t)) return "doctorate";
  if (/\b(master|masters|ms|msc|meng|mba|ma)\b/.test(t)) return "master";
  if (/\b(bachelor|bachelors|bs|bsc|ba|beng|undergraduate|undergrad)\b/.test(t)) return "bachelor";
  if (/\b(associate|associates|aa|as|aas)\b/.test(t)) return "associate";
  if (/\b(high school|highschool|secondary|diploma|ged)\b/.test(t)) return "highschool";
  return undefined;
}

/** A GPA band as offered by a dropdown: "3.0-3.5", "3.5 or higher", "Above 3.5", "3.0 to 3.5". */
export interface GpaBand {
  min?: number;
  max?: number;
}

export function parseGpaBand(text: string): GpaBand | undefined {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  const range = t.match(/(\d(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d(?:\.\d+)?)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const orHigher = t.match(/(\d(?:\.\d+)?)\s*(?:\+|or (?:higher|above|more)|and above)/);
  if (orHigher) return { min: Number(orHigher[1]) };
  const above = t.match(/(?:above|over|greater than|at least|>=?)\s*(\d(?:\.\d+)?)/);
  if (above) return { min: Number(above[1]) };
  const below = t.match(/(?:below|under|less than|<=?)\s*(\d(?:\.\d+)?)/);
  if (below) return { max: Number(below[1]) };
  const exact = t.match(/^(\d(?:\.\d+)?)(?:\s*\/\s*\d(?:\.\d+)?)?$/);
  if (exact) return { min: Number(exact[1]), max: Number(exact[1]) };
  return undefined;
}

/** Does the band the form was given actually contain the real GPA? */
export function bandContains(band: GpaBand, gpa: number): boolean {
  // A range is treated as inclusive at both ends. "3.0-3.5" does NOT contain 3.53, which is the
  // whole point: the answer understated a 3.53 and would be read as "below 3.5".
  if (band.min !== undefined && gpa < band.min - 1e-9) return false;
  if (band.max !== undefined && gpa > band.max + 1e-9) return false;
  return true;
}

export interface FactProblem {
  code: "degree-wrong" | "gpa-wrong" | "degree-not-a-degree";
  message: string;
}

export interface ResumeFacts {
  /** e.g. "Bachelor of Science" */
  degree?: string;
  /** e.g. "Information Systems" — a valid answer to "field of study", never to "degree level" */
  fieldOfStudy?: string;
  /** e.g. "3.53" */
  gpa?: string;
}

/** Questions asking which DEGREE (level) — not which subject. */
const DEGREE_QUESTION = /\b(degree|education level|level of education|highest (level of )?education|degree (level|type|program))\b/i;
/** …excluding the ones that ask for the subject, where "Information Systems" is the right answer. */
const SUBJECT_QUESTION = /\b(field of study|discipline|major|subject|concentration|area of study|specialisation|specialization)\b/i;

/**
 * Questions that MENTION a degree but do not ask for its level. Measured against the 50
 * applications already in the queue, where this check produced more false alarms than findings —
 * and a rule that fires on correct answers is worse than the bug it guards, because it blocks
 * applications that were ready.
 *
 * Every pattern here is a real question from a real form, with the answer it was given:
 *   "Do you have, or are you currently pursuing, a college degree?"        -> "Yes"    yes/no
 *   "Degree Type — Undergraduate/Bachelors" (a checkbox group)             -> "Yes"    group option
 *   "Please include your intended graduation year for the degree"          -> "2028"   a year
 *   "For your most recent degree, what is/was your GPA (normalized…)"      -> a GPA, not a level
 * A yes/no or a group option is answered by Yes/No BY DESIGN, so "that is not a degree" is wrong
 * about all of them.
 */
const NOT_A_LEVEL_QUESTION =
  /\b(do you (have|hold)|are you (currently )?(pursuing|enrolled|working)|will you|have you|did you)\b|\b(year|gpa|grade point|when|date)\b|—\s*(undergraduate|bachelor|master|phd|mba)/i;

/**
 * Answers that are a legitimate education LEVEL without naming a degree: US undergraduate class
 * standing. "Junior" is the right answer to "What is your current education level?" and flagging
 * it as "names no degree level" was simply wrong.
 */
const CLASS_STANDING = /^(freshman|sophomore|junior|senior|first|second|third|fourth)[\s-]*(year)?$/i;
const GPA_QUESTION = /\bgpa\b|grade point average|overall result/i;

/**
 * Answers that are not answers. "Yes" was given to "What is your Current Degree Program?" — the
 * agent treated a free-text degree question as a yes/no.
 */
const NON_ANSWER = /^(yes|no|n\/?a|none|true|false)$/i;

export function checkFacts(
  answers: Array<{ label: string; value: string }>,
  facts: ResumeFacts,
): FactProblem[] {
  const problems: FactProblem[] = [];
  const expected = facts.degree ? degreeLevel(facts.degree) : undefined;

  for (const { label, value } of answers) {
    const text = (value ?? "").trim();
    if (!text) continue;

    if (DEGREE_QUESTION.test(label) && !SUBJECT_QUESTION.test(label) && !NOT_A_LEVEL_QUESTION.test(label)) {
      if (CLASS_STANDING.test(text)) continue; // "Junior" is a real education level
      if (NON_ANSWER.test(text)) {
        problems.push({
          code: "degree-not-a-degree",
          message: `"${label.trim().slice(0, 60)}" was answered ${JSON.stringify(text)}, which is not a degree`,
        });
        continue;
      }
      const got = degreeLevel(text);
      if (!got) {
        // Names no degree level at all — this is how "Information Systems" and "Python
        // (Programming Language)" got submitted as degrees.
        problems.push({
          code: "degree-not-a-degree",
          message: `"${label.trim().slice(0, 60)}" was answered ${JSON.stringify(text.slice(0, 40))}, which names no degree level (the resume says ${JSON.stringify(facts.degree ?? "?")})`,
        });
      } else if (expected && got !== expected) {
        problems.push({
          code: "degree-wrong",
          message: `"${label.trim().slice(0, 60)}" says ${JSON.stringify(text.slice(0, 40))} (${got}) but the resume says ${JSON.stringify(facts.degree)} (${expected})`,
        });
      }
    }

    if (GPA_QUESTION.test(label) && facts.gpa) {
      const real = Number(facts.gpa);
      const band = parseGpaBand(text);
      if (!Number.isNaN(real) && band && !bandContains(band, real)) {
        problems.push({
          code: "gpa-wrong",
          message: `"${label.trim().slice(0, 60)}" says ${JSON.stringify(text.slice(0, 30))}, which does not contain the real GPA of ${facts.gpa}`,
        });
      }
    }
  }
  return problems;
}
